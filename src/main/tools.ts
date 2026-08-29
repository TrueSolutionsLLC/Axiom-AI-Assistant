import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { app, clipboard, Notification, shell } from 'electron';
import type { AppearanceColor, AppearanceSettings, CompanionEmotion, InterfaceDensity, MemoryKind, MotionProfile, PermissionInfo, ToolEvent } from '../shared/contracts';
import type { AppStore } from './store';
import { approvalPreview, requiresFreshApproval, toolRisk } from './runtimeCore';
import { clickBrowserText, closeBrowserSession, fillBrowserField, openBrowserPage, pressBrowserKey, readBrowserPage } from './browserControl';
import { platformProfile } from './platform';
import { composeMacMail, controlMacMedia, controlMacWindow, createMacCalendarEvent, createMacNote, createMacReminder, inspectMacApplication, invokeMacControl, listMacWindows, selectMacMenu, setMacField } from './macAutomation';
import { ConnectorClient } from './connectors';
import { MediaService } from './media';
import { showCursorGuide } from './cursorGuide';
import { getSystemTelemetrySnapshot } from './systemTelemetry';
import { searchGoogle } from './googleSearch';
import { getNewsHeadlines } from './newsFeed';
import { GODS_EYE_LAYER_IDS, type GodsEyeLayerId } from './godsEyeView';

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: PermissionInfo;
  execute(args: Record<string, unknown>, store?: AppStore, userMessage?: string): Promise<{ output: string; uiCommand?: ToolEvent['uiCommand'] }>;
}

interface CommandResult { exitCode: number | null; stdout: string; stderr: string; }

function runCommand(command: string, args: string[], timeout = 20_000, environment: NodeJS.ProcessEnv = process.env, workingDirectory?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment, cwd: workingDirectory });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Command timed out after ${Math.round(timeout / 1000)} seconds.`)); }, timeout);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-120_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-50_000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }); });
  });
}

function winAppExecutable(): string {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath();
  return path.join(root, 'node_modules', '@microsoft', 'winappcli', 'bin', 'win-x64', 'winapp.exe');
}

async function runWinApp(args: string[], timeout = 20_000): Promise<CommandResult> {
  if(process.platform!=='win32')throw new Error('Microsoft UI Automation is available only on Windows.');
  const result = await runCommand(winAppExecutable(), args, timeout, { ...process.env, WINAPP_CLI_TELEMETRY_OPTOUT: '1' });
  if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout || `WinApp exited with code ${result.exitCode}`).trim().slice(0, 1000));
  return result;
}

export async function desktopInfrastructureStatus():Promise<{ready:boolean;detail:string;recovery:string}>{
  if(process.platform==='win32'){
    try{await fs.access(winAppExecutable());return{ready:true,detail:'Microsoft WinApp UI Automation executable is installed.',recovery:'No recovery required.'};}
    catch{return{ready:false,detail:'Microsoft WinApp UI Automation executable is missing.',recovery:'Repair or reinstall Axiom to restore the packaged control engine.'};}
  }
  if(process.platform==='darwin')return{ready:true,detail:'macOS Accessibility automation adapter is installed.',recovery:'Grant Accessibility permission in System Settings if application control is blocked.'};
  return{ready:false,detail:'No supported desktop automation adapter is installed for this platform.',recovery:'Install a platform accessibility adapter before enabling computer control.'};
}

const cleanTarget = (value: unknown, max = 140) => {
  const target = String(value ?? '').trim().slice(0, max);
  if (!target || !/^[\w .,:()'&+\-]+$/u.test(target)) throw new Error('The application or UI target contains unsupported characters.');
  return target;
};

function winAppTargetArgs(value: unknown): string[] {
  const target = cleanTarget(value);
  const windowMatch = /^hwnd:(\d+)$/i.exec(target);
  return windowMatch ? ['--window', windowMatch[1]] : ['--app', target];
}

export interface InstalledApp { name: string; path: string; }

// Direct port of the exact/substring/ambiguous matching already proven for
// ringMatchCamera()/homebridgeControl() in connectors.ts — lowercase exact
// match wins over a substring match, and an unresolved tie is a hard error
// rather than a guess at which real, already-installed app the user meant.
export function matchByName<T extends InstalledApp>(candidates: T[], target: string): T {
  const clean = target.trim().toLowerCase();
  if (!clean) throw new Error('An application name is required.');
  const pool = candidates.filter((item) => item.name.toLowerCase() === clean || item.name.toLowerCase().includes(clean));
  const exact = pool.filter((item) => item.name.toLowerCase() === clean);
  const resolved = exact.length === 1 ? exact : pool;
  if (resolved.length === 1) return resolved[0];
  if (resolved.length > 1) throw new Error(`More than one application matches "${target}": ${resolved.slice(0, 8).map((item) => item.name).join(', ')}. Which one did you mean?`);
  throw new Error(`No application found matching "${target}".`);
}

// Recursively walks Desktop and Start Menu shortcut folders (both the
// current user's and the all-users copies) — covers every traditional
// (Win32) installed app. UWP/Microsoft Store apps don't have .lnk files at
// all, which is what listWindowsStartApps() below covers separately.
async function listWindowsShortcuts(): Promise<InstalledApp[]> {
  const directories = [
    path.join(os.homedir(), 'Desktop'),
    'C:\\Users\\Public\\Desktop',
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const found: InstalledApp[] = [];
  const walk = async (directory: string, depth = 0): Promise<void> => {
    if (depth > 4) return;
    let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && /\.lnk$/i.test(entry.name)) found.push({ name: entry.name.replace(/\.lnk$/i, ''), path: full });
    }
  };
  for (const directory of directories) await walk(directory);
  // A live user hit this exact case: Chrome's installer left a "Google
  // Chrome.lnk" in both the shared Public Desktop and the all-users Start
  // Menu — two of these four directories, not a shortcut-vs-Start-Apps
  // collision (that's deduplicated separately, below). Two shortcuts with
  // the identical display name can never be told apart in the "which one
  // did you mean?" error either, since it only shows the name — so this
  // is never a real ambiguity to ask about, just the same app found twice.
  // First occurrence wins, in the order `directories` is listed above:
  // the user's own Desktop takes priority over the shared/system copies.
  const seenNames = new Set<string>();
  return found.filter((item) => {
    const key = item.name.toLowerCase();
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
}

// UWP/Microsoft Store apps (Calculator on newer Windows builds, Xbox,
// Photos, etc.) have no .lnk shortcut file at all — Get-StartApps is the
// standard built-in way to enumerate them (and every other Start Menu
// entry) by display name + AppID. A "shell:AppsFolder\<AppID>" path is
// returned instead of a real file path — launched differently below,
// since it isn't something shell.openPath() can open directly.
async function listWindowsStartApps(): Promise<InstalledApp[]> {
  try {
    const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | ConvertTo-Json -Compress'], 15_000);
    if (result.exitCode !== 0 || !result.stdout.trim()) return [];
    const parsed: unknown = JSON.parse(result.stdout.trim());
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((item): item is { Name: string; AppID: string } => Boolean(item) && typeof (item as { Name?: unknown }).Name === 'string' && typeof (item as { AppID?: unknown }).AppID === 'string')
      .map((item) => ({ name: item.Name, path: `shell:AppsFolder\\${item.AppID}` }));
  } catch { return []; }
}

async function listWindowsApps(): Promise<InstalledApp[]> {
  const [shortcuts, startApps] = await Promise.all([listWindowsShortcuts(), listWindowsStartApps()]);
  // Get-StartApps lists every Start Menu entry, not just UWP/Store apps —
  // without deduplicating, a traditional app with a .lnk shortcut would
  // appear twice under the identical name, turning an unambiguous request
  // ("open Notepad") into a spurious "which one did you mean?" between two
  // representations of the exact same app.
  const seen = new Set(shortcuts.map((item) => item.name.toLowerCase()));
  const newStartApps = startApps.filter((item) => !seen.has(item.name.toLowerCase()));
  return [...shortcuts, ...newStartApps];
}

async function listMacApplications(): Promise<InstalledApp[]> {
  const directories = ['/Applications', path.join(os.homedir(), 'Applications'), '/System/Applications'];
  const found: InstalledApp[] = [];
  for (const directory of directories) {
    let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory() && /\.app$/i.test(entry.name)) found.push({ name: entry.name.replace(/\.app$/i, ''), path: path.join(directory, entry.name) });
  }
  return found;
}

async function codingRoot(store?: AppStore): Promise<string> {
  if (!store) throw new Error('Coding workspace is unavailable.');
  const root = path.resolve(store.codingWorkspace());
  const allowed = userRoots.some((candidate) => root === candidate || root.startsWith(`${candidate}${path.sep}`));
  if (!allowed) throw new Error('Coding workspace must remain inside Desktop, Documents, or Downloads.');
  await fs.mkdir(root, { recursive: true });
  return root;
}

async function codingPath(store: AppStore | undefined, relativeValue: unknown): Promise<{ root: string; target: string; relative: string }> {
  const root = await codingRoot(store);
  const requested = String(relativeValue ?? '').replaceAll('\\', '/').replace(/^\/+/, '').trim();
  if (!requested || requested.includes('\0')) throw new Error('Use a safe project-relative path outside Axiom checkpoint storage.');
  const target = path.resolve(root, requested);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Project path escaped the configured coding workspace.');
  // Compare the resolved target, not the requested string: "./.axiom/…" and
  // ".AXIOM/…" both reach checkpoint storage on a case-insensitive filesystem.
  const reserved = path.join(root, '.axiom').toLowerCase();
  const resolvedLower = target.toLowerCase();
  if (resolvedLower === reserved || resolvedLower.startsWith(`${reserved}${path.sep}`)) throw new Error('Use a safe project-relative path outside Axiom checkpoint storage.');
  return { root, target, relative: path.relative(root, target).replaceAll('\\', '/') };
}

async function createFileCheckpoint(root: string, target: string, relative: string): Promise<string> {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const checkpoint = path.join(root, '.axiom', 'checkpoints', id);
  await fs.mkdir(checkpoint, { recursive: true });
  let existed = false;
  // Only ENOENT means "genuinely doesn't exist yet" — safe to record
  // existed:false. Any other stat failure (permission, transient I/O) used
  // to be swallowed identically, which meant a later restore_project_
  // checkpoint on that checkpoint would read existed:false and delete the
  // target (tools.ts's restore branch), even though a real file was there —
  // a benign stat hiccup silently turning a future restore into a deletion.
  try { existed = (await fs.stat(target)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
  if (existed) { const backup = path.join(checkpoint, 'file'); await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.copyFile(target, backup); }
  await fs.writeFile(path.join(checkpoint, 'manifest.json'), JSON.stringify({ relative, existed, createdAt: new Date().toISOString() }, null, 2), 'utf8');
  return id;
}

const registry: ToolDefinition[] = [
  {
    name: 'web_search',
    // Real Google results, read out of an actual rendered page (see
    // googleSearch.ts) — replacing the provider-hosted "web search" tool
    // type entirely. That hosted approach proved undebuggable in
    // production: OpenAI/Anthropic/Gemini could report a search call as
    // successful while it silently returned nothing, and there was no way
    // to see inside the black box to find out why. This tool goes through
    // the exact same executeTool() path as every other Axiom tool, so a
    // real failure shows up as a real thrown error and a real 'failed'
    // ToolEvent — never a plausible-sounding non-answer.
    description: 'Search the live web for current information. Use for news, weather, prices, verification of a claim, or anything that changes over time. Returns real titles, URLs, and snippets — cite them, do not answer from memory alone.',
    parameters: { type:'object', properties:{ query:{type:'string'} }, required:['query'], additionalProperties:false },
    permission: { id:'web-search', label:'Searched live web sources', risk:'read', enabled:true },
    async execute(args) {
      const results=await searchGoogle(String(args.query||''));
      return { output: JSON.stringify({ query: String(args.query||''), results }) };
    },
  },
  {
    name: 'get_news_headlines',
    // A separate, dedicated tool from web_search: a live user asked for
    // "top headlines" and "New York Post headlines" through general web
    // search and got category/homepage links back, not real article text —
    // a search index isn't built for "what's the news right now." This
    // hits a real news feed instead, returning real per-article titles,
    // sources, and links.
    description: 'Get real, current news headlines — for "what\'s the news", "top headlines", "breaking news", or headlines from one specific outlet. Leave query empty for general top world headlines. To scope to one outlet, use query "site:<domain>" (e.g. "site:nypost.com" for the New York Post, "site:reuters.com" for Reuters) — do not just pass the outlet\'s name. Returns real titles, sources, and links; cite them.',
    parameters: { type:'object', properties:{ query:{type:'string'} }, required:['query'], additionalProperties:false },
    permission: { id:'web-search', label:'Read live news headlines', risk:'read', enabled:true },
    async execute(args) {
      const headlines=await getNewsHeadlines(String(args.query||'').trim()||undefined);
      return { output: JSON.stringify({ headlines }) };
    },
  },
  {
    name: 'get_local_time',
    description: 'Read the current local date, time, and time zone from this computer.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    permission: { id: 'read-time', label: 'Read local time', risk: 'read', enabled: true },
    async execute() {
      const now = new Date();
      return { output: JSON.stringify({ iso: now.toISOString(), local: now.toString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) };
    },
  },
  {
    name: 'remember_fact',
    description: 'Save a durable fact, preference, project detail, or instruction to local memory. Call this when the user explicitly asks Axiom to remember something, AND proactively whenever the user reveals something durable and non-obvious in passing — where they live, a strong standing preference, a recurring project detail — even without being asked. Do not save routine conversational content or one-off requests; when unsure whether it will matter later, skip it. The result may come back with saved:false and a duplicate record (nothing new needed) or with a possibleConflict pointing at an existing memory that looks like it might be about the same thing but says something different — when that happens, tell the user what the old memory says, ask which one is right, and use correct_memory to reconcile it. Never silently ignore a possibleConflict.',
    parameters: { type:'object', properties:{ text:{type:'string'},kind:{type:'string',enum:['fact','preference','person','project','decision','instruction']} }, required:['text','kind'], additionalProperties:false },
    permission: { id:'memory-write', label:'Saved to local memory', risk:'write', enabled:true },
    async execute(args, store, userMessage) {
      if(!store)throw new Error('Memory store unavailable.');
      const text=String(args.text||'').trim(),kind=String(args.kind||'fact') as MemoryKind;
      // Provenance is derived, not passed by the model: an explicit "remember
      // this" from the user is recorded at full confidence; anything saved
      // on the model's own initiative from a passing remark is tagged
      // assistant-inferred at a lower confidence so it's visibly distinct in
      // the Memory settings page and can be reviewed or corrected more
      // readily than something the user asked for directly.
      const explicit=/\b(remember|note|save|don'?t forget|keep in mind)\b/i.test(userMessage||'');
      const similar=await store.findSimilarActiveMemory(kind,text);
      if(similar&&similar.similarity>=0.95)return{output:JSON.stringify({saved:false,duplicate:true,item:similar.item})};
      const item=store.addMemory(text,{kind,origin:explicit?'user-explicit':'assistant-inferred',confidence:explicit?1:0.75});
      const possibleConflict=similar&&similar.similarity>=0.7?{id:similar.item.id,text:similar.item.text}:undefined;
      return{output:JSON.stringify({saved:true,item,...(possibleConflict?{possibleConflict}:{})})};
    },
  },
  {
    name: 'recall_memory',
    description: 'Search local durable memories for information relevant to the user request.',
    parameters: { type:'object', properties:{ query:{type:'string'} }, required:['query'], additionalProperties:false },
    permission: { id:'memory-read', label:'Searched local memory', risk:'read', enabled:true },
    async execute(args, store) { if(!store)throw new Error('Memory store unavailable.');return{output:JSON.stringify({matches:await store.searchMemories(String(args.query||''))})}; },
  },
  {
    name: 'correct_memory',
    description: 'Correct an existing memory by superseding it with a user-provided replacement. Preserve the old record as superseded provenance. Use only when the user explicitly corrects Axiom.',
    parameters: { type:'object', properties:{ id:{type:'string'},text:{type:'string'},kind:{type:'string',enum:['fact','preference','person','project','decision','instruction']} }, required:['id','text','kind'], additionalProperties:false },
    permission: { id:'memory-write', label:'Corrected a local memory', risk:'write', enabled:true },
    async execute(args, store, userMessage) { if(!store)throw new Error('Memory store unavailable.');if(!/\b(correct|update|change|wrong|actually)\b/i.test(userMessage||''))throw new Error('Memory correction requires an explicit correction from the user.');return{output:JSON.stringify({corrected:true,item:store.correctMemory(String(args.id||''),String(args.text||''),String(args.kind||'fact') as MemoryKind)})}; },
  },
  {
    name: 'forget_memory',
    description: 'Permanently remove one local memory by ID when the user explicitly asks Axiom to forget or delete that memory.',
    parameters: { type:'object', properties:{ id:{type:'string'} }, required:['id'], additionalProperties:false },
    permission: { id:'memory-write', label:'Forgot a local memory', risk:'sensitive', enabled:true },
    async execute(args, store, userMessage) { if(!store)throw new Error('Memory store unavailable.');if(!/\b(forget|delete|remove)\b/i.test(userMessage||''))throw new Error('Forgetting memory requires an explicit forget, delete, or remove request.');if(!store.forgetMemory(String(args.id||'')))throw new Error('Memory not found.');return{output:JSON.stringify({forgotten:true,id:String(args.id||'')})}; },
  },
  {
    name: 'record_self_correction',
    description: "Record a lesson about Axiom's own past mistake — distinct from remember_fact, which stores facts about the user. Use when Axiom got something wrong (a bad assumption, a refused request that should have worked, an incorrect claim) and the user corrected it, so the same pattern is recognized next time instead of repeating.",
    parameters: { type:'object', properties:{ pattern:{type:'string',description:'The situation this applies to, so it can be matched against future requests.'},mistake:{type:'string'},fix:{type:'string'} }, required:['pattern','mistake','fix'], additionalProperties:false },
    permission: { id:'self-correction-write', label:'Recorded a self-correction', risk:'write', enabled:true },
    async execute(args, store) { if(!store)throw new Error('Store unavailable.');return{output:JSON.stringify({recorded:true,corrections:store.recordSelfCorrection(String(args.pattern||''),String(args.mistake||''),String(args.fix||''))})}; },
  },
  {
    name: 'create_goal',
    description: 'Create a durable goal or to-do item when the user asks to track work.',
    parameters: { type:'object', properties:{ title:{type:'string'} }, required:['title'], additionalProperties:false },
    permission: { id:'goals-write', label:'Created a goal', risk:'write', enabled:true },
    async execute(args, store) { if(!store)throw new Error('Goal store unavailable.');return{output:JSON.stringify({created:true,goal:store.addGoal(String(args.title||''))})}; },
  },
  {
    name: 'list_goals',
    description: 'List the user’s locally stored active and completed goals.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'goals-read', label:'Listed goals', risk:'read', enabled:true },
    async execute(_args, store) { if(!store)throw new Error('Goal store unavailable.');return{output:JSON.stringify({goals:store.goals()})}; },
  },
  {
    name: 'complete_goal',
    description: 'Mark a goal completed by its ID after the user says it is finished.',
    parameters: { type:'object', properties:{ id:{type:'string'} }, required:['id'], additionalProperties:false },
    permission: { id:'goals-write', label:'Completed a goal', risk:'write', enabled:true },
    async execute(args, store) { if(!store)throw new Error('Goal store unavailable.');const goal=store.completeGoal(String(args.id||''));if(!goal)throw new Error('Goal not found.');return{output:JSON.stringify({completed:true,goal})}; },
  },
  {
    name:'add_todo',
    description:'Add an item to the durable cross-device Axiom to-do list.',
    parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
    permission:{id:'todos-write',label:'Added a to-do item',risk:'write',enabled:true},
    async execute(args,store){if(!store)throw new Error('To-do store unavailable.');return{output:JSON.stringify({added:true,todo:store.addTodo(String(args.text||''))})};},
  },
  {
    name:'list_todos',
    description:'List the durable Axiom to-do items and completion status.',
    parameters:{type:'object',properties:{},additionalProperties:false},
    permission:{id:'todos-read',label:'Listed to-do items',risk:'read',enabled:true},
    async execute(_args,store){if(!store)throw new Error('To-do store unavailable.');return{output:JSON.stringify({todos:store.todos()})};},
  },
  {
    name:'set_todo_status',
    description:'Mark one to-do item open or completed using its ID.',
    parameters:{type:'object',properties:{id:{type:'string'},status:{type:'string',enum:['open','completed']}},required:['id','status'],additionalProperties:false},
    permission:{id:'todos-write',label:'Updated a to-do item',risk:'write',enabled:true},
    async execute(args,store){if(!store)throw new Error('To-do store unavailable.');return{output:JSON.stringify({updated:true,todos:store.setTodoStatus(String(args.id||''),args.status==='completed'?'completed':'open')})};},
  },
  {
    name: 'save_skill',
    description: 'Create or update a durable reusable Axiom skill from a workflow the user wants saved. Store clear executable instructions, not vague summaries.',
    parameters: { type:'object', properties:{ name:{type:'string'},description:{type:'string'},instructions:{type:'string'} }, required:['name','description','instructions'], additionalProperties:false },
    permission: { id:'skills-write', label:'Saved a reusable skill', risk:'write', enabled:true },
    async execute(args,store) { if(!store)throw new Error('Skill store unavailable.');return{output:JSON.stringify({saved:true,skill:store.saveSkill(String(args.name||''),String(args.description||''),String(args.instructions||''))})}; },
  },
  {
    name: 'list_skills',
    description: 'List durable reusable Axiom skills and their run history.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'skills-read', label:'Listed reusable skills', risk:'read', enabled:true },
    async execute(_args,store) { if(!store)throw new Error('Skill store unavailable.');return{output:JSON.stringify({skills:store.skills()})}; },
  },
  {
    name: 'run_skill',
    description: 'Load one named reusable skill. After loading it, follow its instructions in this same turn using the available tools and verify every result.',
    parameters: { type:'object', properties:{ name:{type:'string'} }, required:['name'], additionalProperties:false },
    permission: { id:'skills-read', label:'Loaded a reusable skill', risk:'read', enabled:true },
    async execute(args,store) { if(!store)throw new Error('Skill store unavailable.');const skill=store.runSkill(String(args.name||''));return{output:JSON.stringify({loaded:true,skill,instruction:'Execute these skill instructions now. Use normal permissions and verification; the skill does not grant additional authority.'})}; },
  },
  {
    name: 'remove_skill',
    description: 'Remove one named reusable skill only when the user explicitly asks to delete or remove it.',
    parameters: { type:'object', properties:{ name:{type:'string'} }, required:['name'], additionalProperties:false },
    permission: { id:'skills-write', label:'Removed a reusable skill', risk:'sensitive', enabled:true },
    async execute(args,store,userMessage) { if(!store)throw new Error('Skill store unavailable.');if(!/\b(delete|remove)\b/i.test(userMessage||''))throw new Error('Removing a skill requires an explicit delete or remove request.');if(!store.removeSkill(String(args.name||'')))throw new Error('Skill not found.');return{output:JSON.stringify({removed:true,name:String(args.name||'')})}; },
  },
  {
    name: 'create_agent',
    description: 'Create a durable named specialist agent with a role, operating instructions, and optional interval or daily autonomous schedule. Agents inherit Axiom permissions and never gain extra authority.',
    parameters: { type:'object', properties:{ name:{type:'string'},role:{type:'string'},instructions:{type:'string'},schedule:{type:'object',properties:{kind:{type:'string',enum:['manual','interval','daily']},intervalMinutes:{type:'number'},dailyTime:{type:'string'}},required:['kind'],additionalProperties:false},color:{type:'string',enum:['teal','green','blue','violet','amber','red','white']} }, required:['name','role','instructions'], additionalProperties:false },
    permission: { id:'agents-write', label:'Created a specialist agent', risk:'write', enabled:true },
    async execute(args,store) { if(!store)throw new Error('Agent store unavailable.');const schedule=args.schedule&&typeof args.schedule==='object'?args.schedule as import('../shared/contracts').ScheduleSpec:undefined;return{output:JSON.stringify({created:true,agent:store.saveAgent(String(args.name||''),String(args.role||''),String(args.instructions||''),{schedule,color:typeof args.color==='string'?args.color as import('../shared/contracts').AppearanceColor:undefined})})}; },
  },
  {
    name: 'list_agents',
    description: 'List Axiom specialist agents, roles, status, and run history.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'agents-read', label:'Listed specialist agents', risk:'read', enabled:true },
    async execute(_args,store) { if(!store)throw new Error('Agent store unavailable.');return{output:JSON.stringify({agents:store.agents()})}; },
  },
  {
    name: 'run_agent',
    description: 'Activate one named specialist agent for the current request. Adopt its role and instructions, complete the work with available tools, and verify results in this turn.',
    parameters: { type:'object', properties:{ name:{type:'string'},request:{type:'string'} }, required:['name','request'], additionalProperties:false },
    permission: { id:'agents-run', label:'Activated a specialist agent', risk:'read', enabled:true },
    async execute(args,store) { if(!store)throw new Error('Agent store unavailable.');const agent=store.runAgent(String(args.name||''));return{output:JSON.stringify({activated:true,agent,request:String(args.request||'').slice(0,5000),instruction:'Operate as this specialist for the current request. All normal permission checks still apply. Execute and verify the work now.'})}; },
  },
  {
    name: 'remove_agent',
    description: 'Remove one named specialist agent only when the user explicitly asks to delete or remove it.',
    parameters: { type:'object', properties:{ name:{type:'string'} }, required:['name'], additionalProperties:false },
    permission: { id:'agents-write', label:'Removed a specialist agent', risk:'sensitive', enabled:true },
    async execute(args,store,userMessage) { if(!store)throw new Error('Agent store unavailable.');if(!/\b(delete|remove)\b/i.test(userMessage||''))throw new Error('Removing an agent requires an explicit delete or remove request.');if(!store.removeAgent(String(args.name||'')))throw new Error('Agent not found.');return{output:JSON.stringify({removed:true,name:String(args.name||'')})}; },
  },
  {
    name:'create_visual_monitor',
    description:'Create a user-approved persistent screen or camera monitor that checks a visible condition at an interval, stops at the requested duration, and alerts only when evidence clearly triggers it.',
    parameters:{type:'object',properties:{title:{type:'string'},instruction:{type:'string'},source:{type:'string',enum:['screen','camera']},intervalSeconds:{type:'number'},durationMinutes:{type:'number'}},required:['title','instruction','source'],additionalProperties:false},
    permission:{id:'visual-monitor',label:'Created a visual monitor',risk:'sensitive',enabled:true},
    async execute(args,store){if(!store)throw new Error('Monitor store unavailable.');return{output:JSON.stringify({created:true,monitor:store.addMonitor({title:String(args.title||''),instruction:String(args.instruction||''),source:args.source==='camera'?'camera':'screen',intervalSeconds:Number(args.intervalSeconds)||60,durationMinutes:Number(args.durationMinutes)||60})})};},
  },
  {
    name:'list_visual_monitors',
    description:'List active and completed screen or camera monitors and their last verified observation.',
    parameters:{type:'object',properties:{},additionalProperties:false},
    permission:{id:'visual-monitor',label:'Listed visual monitors',risk:'read',enabled:true},
    async execute(_args,store){if(!store)throw new Error('Monitor store unavailable.');return{output:JSON.stringify({monitors:store.monitors()})};},
  },
  {
    name: 'create_commitment',
    description: 'Record a durable promise Axiom has accepted, such as following up, monitoring something, or completing work later. Use only for an explicit user request or a promise Axiom has clearly made.',
    parameters: { type:'object', properties:{ title:{type:'string'}, dueAt:{type:'string',description:'Optional ISO-8601 due date and time.'} }, required:['title'], additionalProperties:false },
    permission: { id:'commitments-write', label:'Recorded a durable commitment', risk:'write', enabled:true },
    async execute(args, store) { if(!store)throw new Error('Runtime store unavailable.');const item=store.addCommitment(String(args.title||''),typeof args.dueAt==='string'?args.dueAt:undefined);return{output:JSON.stringify({recorded:true,commitment:item})}; },
  },
  {
    name: 'list_commitments',
    description: 'List Axiom’s open, fulfilled, and cancelled commitments so promises are never silently forgotten.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'commitments-read', label:'Listed commitment ledger', risk:'read', enabled:true },
    async execute(_args, store) { if(!store)throw new Error('Runtime store unavailable.');return{output:JSON.stringify({commitments:store.commitments()})}; },
  },
  {
    name: 'resolve_commitment',
    description: 'Mark a commitment fulfilled or cancelled after the outcome is known.',
    parameters: { type:'object', properties:{ id:{type:'string'}, status:{type:'string',enum:['fulfilled','cancelled']} }, required:['id','status'], additionalProperties:false },
    permission: { id:'commitments-write', label:'Updated commitment ledger', risk:'write', enabled:true },
    async execute(args, store) { if(!store)throw new Error('Runtime store unavailable.');const status=args.status==='cancelled'?'cancelled':'fulfilled';const item=store.resolveCommitment(String(args.id||''),status);if(!item)throw new Error('Commitment not found.');return{output:JSON.stringify({updated:true,commitment:item})}; },
  },
  {
    name: 'list_directory',
    description: 'List files and folders inside the user Desktop, Documents, or Downloads folders.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute folder path.' } }, required: ['path'], additionalProperties: false },
    permission: { id: 'files-read', label: 'Listed a user folder', risk: 'read', enabled: true },
    async execute(args) {
      const target = allowedPath(String(args.path || ''));
      const entries = (await fs.readdir(target, { withFileTypes: true })).slice(0, 250).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : 'other' }));
      return { output: JSON.stringify({ path: target, entries, truncated: entries.length === 250 }) };
    },
  },
  {
    name: 'read_text_file',
    description: 'Read a UTF-8 text file inside Desktop, Documents, or Downloads. Use only for files the user asks about.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    permission: { id: 'files-read', label: 'Read a user text file', risk: 'read', enabled: true },
    async execute(args) {
      const target = allowedPath(String(args.path || '')); const stat = await fs.stat(target);
      if (stat.size > 700_000) throw new Error('Text file exceeds the 700 KB safety limit.');
      return { output: JSON.stringify({ path: target, content: await fs.readFile(target, 'utf8') }) };
    },
  },
  {
    name: 'path_exists',
    description: 'Check whether a file or folder exists inside Desktop, Documents, or Downloads.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    permission: { id: 'files-read', label: 'Checked a path', risk: 'read', enabled: true },
    async execute(args) { const target = allowedPath(String(args.path || '')); try { const stat = await fs.stat(target); return { output: JSON.stringify({ exists: true, type: stat.isDirectory() ? 'folder' : 'file', path: target }) }; } catch { return { output: JSON.stringify({ exists: false, path: target }) }; } },
  },
  {
    name: 'create_directory',
    description: 'Create a folder inside Desktop, Documents, or Downloads only when the user explicitly requests it.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    permission: { id: 'files-write', label: 'Created a user folder', risk: 'write', enabled: true },
    async execute(args) { const target = allowedPath(String(args.path || '')); await fs.mkdir(target, { recursive: true }); const verified = (await fs.stat(target)).isDirectory(); return { output: JSON.stringify({ created: verified, path: target }) }; },
  },
  {
    name: 'write_text_file',
    description: 'Create or replace a UTF-8 text file inside Desktop, Documents, or Downloads only when the user explicitly asks. Never write executable or script files.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
    permission: { id: 'files-write', label: 'Wrote and verified a text file', risk: 'write', enabled: true },
    async execute(args) {
      const target = allowedPath(String(args.path || '')); const extension = path.extname(target).toLowerCase();
      if (!['.txt','.md','.json','.csv','.log','.html','.css','.js','.ts','.py'].includes(extension)) throw new Error('That file type is not enabled for text writing.');
      const content = String(args.content ?? ''); if (Buffer.byteLength(content, 'utf8') > 700_000) throw new Error('Content exceeds the 700 KB safety limit.');
      await fs.mkdir(path.dirname(target), { recursive: true }); const temp = `${target}.axiom-tmp`; await fs.writeFile(temp, content, 'utf8'); await fs.rename(temp, target);
      const verified = (await fs.readFile(target, 'utf8')) === content; return { output: JSON.stringify({ written: verified, path: target, bytes: Buffer.byteLength(content, 'utf8') }) };
    },
  },
  {
    name: 'open_application',
    description: 'Open any installed application on the current computer by name when the user explicitly asks — a common productivity/system tool, or any other application actually installed on this machine, including UWP/Microsoft Store apps. Matched against real Desktop shortcuts, Start Menu shortcuts, and Get-StartApps on Windows, or /Applications on macOS — not a fixed list.',
    parameters: { type: 'object', properties: { application: { type: 'string' } }, required: ['application'], additionalProperties: false },
    permission: { id: 'apps-open', label: 'Opened an application', risk: 'write', enabled: true },
    async execute(args) {
      const raw = String(args.application || '').trim(); if (!raw) throw new Error('An application name is required.');
      // A handful of well-known system tools stay a fast, zero-scan path;
      // normalized so "Command Prompt"/"command prompt"/"command_prompt"
      // all still hit it the same way the old closed enum's keys did.
      const key = raw.toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
      if (key === 'browser') { await shell.openExternal('https://www.bing.com'); return { output: JSON.stringify({ opened: true, application: raw, verified: true }) }; }
      if (process.platform === 'darwin') {
        const applications: Record<string, string> = { notepad: 'TextEdit', calculator: 'Calculator', paint: 'Preview', explorer: 'Finder', settings: 'System Settings', terminal: 'Terminal', task_manager: 'Activity Monitor', snipping_tool: 'Screenshot', word: 'Microsoft Word', excel: 'Microsoft Excel', outlook: 'Microsoft Outlook', notes: 'Notes', safari: 'Safari', xcode: 'Xcode', mail: 'Mail', calendar: 'Calendar', music: 'Music', photos: 'Photos', preview: 'Preview', finder: 'Finder', system_settings: 'System Settings', activity_monitor: 'Activity Monitor' };
        const fastTarget = applications[key];
        if (fastTarget) { const result = await runCommand('/usr/bin/open', ['-a', fastTarget]); if (result.exitCode !== 0) throw new Error(result.stderr || `Could not open ${fastTarget}.`); return { output: JSON.stringify({ opened: true, application: raw, target: fastTarget, platform: 'macOS' }) }; }
        // Not a well-known fast-path app — search real installed
        // applications instead of failing outright.
        const match = matchByName(await listMacApplications(), raw);
        const result = await runCommand('/usr/bin/open', ['-a', match.path]); if (result.exitCode !== 0) throw new Error(result.stderr || `Could not open ${match.name}.`);
        return { output: JSON.stringify({ opened: true, application: raw, target: match.name, path: match.path, platform: 'macOS' }) };
      }
      const commands: Record<string, { command: string; args: string[] }> = {
        notepad:{command:'notepad.exe',args:[]}, calculator:{command:'calc.exe',args:[]}, paint:{command:'mspaint.exe',args:[]}, explorer:{command:'explorer.exe',args:[]}, settings:{command:'explorer.exe',args:['ms-settings:']},
        terminal:{command:'wt.exe',args:[]}, powershell:{command:'powershell.exe',args:[]}, command_prompt:{command:'cmd.exe',args:[]}, task_manager:{command:'taskmgr.exe',args:[]}, snipping_tool:{command:'SnippingTool.exe',args:[]}, control_panel:{command:'control.exe',args:[]},
        word:{command:'cmd.exe',args:['/c','start','','winword']}, excel:{command:'cmd.exe',args:['/c','start','','excel']}, outlook:{command:'cmd.exe',args:['/c','start','','outlook']},
      };
      const selected = commands[key];
      if (selected) { const child = spawn(selected.command, selected.args, { detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); return { output: JSON.stringify({ opened: true, application: raw, processId: child.pid ?? null }) }; }
      // Not a well-known system tool — search every real installed app:
      // Desktop/Start Menu shortcuts for traditional software, plus
      // Get-StartApps for UWP/Store apps that have no shortcut file at all.
      const match = matchByName(await listWindowsApps(), raw);
      if (match.path.toLowerCase().startsWith('shell:')) {
        // UWP/Store apps launch via explorer.exe, not shell.openPath — a
        // "shell:AppsFolder\..." path isn't a real file on disk.
        const child = spawn('explorer.exe', [match.path], { detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
        return { output: JSON.stringify({ opened: true, application: raw, target: match.name, path: match.path }) };
      }
      // shell.openPath resolves to an empty string on success and a
      // non-empty error message on failure — it never rejects.
      const openError = await shell.openPath(match.path);
      if (openError) throw new Error(openError);
      return { output: JSON.stringify({ opened: true, application: raw, target: match.name, path: match.path }) };
    },
  },
  {
    name: 'open_web_address',
    description: 'Open an explicit HTTPS web address in the user\'s default browser. Never invent or silently alter the destination.',
    parameters: { type:'object', properties:{ url:{type:'string'} }, required:['url'], additionalProperties:false },
    permission: { id:'browser-control', label:'Opened a web address', risk:'write', enabled:true },
    async execute(args) {
      const url = new URL(String(args.url || ''));
      if (url.protocol !== 'https:' || !url.hostname) throw new Error('Only explicit HTTPS web addresses are enabled.');
      await shell.openExternal(url.toString());
      return { output: JSON.stringify({ opened:true, url:url.toString() }) };
    },
  },
  {
    name: 'browser_open',
    description: 'Open an explicit HTTPS page in Axiom\'s persistent controlled browser. The user can see the same page and retained site session.',
    parameters: { type:'object', properties:{ url:{type:'string'} }, required:['url'], additionalProperties:false },
    permission: { id:'browser-control', label:'Opened Axiom Browser', risk:'write', enabled:true },
    async execute(args) { return { output:JSON.stringify(await openBrowserPage(args.url)) }; },
  },
  {
    name: 'browser_read',
    description: 'Read the visible text and labeled interactive controls from the current Axiom Browser page so actions are grounded in the live page.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'browser-read', label:'Read the current browser page', risk:'read', enabled:true },
    async execute() { return { output:JSON.stringify(await readBrowserPage()) }; },
  },
  {
    name: 'browser_click',
    description: 'Click a visible link or button in Axiom Browser by its exact human-readable label. Read the page first and never guess a control.',
    parameters: { type:'object', properties:{ text:{type:'string'} }, required:['text'], additionalProperties:false },
    permission: { id:'browser-control', label:'Clicked a browser control', risk:'sensitive', enabled:true },
    async execute(args) { return { output:JSON.stringify(await clickBrowserText(args.text)) }; },
  },
  {
    name: 'browser_fill',
    description: 'Fill a visible browser text field by its label, placeholder, or accessible name. This does not submit the form.',
    parameters: { type:'object', properties:{ field:{type:'string'},value:{type:'string'} }, required:['field','value'], additionalProperties:false },
    permission: { id:'browser-control', label:'Filled a browser field', risk:'sensitive', enabled:true },
    async execute(args,_store,userMessage) {
      // Parity with set_application_field: Axiom does not type secrets, and a web
      // form is a more likely place to be asked to than a desktop control.
      if(/\b(password|passcode|pin|one[- ]?time code|otp|2fa|api key|secret|credit card|card number|cvv|cvc|social security|ssn|routing number|account number)\b/i.test(`${String(args.field||'')} ${userMessage||''}`))
        throw new Error('Axiom will not enter credentials, authentication codes, or financial details into a web form. Type it yourself in Axiom Browser.');
      return { output:JSON.stringify(await fillBrowserField(args.field,args.value)) };
    },
  },
  {
    name: 'browser_press',
    description: 'Press one navigation key in Axiom Browser. Enter may submit a focused form and therefore requires a one-time approval.',
    parameters: { type:'object', properties:{ key:{type:'string',enum:['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End']} }, required:['key'], additionalProperties:false },
    permission: { id:'browser-control', label:'Pressed a browser key', risk:'sensitive', enabled:true },
    async execute(args) { return { output:JSON.stringify(await pressBrowserKey(args.key)) }; },
  },
  {
    name: 'browser_close',
    description: 'Close the visible Axiom Browser session when the user explicitly asks.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'browser-control', label:'Closed Axiom Browser', risk:'sensitive', enabled:true },
    async execute() { return { output:JSON.stringify(closeBrowserSession()) }; },
  },
  {
    name:'gmail_check',description:'Read a concise list of recent Gmail messages from the connected Google account. Supports Gmail search syntax.',parameters:{type:'object',properties:{query:{type:'string'},maxResults:{type:'number'}},additionalProperties:false},permission:{id:'gmail-read',label:'Read connected Gmail messages',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).gmailList(String(args.query||''),Number(args.maxResults)||10))};},
  },
  {
    name:'gmail_archive',description:'Archive one Gmail message by its exact message ID after the user asks.',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},permission:{id:'gmail-write',label:'Archived a Gmail message',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).gmailModify(String(args.id||''),['INBOX']))};},
  },
  {
    name:'gmail_send',description:'Send an email through the connected Gmail account. Always requires a fresh exact approval before transmission.',parameters:{type:'object',properties:{to:{type:'string'},subject:{type:'string'},body:{type:'string'}},required:['to','subject','body'],additionalProperties:false},permission:{id:'gmail-send',label:'Sent a Gmail message',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).gmailSend(String(args.to||''),String(args.subject||''),String(args.body||'')))};},
  },
  {
    name:'calendar_list_events',description:'List upcoming events from the connected primary Google Calendar.',parameters:{type:'object',properties:{timeMin:{type:'string'},maxResults:{type:'number'}},additionalProperties:false},permission:{id:'calendar-read',label:'Read connected calendar events',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).calendarEvents(typeof args.timeMin==='string'?args.timeMin:undefined,Number(args.maxResults)||20))};},
  },
  {
    name:'calendar_create_event',description:'Create an event on the connected primary Google Calendar. Requires fresh approval before the external change.',parameters:{type:'object',properties:{summary:{type:'string'},start:{type:'string'},end:{type:'string'},description:{type:'string'}},required:['summary','start','end'],additionalProperties:false},permission:{id:'calendar-write',label:'Created a calendar event',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).calendarCreate(String(args.summary||''),String(args.start||''),String(args.end||''),String(args.description||'')))};},
  },
  {
    name:'shopify_sales',description:'Read recent order and sales data from the connected Shopify store using the Admin GraphQL API.',parameters:{type:'object',properties:{days:{type:'number'}},additionalProperties:false},permission:{id:'shopify-read',label:'Read Shopify sales data',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).shopifySales(Number(args.days)||7))};},
  },
  {
    name:'meta_insights',description:'Read advertising performance insights from the connected Meta ad account.',parameters:{type:'object',properties:{datePreset:{type:'string',enum:['today','yesterday','last_7d','last_14d','last_30d','this_month','last_month']}},additionalProperties:false},permission:{id:'meta-read',label:'Read Meta performance insights',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).metaInsights(String(args.datePreset||'last_7d')))};},
  },
  {
    name:'dropbox_list_folder',description:'List files in a connected Dropbox folder without downloading their contents.',parameters:{type:'object',properties:{path:{type:'string'}},additionalProperties:false},permission:{id:'dropbox-read',label:'Listed connected Dropbox files',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).dropboxList(String(args.path||'')))};},
  },
  {
    name:'stripe_payments',description:'Read recent charges from the connected Stripe account (payment amounts, status, customer, currency). Read-only — this tool can never create a charge, refund, or payout.',parameters:{type:'object',properties:{days:{type:'number'}},additionalProperties:false},permission:{id:'stripe-read',label:'Read Stripe payment data',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).stripePayments(Number(args.days)||7))};},
  },
  {
    name:'klaviyo_campaigns',description:'Read recent email campaigns from the connected Klaviyo account (name, status, send time).',parameters:{type:'object',properties:{},additionalProperties:false},permission:{id:'klaviyo-read',label:'Read Klaviyo campaign data',risk:'sensitive',enabled:true},async execute(_args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).klaviyoCampaigns())};},
  },
  {
    name:'whatsapp_send_message',description:'Send a WhatsApp text message through the connected WhatsApp Business number. Always requires a fresh exact approval before transmission. Meta only allows a free-form message within 24 hours of the recipient\'s last message to this business number — outside that window Meta\'s API itself rejects it and a pre-approved template is required instead; if that happens, tell the user exactly that rather than guessing at a fix.',parameters:{type:'object',properties:{to:{type:'string'},message:{type:'string'}},required:['to','message'],additionalProperties:false},permission:{id:'whatsapp-send',label:'Sent a WhatsApp message',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).whatsappSend(String(args.to||''),String(args.message||'')))};},
  },
  {
    name:'homebridge_snapshot',description:'Read live Homebridge accessory states, names, types, and health. Use this to list smart devices or answer whether lights, locks, sensors, thermostats, and switches are on, off, open, locked, or active, on a Homebridge/HomeKit setup (not Home Assistant).',parameters:{type:'object',properties:{},additionalProperties:false},permission:{id:'smart-home-read',label:'Read live Homebridge accessory state',risk:'sensitive',enabled:true},async execute(_args,store){if(!store)throw new Error('Connector store unavailable.');const snapshot=await new ConnectorClient(store).homebridgeSnapshot();if(!snapshot.connected)throw new Error(snapshot.error||'Homebridge is unavailable.');return{output:JSON.stringify(snapshot)};},
  },
  {
    name:'homebridge_control',description:'Control one exact Homebridge accessory by name, setting a HomeKit characteristic (e.g. On, Brightness, LockTargetState, TargetTemperature). Verified after execution by rereading the accessory. Locks, garage doors, and security-system state changes always require fresh exact user approval.',parameters:{type:'object',properties:{target:{type:'string'},characteristic:{type:'string'},value:{type:['string','number','boolean']}},required:['target','value'],additionalProperties:false},permission:{id:'smart-home-control',label:'Controlled a verified Homebridge accessory',risk:'write',enabled:true},async execute(args,store){if(!store)throw new Error('Connector store unavailable.');return{output:JSON.stringify(await new ConnectorClient(store).homebridgeControl(args as unknown as import('../shared/contracts').HomebridgeControlRequest))};},
  },
  {
    name:'estimate_media_generation',description:'Estimate the conservative maximum API cost before generating an image or video. Use this before requesting generation approval.',parameters:{type:'object',properties:{kind:{type:'string',enum:['image','video']},quality:{type:'string',enum:['low','medium','high']},size:{type:'string'},seconds:{type:'number'},model:{type:'string',enum:['gpt-image-2','sora-2','sora-2-pro']}},required:['kind'],additionalProperties:false},permission:{id:'media-generate',label:'Estimated media generation cost',risk:'read',enabled:true},async execute(args){const kind=args.kind==='video'?'video':'image';if(kind==='video'){const seconds=[4,8,12].includes(Number(args.seconds))?Number(args.seconds):4,model=args.model==='sora-2-pro'?'sora-2-pro':'sora-2';return{output:JSON.stringify({kind,model,seconds,estimatedCostUsd:(model==='sora-2-pro'?.3:.1)*seconds,note:'Estimate from the current published per-second price; actual billing is determined by the provider.'})};}const quality=['low','high'].includes(String(args.quality))?String(args.quality):'medium',portrait=String(args.size)!=='1024x1024';const base=quality==='low'?.02:quality==='high'?.25:.08;return{output:JSON.stringify({kind,model:'gpt-image-2',quality,size:String(args.size||'1024x1024'),conservativeMaximumUsd:Number((base*(portrait?1.5:1)).toFixed(3)),note:'Conservative cap shown for approval; actual billing is determined by the provider calculator.'})};},
  },
  {
    name:'generate_image',description:'Generate and save an image with OpenAI GPT Image 2 after showing a cost estimate and receiving fresh approval. Saves to Pictures/Axiom Generated.',parameters:{type:'object',properties:{prompt:{type:'string'},quality:{type:'string',enum:['low','medium','high']},size:{type:'string',enum:['1024x1024','1024x1536','1536x1024']}},required:['prompt','quality','size'],additionalProperties:false},permission:{id:'media-generate',label:'Generated and saved an image',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Media store unavailable.');return{output:JSON.stringify(await new MediaService(store).generateImage(String(args.prompt||''),args.quality as 'low'|'medium'|'high',args.size as '1024x1024'|'1024x1536'|'1536x1024'))};},
  },
  {
    name:'generate_video',description:'Queue an OpenAI Sora video after showing a per-second estimate and receiving fresh approval. Completion is monitored in the background and saved to Pictures/Axiom Generated. The Sora API is deprecated and scheduled to shut down September 24, 2026.',parameters:{type:'object',properties:{prompt:{type:'string'},seconds:{type:'number',enum:[4,8,12]},size:{type:'string',enum:['720x1280','1280x720','1024x1792','1792x1024']},model:{type:'string',enum:['sora-2','sora-2-pro']}},required:['prompt','seconds','size','model'],additionalProperties:false},permission:{id:'media-generate',label:'Queued a video generation job',risk:'sensitive',enabled:true},async execute(args,store){if(!store)throw new Error('Media store unavailable.');return{output:JSON.stringify(await new MediaService(store).queueVideo(String(args.prompt||''),args.seconds as 4|8|12,args.size as '720x1280'|'1280x720'|'1024x1792'|'1792x1024',args.model as 'sora-2'|'sora-2-pro'))};},
  },
  {
    name:'show_cursor_guide',
    description:'Show a detached neon pointer at an exact desktop screen coordinate to visually guide the user. Use after inspecting the screen when the user asks where to click, look, or find something.',
    parameters:{type:'object',properties:{x:{type:'number'},y:{type:'number'},label:{type:'string'},durationMs:{type:'number'}},required:['x','y','label'],additionalProperties:false},
    permission:{id:'cursor-guide',label:'Displayed a visual cursor guide',risk:'write',enabled:true},
    async execute(args){return{output:JSON.stringify(await showCursorGuide(Number(args.x),Number(args.y),String(args.label||'LOOK HERE'),Number(args.durationMs)||5000))};},
  },
  {
    name:'open_gods_eye_view',description:"Open the user's God's Eye View 3D globe (a separate real project the user runs locally — live aircraft/ships/satellites/earthquakes on a photoreal Earth), embedded inside Axiom's window. Starts its local dev server if not already running, which can take up to 20 seconds on first launch.",parameters:{type:'object',properties:{},additionalProperties:false},permission:{id:'gods-eye-view',label:"Opened God's Eye View",risk:'write',enabled:true},async execute(_args,store){if(!store)throw new Error('Store unavailable.');const manager=store.getGodsEyeViewManager();if(!manager)throw new Error("Axiom's window is not ready.");const result=await manager.open(store.godsEyeViewPath());if(!result.ready)throw new Error(result.error||"God's Eye View could not be started.");return{output:JSON.stringify(result)};},
  },
  {
    name:'gods_eye_fly_to',
    description:`Fly the God's Eye View globe camera to an exact latitude/longitude, optionally turning on live data layers at the same time (e.g. "find live flights over St. Louis" = fly there and enable the flights layer in one call). Opens the view first if it isn't already open — do not call open_gods_eye_view separately before this. Known layer ids: ${GODS_EYE_LAYER_IDS.join(', ')}.`,
    parameters:{type:'object',properties:{lat:{type:'number'},lon:{type:'number'},alt:{type:'number'},heading:{type:'number'},pitch:{type:'number'},layers:{type:'array',items:{type:'string',enum:GODS_EYE_LAYER_IDS}}},required:['lat','lon'],additionalProperties:false},
    permission:{id:'gods-eye-view',label:"Moved the God's Eye View camera",risk:'write',enabled:true},
    async execute(args,store){
      if(!store)throw new Error('Store unavailable.');
      const manager=store.getGodsEyeViewManager();if(!manager)throw new Error("Axiom's window is not ready.");
      if(!manager.isOpen){const opened=await manager.open(store.godsEyeViewPath());if(!opened.ready)throw new Error(opened.error||"God's Eye View could not be started.");}
      await manager.flyTo({lat:Number(args.lat),lon:Number(args.lon),alt:args.alt!==undefined?Number(args.alt):undefined,heading:args.heading!==undefined?Number(args.heading):undefined,pitch:args.pitch!==undefined?Number(args.pitch):undefined});
      // Not filtered against GODS_EYE_LAYER_IDS here — manager.setLayers()
      // is the one real source of truth for what's valid, and it throws a
      // named, honest error for anything it doesn't recognize. Silently
      // dropping an unrecognized id here instead would make a typo'd layer
      // name look like it worked while doing nothing, exactly the failure
      // mode the manager's own validation exists to prevent.
      const requestedLayers=Array.isArray(args.layers)?args.layers as GodsEyeLayerId[]:[];
      const layers=requestedLayers.length?await manager.setLayers(requestedLayers):manager.currentLayers;
      return{output:JSON.stringify({moved:true,lat:Number(args.lat),lon:Number(args.lon),enabledLayers:layers})};
    },
  },
  {
    name:'gods_eye_set_layers',
    description:`Turn God's Eye View live data layers on or off without moving the camera (e.g. "also show satellites", "turn off the flights layer"). Opens the view first if it isn't already open. Known layer ids: ${GODS_EYE_LAYER_IDS.join(', ')}.`,
    parameters:{type:'object',properties:{enable:{type:'array',items:{type:'string',enum:GODS_EYE_LAYER_IDS}},disable:{type:'array',items:{type:'string',enum:GODS_EYE_LAYER_IDS}}},additionalProperties:false},
    permission:{id:'gods-eye-view',label:"Changed God's Eye View data layers",risk:'write',enabled:true},
    async execute(args,store){
      if(!store)throw new Error('Store unavailable.');
      const manager=store.getGodsEyeViewManager();if(!manager)throw new Error("Axiom's window is not ready.");
      if(!manager.isOpen){const opened=await manager.open(store.godsEyeViewPath());if(!opened.ready)throw new Error(opened.error||"God's Eye View could not be started.");}
      const enable=Array.isArray(args.enable)?args.enable as GodsEyeLayerId[]:[];
      const disable=Array.isArray(args.disable)?args.disable as GodsEyeLayerId[]:[];
      const layers=await manager.setLayers(enable,disable);
      return{output:JSON.stringify({enabledLayers:layers})};
    },
  },
  {
    name: 'show_notification',
    description: 'Show a native system notification with a short title and message when the user asks to be notified or when an approved background task finishes.',
    parameters: { type:'object', properties:{ title:{type:'string'},body:{type:'string'} }, required:['title','body'], additionalProperties:false },
    permission: { id:'notifications', label:'Showed a system notification', risk:'write', enabled:true },
    async execute(args) {
      if (!Notification.isSupported()) throw new Error('System notifications are unavailable on this computer.');
      const title=String(args.title??'Axiom').trim().slice(0,120)||'Axiom',body=String(args.body??'').trim().slice(0,500);
      if(!body)throw new Error('Notification body is empty.');new Notification({title,body}).show();return{output:JSON.stringify({shown:true,title,body})};
    },
  },
  {
    name: 'create_verified_backup',
    description: 'Create a timestamped, checksum-verified backup of Axiom\'s local settings, encrypted credentials, history, memory, goals, runtime records, and permissions on the Desktop.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'backup', label:'Created a verified Axiom backup', risk:'write', enabled:true },
    async execute(_args,store) { if(!store)throw new Error('Axiom data store is unavailable.');return{output:JSON.stringify(store.createBackup())}; },
  },
  {
    name: 'query_desktop_graph',
    description: 'Resolve applications, windows, and accessible controls from Axiom\'s persistent desktop object graph. Use this before guessing which desktop object the user means.',
    parameters: { type:'object', properties:{ query:{type:'string'}, limit:{type:'number'} }, required:['query'], additionalProperties:false },
    permission: { id:'desktop-read', label:'Resolved a known desktop object', risk:'read', enabled:true },
    async execute(args,store) {
      if(!store)throw new Error('Desktop object graph is unavailable.');
      const query=String(args.query??'').trim().slice(0,500);if(!query)throw new Error('A desktop object query is required.');
      return{output:JSON.stringify({query,objects:store.queryDesktopObjects(query,Number(args.limit)||20),graph:store.desktopGraph().metrics})};
    },
  },
  {
    name: 'get_desktop_graph_summary',
    description: 'Read Axiom\'s current semantic inventory of known applications, live windows, accessible controls, and recent desktop observations.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'desktop-read', label:'Read the desktop object graph', risk:'read', enabled:true },
    async execute(_args,store) {
      if(!store)throw new Error('Desktop object graph is unavailable.');
      const graph=store.desktopGraph();return{output:JSON.stringify({metrics:graph.metrics,liveObjects:graph.entities.filter((item)=>item.status==='live').slice(0,30),recentObservations:graph.observations.slice(0,20)})};
    },
  },
  {
    name: 'list_running_windows',
    description: 'List visible application windows on the current operating system with process names, titles, dimensions, and foreground state.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'desktop-read', label:'Inspected running windows', risk:'read', enabled:true },
    async execute() {
      if(process.platform==='darwin'){
        const windows=await listMacWindows() as Array<Record<string,unknown>>;return{output:JSON.stringify({windows,count:windows.length,engine:'macOS Accessibility'})};
      }
      const result = await runWinApp(['ui','list-windows','--json']);
      const windows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      const visible = windows.filter((item) => String(item.title || '').trim() && Number(item.width) >= 240 && Number(item.height) >= 120).slice(0, 40);
      return { output: JSON.stringify({ windows:visible, count:visible.length, engine:'Microsoft WinApp UI Automation' }) };
    },
  },
  {
    name: 'inspect_application_ui',
    description: 'Inspect interactive native Accessibility/UI Automation elements in a running application before controlling it. On Windows the target may also be a PID or hwnd:<number>; on macOS use the visible application name.',
    parameters: { type:'object', properties:{ application:{type:'string',description:'Process name, visible window title, PID, or hwnd:<number>.'} }, required:['application'], additionalProperties:false },
    permission: { id:'desktop-read', label:'Inspected application controls', risk:'read', enabled:true },
    async execute(args) {
      const application = cleanTarget(args.application);
      if(process.platform==='darwin')return{output:JSON.stringify(await inspectMacApplication(application))};
      const result = await runWinApp(['ui','inspect',...winAppTargetArgs(application),'--interactive','--hide-disabled','--hide-offscreen','--depth','15']);
      return { output: JSON.stringify({ application, controls:result.stdout.trim().slice(0,40_000), engine:'Microsoft UI Automation' }) };
    },
  },
  {
    name: 'invoke_application_control',
    description: 'Invoke a named button, menu item, checkbox, tab, or other UI Automation control in a running application after the user explicitly asks for that action. Inspect first when the selector is unknown.',
    parameters: { type:'object', properties:{ application:{type:'string'}, selector:{type:'string'} }, required:['application','selector'], additionalProperties:false },
    permission: { id:'desktop-control', label:'Activated an application control', risk:'sensitive', enabled:true },
    async execute(args) {
      const application = cleanTarget(args.application), selector = cleanTarget(args.selector);
      if(process.platform==='darwin')return{output:JSON.stringify(await invokeMacControl(application,selector))};
      const result = await runWinApp(['ui','invoke',selector,...winAppTargetArgs(application),'--json']);
      return { output: JSON.stringify({ invoked:true, application, selector, verification:result.stdout.trim().slice(0,8000) }) };
    },
  },
  {
    name: 'select_application_menu',
    description: 'Select an explicit native application menu path requested by the user, such as File → New Window or View → Show Sidebar. Inspect or list the application first when its state is uncertain.',
    parameters: { type:'object', properties:{ application:{type:'string'}, menu:{type:'string'}, item:{type:'string'}, subitem:{type:'string'} }, required:['application','menu','item'], additionalProperties:false },
    permission: { id:'desktop-control', label:'Selected an application menu', risk:'sensitive', enabled:true },
    async execute(args) {
      const application=cleanTarget(args.application),menu=cleanTarget(args.menu),item=cleanTarget(args.item),subitem=String(args.subitem??'').trim().slice(0,200);
      if(process.platform==='darwin')return{output:JSON.stringify(await selectMacMenu(application,menu,item,subitem))};
      const selector=subitem||item,result=await runWinApp(['ui','invoke',selector,...winAppTargetArgs(application),'--json']);
      return{output:JSON.stringify({selected:true,application,path:[menu,item,...(subitem?[subitem]:[])],verification:result.stdout.trim().slice(0,8000)})};
    },
  },
  {
    name: 'set_application_field',
    description: 'Set the value of a specific editable UI Automation element in a running application. Use only when the current user request explicitly asks Axiom to enter, type, fill, paste, or set that value.',
    parameters: { type:'object', properties:{ application:{type:'string'}, selector:{type:'string'}, value:{type:'string'} }, required:['application','selector','value'], additionalProperties:false },
    permission: { id:'desktop-control', label:'Updated an application field', risk:'sensitive', enabled:true },
    async execute(args,_store,userMessage) {
      if (!/\b(type|enter|fill|paste|write|set|input)\b/i.test(userMessage || '')) throw new Error('The current request must explicitly authorize entering or changing a field value.');
      if (/\b(password|passcode|pin|one[- ]?time code|otp|api key|secret|credit card|cvv|social security|ssn)\b/i.test(`${String(args.selector || '')} ${userMessage || ''}`)) throw new Error('Axiom will not enter credentials, authentication codes, financial details, or other secrets into application fields.');
      const application = cleanTarget(args.application), selector = cleanTarget(args.selector), value = String(args.value ?? '').slice(0,4000);
      if(process.platform==='darwin')return{output:JSON.stringify(await setMacField(application,selector,value))};
      const result = await runWinApp(['ui','set-value',selector,value,...winAppTargetArgs(application),'--json']);
      return { output: JSON.stringify({ changed:true, application, selector, characters:value.length, verification:result.stdout.trim().slice(0,8000) }) };
    },
  },
  {
    name: 'control_application_window',
    description: 'Focus, minimize, maximize, restore, or close a running application window. Closing is allowed only when the current user message explicitly asks to close, quit, or exit that application.',
    parameters: { type:'object', properties:{ application:{type:'string'}, action:{type:'string',enum:['focus','minimize','maximize','restore','close']} }, required:['application','action'], additionalProperties:false },
    permission: { id:'window-control', label:'Controlled an application window', risk:'sensitive', enabled:true },
    async execute(args,_store,userMessage) {
      const application = cleanTarget(args.application), action = String(args.action);
      if (action === 'close' && !/\b(close|quit|exit)\b/i.test(userMessage || '')) throw new Error('Closing an application requires an explicit close, quit, or exit request.');
      if(process.platform==='darwin')return{output:JSON.stringify(await controlMacWindow(application,action))};
      const selectors: Record<string,string> = { minimize:'Minimize', maximize:'Maximize', restore:'Restore', close:'Close' };
      if (action === 'focus') {
        const inspect = await runWinApp(['ui','inspect',...winAppTargetArgs(application),'--depth','0']);
        const selector = inspect.stdout.trim().split(/\s+/)[0];
        if (!selector) throw new Error('The target window could not be resolved.');
        const result = await runWinApp(['ui','focus',selector,...winAppTargetArgs(application),'--json']);
        return { output: JSON.stringify({ controlled:true, application, action, verification:result.stdout.trim().slice(0,4000) }) };
      }
      const result = await runWinApp(['ui','invoke',selectors[action],...winAppTargetArgs(application),'--json']);
      return { output: JSON.stringify({ controlled:true, application, action, verification:result.stdout.trim().slice(0,4000) }) };
    },
  },
  {
    name:'mac_compose_mail',
    description:'Create and display a native Apple Mail draft on macOS. This tool never sends the message; the user reviews the draft first.',
    parameters:{type:'object',properties:{to:{type:'string'},subject:{type:'string'},body:{type:'string'}},required:['to','subject','body'],additionalProperties:false},
    permission:{id:'desktop-control',label:'Composed an Apple Mail draft',risk:'sensitive',enabled:true},
    async execute(args){return{output:JSON.stringify(await composeMacMail(String(args.to||'').slice(0,320),String(args.subject||'').slice(0,500),String(args.body||'').slice(0,30_000)))};},
  },
  {
    name:'mac_create_note',
    description:'Create a native Apple Note on macOS in the requested folder.',
    parameters:{type:'object',properties:{title:{type:'string'},body:{type:'string'},folder:{type:'string'}},required:['title','body'],additionalProperties:false},
    permission:{id:'desktop-control',label:'Created an Apple Note',risk:'sensitive',enabled:true},
    async execute(args){return{output:JSON.stringify(await createMacNote(String(args.title||'').slice(0,500),String(args.body||'').slice(0,50_000),String(args.folder||'Notes').slice(0,200)))};},
  },
  {
    name:'mac_create_reminder',
    description:'Create a native Apple Reminder on macOS with a due date.',
    parameters:{type:'object',properties:{name:{type:'string'},dueAt:{type:'string'},notes:{type:'string'}},required:['name','dueAt'],additionalProperties:false},
    permission:{id:'desktop-control',label:'Created an Apple Reminder',risk:'sensitive',enabled:true},
    async execute(args){return{output:JSON.stringify(await createMacReminder(String(args.name||'').slice(0,500),String(args.dueAt||''),String(args.notes||'').slice(0,5000)))};},
  },
  {
    name:'mac_calendar_create_event',
    description:'Create a native Apple Calendar event on macOS after one-time user approval.',
    parameters:{type:'object',properties:{summary:{type:'string'},start:{type:'string'},end:{type:'string'},notes:{type:'string'},calendar:{type:'string'}},required:['summary','start','end'],additionalProperties:false},
    permission:{id:'desktop-control',label:'Created an Apple Calendar event',risk:'sensitive',enabled:true},
    async execute(args){return{output:JSON.stringify(await createMacCalendarEvent(String(args.summary||'').slice(0,500),String(args.start||''),String(args.end||''),String(args.notes||'').slice(0,5000),String(args.calendar||'').slice(0,200)))};},
  },
  {
    name: 'read_clipboard_text',
    description: 'Read plain text currently on the system clipboard only when the user asks what is copied or asks to use copied text.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'clipboard-read', label:'Read clipboard text', risk:'sensitive', enabled:true },
    async execute() { const text = clipboard.readText().slice(0,50_000); return { output:JSON.stringify({ text, characters:text.length }) }; },
  },
  {
    name: 'write_clipboard_text',
    description: 'Replace system clipboard text only when the user explicitly asks Axiom to copy specific text.',
    parameters: { type:'object', properties:{ text:{type:'string'} }, required:['text'], additionalProperties:false },
    permission: { id:'clipboard-write', label:'Copied text to clipboard', risk:'write', enabled:true },
    async execute(args,_store,userMessage) {
      if (!/\b(copy|clipboard)\b/i.test(userMessage || '')) throw new Error('The current request must explicitly ask to copy text.');
      const text = String(args.text ?? '').slice(0,50_000); clipboard.writeText(text); return { output:JSON.stringify({ copied:clipboard.readText() === text, characters:text.length }) };
    },
  },
  {
    name: 'control_media',
    description: 'Control Windows system media keys: volume up/down, mute toggle, play/pause, next track, or previous track.',
    parameters: { type:'object', properties:{ action:{type:'string',enum:['volume_up','volume_down','mute','play_pause','next_track','previous_track']} }, required:['action'], additionalProperties:false },
    permission: { id:'media-control', label:'Sent a verified media control', risk:'write', enabled:true },
    async execute(args) {
      if(process.platform==='darwin')return{output:JSON.stringify(await controlMacMedia(String(args.action)))};
      const keys: Record<string,number> = { volume_up:0xAF, volume_down:0xAE, mute:0xAD, play_pause:0xB3, next_track:0xB0, previous_track:0xB1 };
      const action = String(args.action), key = keys[action]; if (!key) throw new Error('Unsupported media action.');
      const script = 'Add-Type -TypeDefinition "using System.Runtime.InteropServices; public static class AxiomMedia { [DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr extra); }"; [AxiomMedia]::keybd_event([byte]$env:AXIOM_MEDIA_KEY,0,0,[UIntPtr]::Zero); [AxiomMedia]::keybd_event([byte]$env:AXIOM_MEDIA_KEY,0,2,[UIntPtr]::Zero)';
      const result = await runCommand('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],10_000,{...process.env,AXIOM_MEDIA_KEY:String(key)});
      if (result.exitCode !== 0) throw new Error(result.stderr || 'The media key could not be sent.');
      return { output:JSON.stringify({ controlled:true, action }) };
    },
  },
  {
    name: 'list_project_files',
    description: 'Inventory source files in the configured Axiom Build Lab workspace. Build artifacts, dependencies, Git internals, and checkpoint storage are excluded.',
    parameters: { type:'object', properties:{}, additionalProperties:false },
    permission: { id:'code-read', label:'Inspected coding workspace', risk:'read', enabled:true },
    async execute(_args, store) {
      const root = await codingRoot(store), files: Array<{path:string;bytes:number}> = [], ignored = new Set(['node_modules','.git','.axiom','release','dist','dist-main','dist-renderer','coverage']);
      const walk = async (folder: string, depth: number): Promise<void> => { if (depth > 8 || files.length >= 500) return; for (const entry of await fs.readdir(folder,{withFileTypes:true})) { if (ignored.has(entry.name)) continue; const absolute=path.join(folder,entry.name); if(entry.isDirectory()) await walk(absolute,depth+1); else if(entry.isFile()){const stat=await fs.stat(absolute);files.push({path:path.relative(root,absolute).replaceAll('\\','/'),bytes:stat.size});if(files.length>=500)return;} } };
      await walk(root,0); return { output:JSON.stringify({root,files,truncated:files.length>=500}) };
    },
  },
  {
    name: 'read_project_file',
    description: 'Read a UTF-8 source file from the configured Axiom Build Lab workspace before proposing or making a code change.',
    parameters: { type:'object', properties:{ path:{type:'string'} }, required:['path'], additionalProperties:false },
    permission: { id:'code-read', label:'Read project source', risk:'read', enabled:true },
    async execute(args, store) {
      const item=await codingPath(store,args.path);const stat=await fs.stat(item.target);if(!stat.isFile())throw new Error('Project path is not a file.');if(stat.size>800_000)throw new Error('Source file exceeds the 800 KB reading limit.');
      return { output:JSON.stringify({path:item.relative,content:await fs.readFile(item.target,'utf8'),bytes:stat.size}) };
    },
  },
  {
    name: 'write_project_file',
    description: 'Create or replace one text source file in the configured coding workspace. A rollback checkpoint is created automatically before every write. Use only for a current request that explicitly asks Axiom to build, code, edit, implement, fix, or update software.',
    parameters: { type:'object', properties:{ path:{type:'string'}, content:{type:'string'}, summary:{type:'string'} }, required:['path','content','summary'], additionalProperties:false },
    permission: { id:'code-write', label:'Checkpointed and wrote project source', risk:'sensitive', enabled:true },
    async execute(args, store, userMessage) {
      if(!/\b(build|code|coding|edit|implement|fix|update|change|create|rewrite|refactor|add|remove)\b/i.test(userMessage||''))throw new Error('The current request must explicitly authorize a software change.');
      const item=await codingPath(store,args.path), extension=path.extname(item.target).toLowerCase();
      const allowed=new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.html','.css','.scss','.md','.txt','.py','.ps1','.yml','.yaml','.toml','.xml','.svg','.sql']);
      if(!allowed.has(extension))throw new Error('That project file type is not enabled for autonomous editing.');
      const content=String(args.content??'');if(Buffer.byteLength(content,'utf8')>1_000_000)throw new Error('Project file exceeds the 1 MB writing limit.');
      const checkpoint=await createFileCheckpoint(item.root,item.target,item.relative);await fs.mkdir(path.dirname(item.target),{recursive:true});const temp=`${item.target}.axiom-tmp`;await fs.writeFile(temp,content,'utf8');await fs.rename(temp,item.target);const verified=(await fs.readFile(item.target,'utf8'))===content;
      return { output:JSON.stringify({written:verified,path:item.relative,bytes:Buffer.byteLength(content,'utf8'),checkpoint,summary:String(args.summary||'').slice(0,500)}) };
    },
  },
  {
    name: 'run_project_check',
    description: 'Run an existing allowlisted npm project script in the configured coding workspace and return its real output. Supported checks are test, build, lint, and typecheck.',
    parameters: { type:'object', properties:{ check:{type:'string',enum:['test','build','lint','typecheck']} }, required:['check'], additionalProperties:false },
    permission: { id:'code-execute', label:'Ran a project verification', risk:'sensitive', enabled:true },
    async execute(args, store) {
      const root=await codingRoot(store),check=String(args.check),packageFile=path.join(root,'package.json');const pkg=JSON.parse(await fs.readFile(packageFile,'utf8')) as {scripts?:Record<string,string>};if(!pkg.scripts?.[check])throw new Error(`This project does not define an npm ${check} script.`);
      const command=process.platform==='win32'?(process.env.ComSpec||'cmd.exe'):'npm';const commandArgs=process.platform==='win32'?['/d','/s','/c',`npm.cmd run ${check}`]:['run',check];const result=await runCommand(command,commandArgs,180_000,process.env,root);if(result.exitCode!==0)throw new Error(JSON.stringify({check,exitCode:result.exitCode,stdout:result.stdout.slice(-30_000),stderr:result.stderr.slice(-20_000)}));
      return { output:JSON.stringify({check,passed:true,exitCode:result.exitCode,stdout:result.stdout.slice(-30_000),stderr:result.stderr.slice(-10_000)}) };
    },
  },
  {
    name: 'delete_project_file',
    description: 'Delete one project file only when the current user explicitly asks to delete or remove it. A restorable checkpoint is created before deletion. Directories, dependencies, Git internals, and checkpoint storage cannot be deleted.',
    parameters: { type:'object', properties:{ path:{type:'string'}, reason:{type:'string'} }, required:['path','reason'], additionalProperties:false },
    permission: { id:'code-delete', label:'Checkpointed and removed project source', risk:'sensitive', enabled:true },
    async execute(args, store, userMessage) {
      if(!/\b(delete|remove)\b/i.test(userMessage||''))throw new Error('Deleting project source requires an explicit delete or remove request.');
      const item=await codingPath(store,args.path),stat=await fs.stat(item.target);if(!stat.isFile())throw new Error('Only individual project files can be deleted.');const checkpoint=await createFileCheckpoint(item.root,item.target,item.relative);await fs.rm(item.target,{force:true});
      return { output:JSON.stringify({deleted:true,path:item.relative,checkpoint,reason:String(args.reason||'').slice(0,500)}) };
    },
  },
  {
    name: 'restore_project_checkpoint',
    description: 'Restore one automatically checkpointed project file. Use only when the current user explicitly asks to restore, revert, or roll back a checkpoint ID.',
    parameters: { type:'object', properties:{ checkpoint:{type:'string'} }, required:['checkpoint'], additionalProperties:false },
    permission: { id:'code-rollback', label:'Restored a project checkpoint', risk:'sensitive', enabled:true },
    async execute(args, store, userMessage) {
      if(!/\b(restore|revert|roll ?back|undo)\b/i.test(userMessage||''))throw new Error('Restoring code requires an explicit restore, revert, rollback, or undo request.');
      const root=await codingRoot(store),id=String(args.checkpoint||'');if(!/^[\w-]{8,80}$/.test(id))throw new Error('Invalid checkpoint ID.');const folder=path.join(root,'.axiom','checkpoints',id);const manifest=JSON.parse(await fs.readFile(path.join(folder,'manifest.json'),'utf8')) as {relative:string;existed:boolean};const item=await codingPath(store,manifest.relative);
      if(manifest.existed){await fs.mkdir(path.dirname(item.target),{recursive:true});await fs.copyFile(path.join(folder,'file'),item.target);}else{await fs.rm(item.target,{force:true});}
      return { output:JSON.stringify({restored:true,checkpoint:id,path:item.relative,removedNewFile:!manifest.existed}) };
    },
  },
  {
    name: 'request_powershell_confirmation',
    description: 'Prepare a PowerShell command and return a confirmation code. Always use this first; never claim the command ran. Explain the exact command and ask the user to reply APPROVE followed by the code.',
    parameters: { type:'object', properties:{ command:{type:'string'}, purpose:{type:'string'} }, required:['command','purpose'], additionalProperties:false },
    permission: { id:'powershell', label:'PowerShell awaiting confirmation', risk:'sensitive', enabled:true },
    async execute(args) {
      const command=String(args.command||'').trim().slice(0,4000);if(!command)throw new Error('PowerShell command is empty.');assertPowerShellAllowed(command);
      const token=crypto.randomBytes(3).toString('hex').toUpperCase();pendingPowerShell.set(token,{command,expires:Date.now()+5*60_000});
      return{output:JSON.stringify({executed:false,confirmationRequired:true,code:token,command,purpose:String(args.purpose||'').slice(0,500),instruction:`Ask the user to reply APPROVE ${token}`})};
    },
  },
  {
    name: 'execute_confirmed_powershell',
    description: 'Execute a previously prepared PowerShell command only after the user’s current message explicitly contains APPROVE and the exact confirmation code.',
    parameters: { type:'object', properties:{ code:{type:'string'} }, required:['code'], additionalProperties:false },
    permission: { id:'powershell', label:'Executed confirmed PowerShell', risk:'sensitive', enabled:true },
    async execute(args,_store,userMessage) {
      const code=String(args.code||'').toUpperCase();const pending=pendingPowerShell.get(code);const explicitlyApproved=new RegExp(`\\bAPPROVE\\s+${code}\\b`,'i').test(userMessage||'');
      if(!pending||pending.expires<Date.now()){pendingPowerShell.delete(code);throw new Error('PowerShell confirmation expired or was not found.');}
      if(!explicitlyApproved)throw new Error(`The current user message must explicitly contain APPROVE ${code}.`);
      pendingPowerShell.delete(code);const result=await runPowerShell(pending.command);return{output:JSON.stringify({executed:true,command:pending.command,...result})};
    },
  },
  {
    name: 'get_system_summary',
    description: 'Read live, verified computer diagnostics: CPU and per-core load, CPU temperature when exposed, GPU model/load/temperature/VRAM when exposed, RAM and swap, storage usage and disk activity, network throughput, battery/power, uptime, and top processes. Never invent an unavailable sensor value.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    permission: { id: 'read-system', label: 'Read live system diagnostics', risk: 'read', enabled: true },
    async execute() {
      return { output: JSON.stringify(await getSystemTelemetrySnapshot({detailed:true})) };
    },
  },
  {
    name:'get_capability_status',
    description:'Return Axiom\'s actual locally registered capability and permission map for this platform. Use this instead of guessing what Axiom can do.',
    parameters:{type:'object',properties:{},additionalProperties:false},
    permission:{id:'capability-status',label:'Read registered capability status',risk:'read',enabled:true},
    async execute(_args,store){
      const profile=platformProfile(),items=capabilityManifest(store);
      return{output:JSON.stringify({platform:profile.id,automation:profile.automationLabel,capabilities:items,ready:items.filter((item)=>item.enabled).length,blocked:items.filter((item)=>!item.enabled).length})};
    },
  },
  {
    name: 'set_companion_appearance',
    description: 'Change Axiom\'s complete visual identity: skull, eyes, waveform, interface accent, glow, emotional expression, information density, and motion profile. Use whenever the user asks Axiom to change how it looks.',
    parameters: {
      type: 'object',
      properties: {
        color: { type: 'string', enum: ['teal', 'green', 'blue', 'violet', 'amber', 'orange', 'pink', 'red', 'white'] },
        emotion: { type: 'string', enum: ['neutral', 'happy', 'focused', 'concerned', 'angry', 'excited'] },
        accentHex: { type: 'string', description: 'Optional six-digit hexadecimal accent such as #ff3bd4.' },
        glowIntensity: { type: 'number', minimum: 0.35, maximum: 1.5 },
        motionProfile: { type: 'string', enum: ['adaptive', 'cinematic', 'efficient', 'reduced'] },
        density: { type: 'string', enum: ['compact', 'balanced', 'spacious'] },
      },
      required: [],
      additionalProperties: false,
    },
    permission: { id: 'appearance', label: 'Updated companion appearance', risk: 'write', enabled: true },
    async execute(args, store) {
      const current=store?.publicSettings?.().appearance??{color:'teal',emotion:'neutral',accentHex:'#20ffd3',glowIntensity:1,motionProfile:'adaptive',density:'balanced'} as AppearanceSettings;
      const colors = ['teal', 'green', 'blue', 'violet', 'amber', 'orange', 'pink', 'red', 'white'] as const;
      const emotions = ['neutral', 'happy', 'focused', 'concerned', 'angry', 'excited'] as const;
      const motions = ['adaptive','cinematic','efficient','reduced'] as const;
      const densities = ['compact','balanced','spacious'] as const;
      const color = colors.includes(args.color as typeof colors[number]) ? args.color as AppearanceColor : current.color;
      const emotion = emotions.includes(args.emotion as typeof emotions[number]) ? args.emotion as CompanionEmotion : current.emotion;
      const namedHex:Record<AppearanceColor,string>={teal:'#20ffd3',green:'#60ff84',blue:'#41b8ff',violet:'#b667ff',amber:'#ffb530',orange:'#ff7a32',pink:'#ff4fc8',red:'#ff304e',white:'#dcffff'};
      const appearance:AppearanceSettings={
        color,
        emotion,
        accentHex:typeof args.accentHex==='string'&&/^#[0-9a-f]{6}$/i.test(args.accentHex)?args.accentHex.toLowerCase():(args.color?namedHex[color]:current.accentHex),
        glowIntensity:typeof args.glowIntensity==='number'&&Number.isFinite(args.glowIntensity)?Math.max(.35,Math.min(1.5,args.glowIntensity)):current.glowIntensity,
        motionProfile:motions.includes(args.motionProfile as typeof motions[number])?args.motionProfile as MotionProfile:current.motionProfile,
        density:densities.includes(args.density as typeof densities[number])?args.density as InterfaceDensity:current.density,
      };
      store?.setAppearance(appearance);
      return { output: JSON.stringify({ changed: true, persisted: Boolean(store), appearance }), uiCommand: { type: 'appearance', appearance, color, emotion } };
    },
  },
];

const userRoots = ['Desktop', 'Documents', 'Downloads'].map((folder) => path.resolve(os.homedir(), folder));
const pendingPowerShell = new Map<string,{command:string;expires:number}>();
const windowsOnlyTools=new Set(['request_powershell_confirmation','execute_confirmed_powershell']);
// God's Eye View integration is Mac-only for now — the user's real install
// is on macOS and Windows support is explicitly deferred until he's back on
// that machine; gating here keeps the tool from being offered where it can't
// actually work, same reasoning as the other mac_* tools below.
const macOnlyTools=new Set(['mac_compose_mail','mac_create_note','mac_create_reminder','mac_calendar_create_event','open_gods_eye_view','gods_eye_fly_to','gods_eye_set_layers']);
const toolAvailable=(name:string):boolean=>(!windowsOnlyTools.has(name)||platformProfile().supportsWinApp)&&(!macOnlyTools.has(name)||process.platform==='darwin');
function allowedPath(input: string): string {
  if (!path.isAbsolute(input)) throw new Error('Use an absolute path inside Desktop, Documents, or Downloads.');
  const resolved = path.resolve(input);
  const allowed = userRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) throw new Error('Path is outside the enabled Desktop, Documents, and Downloads folders.');
  return resolved;
}

// This is a denylist of literal cmdlet/flag names, not a real sandbox — it
// cannot catch arbitrary obfuscation (string-concatenated cmdlet names,
// character-code assembly, etc.), and was never a security boundary on its
// own. The actual boundary is the human-approval flow above: the raw
// command is shown to the user, re-executed verbatim from what was
// approved (never re-derived from model-supplied args at execution time),
// and requires the literal APPROVE code in the user's own message, which
// the model cannot forge. This function exists to catch the common,
// unobfuscated cases so a command that's blatantly destructive or evasive
// never even reaches the approval preview — not to guarantee nothing bad
// can get past it dressed up cleverly enough.
function assertPowerShellAllowed(command:string):void{
  const forbidden=/\b(format-volume|clear-disk|remove-partition|remove-disk|bcdedit|cipher\s+\/w|invoke-expression|iex|shutdown\.exe|stop-computer|restart-computer|new-service|sc\.exe|schtasks|set-executionpolicy|add-mppreference|remove-mppreference|netsh\s+advfirewall|reg(?:\.exe)?\s+add|invoke-webrequest|invoke-restmethod|iwr|irm|net\.webclient|downloadstring|downloadfile)\b/i;
  if(forbidden.test(command))throw new Error('This high-impact PowerShell operation is not enabled.');
  // -EncodedCommand (or any of its valid short forms: -e, -en, -enc, ...
  // PowerShell accepts any unambiguous prefix) hands PowerShell a base64
  // blob it decodes and runs internally — any plaintext check on the
  // surrounding command is blind to what that blob actually does, so a
  // flag matching that shape followed by a long base64-looking token is
  // refused outright rather than pretending to inspect it.
  if(/-e\w*\s+[A-Za-z0-9+/=]{20,}\b/i.test(command))throw new Error('This high-impact PowerShell operation is not enabled.');
}

function runPowerShell(command:string):Promise<{exitCode:number|null;stdout:string;stderr:string}>{
  return new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('PowerShell timed out after 30 seconds.'));},30_000);child.stdout.on('data',(chunk)=>{stdout=(stdout+chunk.toString()).slice(-80_000);});child.stderr.on('data',(chunk)=>{stderr=(stderr+chunk.toString()).slice(-40_000);});child.on('error',(error)=>{clearTimeout(timer);reject(error);});child.on('close',(exitCode)=>{clearTimeout(timer);resolve({exitCode,stdout,stderr});});});
}

// Originally only literal topic words (news/weather/prices/etc). A live user
// report showed a fact-check request ("verify this is accurate / current
// breaking news") missing every one of those and getting zero search tools,
// so the model correctly-but-uselessly reported it had no way to check.
// Added phrasing for verification/currency requests, which need live
// grounding just as much as an explicit "what's the news" ever did.
const liveWebRequestPattern = /\b(news|headlines?|current events?|latest|today(?:'s)?|weather|forecast|temperature|traffic|score|scores|standings|price|prices|search(?: the)? web|search online|search (?:the )?internet|internet|look up|online|web|verify|verification|confirm|fact.?check|breaking|rumor|hoax|is (?:it|this|that) (?:true|real|accurate|legit)|did (?:it|this|that) (?:really |actually )?happen|happening (?:now|right now)|just happened|recent(?:ly)?|right now|as of (?:now|today))\b/i;
const localHardwareTemperaturePattern = /\b(?:cpu|gpu|processor|graphics|computer|system|hardware|device)\b.{0,30}\b(?:temps?|temperatures?|thermal|heat|hot)\b|\b(?:temps?|temperatures?|thermal)\b.{0,30}\b(?:cpu|gpu|processor|graphics|computer|system|hardware|device)\b/i;
const actionRequestPattern = /(?:^|\b)(?:please\s+)?(?:open|launch|start|create|make|generate|add|monitor|watch|schedule|send|archive|write|read|check|inspect|list|show|find|search|look up|change|set|turn|dim|lock|unlock|arm|disarm|close|quit|exit|click|press|fill|type|copy|paste|save|remember|recall|forget|run|build|fix|implement|notify|back up|backup|control|play|pause|mute|unmute|delete|remove|restore|revert)\b|\b(?:can|could|would|will)\s+you\b|\bi\s+(?:want|need)\s+you\s+to\b|^\s*(?:what|which|where|when|who|how)\b/i;
const identityRequestPattern = /\b(?:my name is|call me|who am i|who (?:are you|am i|is this|are you talking to)|do you (?:know|recognize|remember) me|do you know who (?:i am|you(?:'re| are) talking to)|how do you know (?:it'?s|this is) me|identify me|my identity)\b/i;
// A live user asked "Is the back door locked?" and Axiom just answered from
// nothing — that phrasing doesn't match actionRequestPattern (no verb, no
// "can/could/would/will you", doesn't start with what/which/where/when/
// who/how), so requiresToolUse() returned false and nothing forced a real
// device read. Scoped to lock/on-off/open-closed/armed-disarmed state
// words specifically, not broadened generally, since actionRequestPattern
// is used well beyond smart-home requests.
const smartHomeStateQuestionPattern = /\b(?:is|are)\b[\s\S]{0,60}\b(?:locked|unlocked|on|off|open|closed|armed|disarmed)\b/i;

// A blocked destructive action tells the user to "say APPROVE AX-XXXXXX",
// but that phrase alone shares no keywords with the original request (e.g.
// "close the app"), so providerTools() never re-offers the tool and the
// model has nothing to call — the approval instruction was a dead end. This
// extracts the code so the caller can execute the pending action directly,
// bypassing tool-selection entirely instead of hoping the model reconstructs
// the same request with the same arguments.
export function approvalCodeFromMessage(userMessage:string):string|undefined{
  const match=/\bAPPROVE\s+(AX-[0-9A-F]{6})\b/i.exec(userMessage);
  return match?match[1].toUpperCase():undefined;
}

export function requiresLiveWeb(userMessage: string): boolean {
  return liveWebRequestPattern.test(userMessage) && !localHardwareTemperaturePattern.test(userMessage);
}

export function requiresToolUse(userMessage: string, tools?: Record<string, unknown>[]): boolean {
  const available = tools ?? providerTools(userMessage);
  return available.length > 0 && (requiresLiveWeb(userMessage) || actionRequestPattern.test(userMessage) || identityRequestPattern.test(userMessage) || smartHomeStateQuestionPattern.test(userMessage));
}

export interface DeterministicReadRoute {name:string;args:Record<string,unknown>}
export function deterministicReadRoute(userMessage:string,store?:AppStore):DeterministicReadRoute|undefined{
  const text=userMessage.trim();
  if(requiresLiveWeb(text))return undefined;
  if(/\b(?:what can you do|what are your capabilities|show (?:me )?(?:all|everything) you can do|list (?:all )?(?:your )?(?:tools|capabilities)|can you control everything)\b/i.test(text))return{name:'get_capability_status',args:{}};
  if(/\b(?:cpu|gpu|processor|graphics card|vram|ram|swap|disk|storage|drive|battery|uptime|processes?|computer stats?|system stats?|hardware stats?|utili[sz]ation|usage|temps?|temperatures?|thermal|fan speed)\b/i.test(text))return{name:'get_system_summary',args:{}};
  if(/\b(?:what time|current time|what(?:'s| is) the date|what day is it|local time)\b/i.test(text))return{name:'get_local_time',args:{}};
  if(/\b(?:list|show|inspect|what).{0,28}\b(?:running (?:apps?|applications?|windows)|open windows|foreground window)\b/i.test(text))return{name:'list_running_windows',args:{}};
  if(/\b(?:list|show|what are).{0,20}\b(?:my )?goals\b/i.test(text))return{name:'list_goals',args:{}};
  if(/\b(?:list|show|what(?:'s| is)).{0,20}\b(?:my )?(?:todos|to-dos|task list)\b/i.test(text))return{name:'list_todos',args:{}};
  if(/\b(?:list|show|what are).{0,20}\b(?:your )?(?:commitments|promises)\b/i.test(text))return{name:'list_commitments',args:{}};
  if(/\b(?:list|show|what are).{0,20}\b(?:your |my )?skills\b/i.test(text))return{name:'list_skills',args:{}};
  if(/\b(?:list|show|what are).{0,20}\b(?:your |my )?agents\b/i.test(text))return{name:'list_agents',args:{}};
  if(/\b(?:homebridge|homekit|smart home|smart devices?|smart lights?|smart locks?|thermostats?|climate|garage doors?|door sensors?|window sensors?|motion sensors?|alarm system)\b/i.test(text)&&/\b(?:list|show|which|what|status|state|is|are|any)\b/i.test(text))return{name:'homebridge_snapshot',args:{}};
  if(identityRequestPattern.test(text))return{name:'recall_memory',args:{query:text.slice(0,500)}};
  return undefined;
}

export interface DeterministicActionRoute extends DeterministicReadRoute {successText:string}
/** Fast, model-independent routes for explicit actions whose target can be
 * derived without ambiguity. Execution still goes through the normal tool,
 * permission, receipt, and verification path. */
export function deterministicActionRoute(userMessage:string):DeterministicActionRoute|undefined{
  const text=userMessage.trim();
  const leading=/^(?:please\s+)?(?:search|find|look up)\s+(?:on\s+)?youtube(?:\s+for)?(?:\s+(.+?))?[.!?]*$/i.exec(text);
  const trailing=/^(?:please\s+)?(?:search|find|look up)\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+youtube[.!?]*$/i.exec(text);
  const query=(leading?.[1]||trailing?.[1]||'').trim().replace(/[.!?]+$/,'').trim();
  if(leading||trailing){
    const url=query?`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`:'https://www.youtube.com/';
    return{name:'browser_open',args:{url},successText:query?`Opened YouTube search results for “${query}”.`:'Opened YouTube.'};
  }
  const appearanceIntent=/\b(?:change|set|make|turn|switch|update|customi[sz]e|restyle)\b.{0,55}\b(?:your|axiom(?:'s)?|the)?\s*(?:color|colour|theme|appearance|look|interface|ui|hud|eyes?|glow|emotion|mood|motion|animations?|density)\b|\b(?:make|turn)\s+(?:yourself|axiom|the (?:interface|ui|hud|eyes?|skull))\b/i.test(text);
  if(appearanceIntent){
    const lower=text.toLowerCase();
    const colorAliases:Array<[RegExp,AppearanceColor]>=[[/\b(?:teal|cyan|aqua|turquoise)\b/,'teal'],[/\b(?:green|lime)\b/,'green'],[/\bblue\b/,'blue'],[/\b(?:violet|purple)\b/,'violet'],[/\b(?:amber|gold|yellow)\b/,'amber'],[/\borange\b/,'orange'],[/\b(?:pink|magenta|fuchsia)\b/,'pink'],[/\b(?:red|crimson)\b/,'red'],[/\b(?:white|silver)\b/,'white']];
    const emotionAliases:Array<[RegExp,CompanionEmotion]>=[[/\bhapp(?:y|ier)|smil(?:e|ing)\b/,'happy'],[/\bfocus(?:ed)?|serious\b/,'focused'],[/\bconcern(?:ed)?|worried\b/,'concerned'],[/\bangry|mad\b/,'angry'],[/\bexcited|energized\b/,'excited'],[/\bneutral|calm\b/,'neutral']];
    const args:Record<string,unknown>={};
    const color=colorAliases.find(([pattern])=>pattern.test(lower))?.[1];if(color)args.color=color;
    const emotion=emotionAliases.find(([pattern])=>pattern.test(lower))?.[1];if(emotion)args.emotion=emotion;
    const customHex=/(#[0-9a-f]{6})\b/i.exec(text)?.[1];if(customHex)args.accentHex=customHex;
    if(/\b(?:cinematic|max(?:imum)?|full)\s+(?:motion|animation)|\bcinematic\b/.test(lower))args.motionProfile='cinematic';
    else if(/\b(?:efficient|performance|low power|battery)\b/.test(lower))args.motionProfile='efficient';
    else if(/\b(?:reduce|reduced|disable|stop|no)\s+(?:motion|animations?)\b/.test(lower))args.motionProfile='reduced';
    else if(/\badaptive\b/.test(lower))args.motionProfile='adaptive';
    if(/\bcompact\b/.test(lower))args.density='compact';else if(/\bspacious\b/.test(lower))args.density='spacious';else if(/\bbalanced\b/.test(lower))args.density='balanced';
    if(/\b(?:more|stronger|brighter|intense)\s+glow\b|\bglow\s+(?:more|brighter)\b/.test(lower))args.glowIntensity=1.35;
    else if(/\b(?:less|lower|subtle|dim)\s+glow\b|\bglow\s+(?:less|lower)\b/.test(lower))args.glowIntensity=.65;
    if(Object.keys(args).length)return{name:'set_companion_appearance',args,successText:`Updated my complete visual system${color?` to ${color}`:''}${emotion?` with a ${emotion} expression`:''}.`};
  }
  return undefined;
}

export function providerTools(userMessage?: string, store?: AppStore): Record<string, unknown>[] {
  // web_search is a real function tool in the registry now (see above) —
  // no more special-cased native/hosted tool type per provider.
  if(userMessage===undefined)return registry.filter((tool)=>toolAvailable(tool.name)).map((tool)=>({type:'function',name:tool.name,description:tool.description,parameters:tool.parameters,strict:true}));
  const text=userMessage.toLowerCase(), names=new Set<string>();
  // Implicit memory capture: remember_fact/recall_memory used to be offered
  // only behind an explicit "remember"/"my name is"-style trigger — the
  // same keyword-gating blind spot fixed for web_search, folder creation,
  // and Homebridge control earlier this project (a miss just looks like
  // "Axiom forgot," not a crash). A plain statement made in passing ("I
  // just moved to Austin") never said the word "remember" and so was never
  // even offered the tool. Now offered on every ordinary turn so Axiom can
  // choose to save something durable and non-obvious on its own — but only
  // when this message doesn't ALSO match one of the four patterns that can
  // force a specific other tool by exact name (requiresToolUse below):
  // adding two more candidates on top of a would-be sole-candidate action
  // request (e.g. "unlock the back door") would silently fall back to a
  // generic forced tool_choice, which was confirmed unreliable and is the
  // whole reason exact-name forcing exists. Ordinary declarative statements
  // never match those four patterns, so this only ever adds a free-choice
  // option to turns that were already free-choice.
  if(!requiresLiveWeb(userMessage)&&!actionRequestPattern.test(text)&&!identityRequestPattern.test(text)&&!smartHomeStateQuestionPattern.test(text)){names.add('remember_fact');names.add('recall_memory');}
  // A live user asked for "top headlines" / "breaking news" / a specific
  // outlet's headlines and got category-page links back from general web
  // search, not real article text — a search index isn't built for that.
  // Deliberately mutually exclusive with web_search (not offered alongside
  // it): a live failure showed the model sometimes ignores a generic
  // "you must call a tool" instruction when more than one candidate tool is
  // on the table. Offering exactly one live-research tool lets Axiom force
  // that exact tool by name (a hard API-level constraint on all three
  // providers) instead of a generic "required" hint the model can slip by.
  const newsIntent=/\b(news|headlines?|breaking|top stories?)\b/i.test(text);
  if(newsIntent)names.add('get_news_headlines');
  else if(requiresLiveWeb(text))names.add('web_search');
  if(/\b(?:my name is|call me)\b/.test(text))names.add('remember_fact');
  if(identityRequestPattern.test(text))names.add('recall_memory');
  if(/\b(remember|memory|recall|forget|forgot|correct|preference|decision)\b/.test(text))['remember_fact','recall_memory','correct_memory','forget_memory'].forEach((name)=>names.add(name));
  if(/\b(you were wrong|that'?s wrong|you got that wrong|you made a mistake|that'?s not right|you misunderstood|you shouldn'?t have)\b/i.test(text))names.add('record_self_correction');
  if(/\b(goal|goals)\b/.test(text))['create_goal','list_goals','complete_goal'].forEach((name)=>names.add(name));
  if(/\b(todo|to-do|task list|checklist)\b/.test(text))['add_todo','list_todos','set_todo_status'].forEach((name)=>names.add(name));
  if(/\b(skill|skills|workflow|playbook|procedure)\b/.test(text))['save_skill','list_skills','run_skill','remove_skill'].forEach((name)=>names.add(name));
  if(/\b(agent|agents|specialist|delegate|every (?:day|hour|morning|evening|week)|daily|scheduled?)\b/.test(text))['create_agent','list_agents','run_agent','remove_agent'].forEach((name)=>names.add(name));
  if(/\b(commitment|commitments|promise|promised|follow up|follow-up|remind|don't forget|do not forget)\b/.test(text))['create_commitment','list_commitments','resolve_commitment'].forEach((name)=>names.add(name));
  if(/\b(monitor|watch for|keep an eye on|alert me when|camera watch|screen watch)\b/.test(text))['create_visual_monitor','list_visual_monitors'].forEach((name)=>names.add(name));
  // "Create a new folder" is unambiguous — resolve it to exactly one tool
  // (same principle as the live-research fix: a generic "you must call a
  // tool" instruction was confirmed unreliable once several tools are
  // plausible candidates, so removing the ambiguity where the intent is
  // this clear matters more than it looks).
  if(/\b(create|make|new)\b[\s\S]{0,25}\b(folder|directory)\b/i.test(text))names.add('create_directory');
  // Bare "create"/"read"/"write" used to trigger this group on their own —
  // three of the most common verbs in English, so "create a goal," "read
  // this email," "write a test for the bug" each pulled in 5 unrelated file
  // tools alongside their real (and correct) domain-specific tools. Same
  // root cause as the fixed "desktop" collision, just wider: these verbs
  // now only count when they're actually near a file-shaped noun; the bare
  // nouns alone (file/folder/directory/desktop/documents/downloads/exists)
  // are specific enough on their own to keep working unqualified.
  else if(/\b(file|folder|directory|desktop|documents|downloads|exists?)\b/.test(text)||/\b(read|write|create)\b[\s\S]{0,20}\b(file|folder|directory|text file)\b/.test(text))['list_directory','read_text_file','path_exists','create_directory','write_text_file'].forEach((name)=>names.add(name));
  // A real user hit this exact wall: "open God's Eye View" (an app not on
  // any pre-approved list) was refused outright, because this trigger used
  // to require the literal word "app"/"application" or one of a fixed set
  // of named apps. open_application can now resolve ANY installed app by
  // name (real Desktop/Start Menu shortcuts on Windows, /Applications on
  // macOS — see listWindowsShortcuts()/listMacApplications() above), so the
  // trigger no longer needs a pre-approved name list either — "open/launch/
  // start X" is enough to offer the tool; its own name-resolution is what
  // actually decides whether X exists, the same way a not-found/ambiguous
  // Ring camera or Homebridge accessory name is already handled elsewhere.
  if(/\b(?:open|launch|start)\b\s+(?:up\s+)?(?:the\s+|my\s+)?\S/i.test(text))names.add('open_application');
  // "Open google.com" or "go to reddit.com" — no literal "website"/"url"/
  // "https" — was previously missed. A bare domain-looking token after an
  // open/visit/browse/go-to verb is now enough on its own.
  if(/\b(open|visit|browse|go to)\b.*\b(website|webpage|site|url|https)\b|https:\/\/|\b(?:open|visit|browse|go to)\b[^.!?]*\b[a-z0-9-]+\.(?:com|org|net|io|gov|edu|co|dev|app)\b/i.test(text))['open_web_address','browser_open'].forEach((name)=>names.add(name));
  if(/\byoutube\b/.test(text)&&/\b(search|find|look up|open|browse|play)\b/.test(text))['browser_open','browser_read','browser_click','browser_fill','browser_press'].forEach((name)=>names.add(name));
  if(/browser_(?:open|read|click|fill|press|close)|\b(browser|webpage|website|page|site)\b.*\b(read|inspect|click|button|link|fill|type|field|press|enter|close|interact|control)\b|\b(read|inspect|click|fill|type into)\b.*\b(open )?(page|site|browser|field|button|link)\b/.test(text))['browser_open','browser_read','browser_click','browser_fill','browser_press','browser_close'].forEach((name)=>names.add(name));
  if(/\b(notify|notification|alert me|let me know)\b/.test(text))names.add('show_notification');
  if(/\b(where (?:do|should) i (?:click|look|find)|point (?:to|at)|show me where|cursor guide|highlight (?:it|that|the))\b/.test(text))names.add('show_cursor_guide');
  if(/\b(gmail|email|inbox|mail message|archive message)\b/.test(text))['gmail_check','gmail_archive','gmail_send'].forEach((name)=>names.add(name));
  if(/\b(calendar|appointment|meeting|event)\b/.test(text))['calendar_list_events','calendar_create_event'].forEach((name)=>names.add(name));
  if(/\b(apple mail|mail app|compose (?:an )?email|email draft)\b/.test(text))names.add('mac_compose_mail');
  if(/\b(apple notes?|notes app|create (?:a )?note)\b/.test(text))names.add('mac_create_note');
  if(/\b(apple reminders?|reminders app|create (?:a )?reminder)\b/.test(text))names.add('mac_create_reminder');
  if(/\b(apple calendar|calendar app|mac calendar)\b/.test(text))names.add('mac_calendar_create_event');
  if(/\b(shopify|store sales|orders?|revenue)\b/.test(text))names.add('shopify_sales');
  if(/\b(meta|facebook ads?|instagram ads?|ad insights?|ad spend)\b/.test(text))names.add('meta_insights');
  if(/\b(dropbox|cloud files?)\b/.test(text))names.add('dropbox_list_folder');
  if(/\b(stripe|payments?|charges?|payouts?)\b/.test(text))names.add('stripe_payments');
  if(/\b(klaviyo|email campaigns?|marketing campaigns?)\b/.test(text))names.add('klaviyo_campaigns');
  if(/\bwhatsapp\b/.test(text))names.add('whatsapp_send_message');
  // Live failure: "unlock the back door" offered zero tools at all — bare
  // "lock"/"locks?" doesn't match "unlock" (no word boundary between "un"
  // and "lock", same class as "Unsubscribe" not matching "subscribe"
  // elsewhere in this file). Separately, "is the back door locked?" also
  // matched nothing — "locked"/"unlocked" are different words from "lock"/
  // "unlock" entirely, not just a boundary issue. Both word forms are now
  // covered.
  if(/\b(homebridge|homekit|smart[ -]?home|smart (?:lights?|locks?|switches?|devices?)|lights?|locks?|locked|unlocks?|unlocked|thermostats?|climate|garage(?: door)?|door sensors?|motion sensors?|alarm system|armed|disarmed|scenes?)\b/.test(text)){
    names.add('homebridge_snapshot');
    // A pure status question ("is the back door locked?") only ever needs a
    // read, never the control tool — offering control alongside it was
    // needless noise. Narrowing a read-only question to just the read tool
    // gives exactly one candidate, letting Axiom force it by exact name —
    // the same hard guarantee used for search — instead of the softer
    // generic "required" hint, which is exactly what a claim like "the back
    // door is unlocked" should be grounded in, not a hallucination.
    // Distinguished from an action request by looking for the bare
    // imperative verb ("lock"/"unlock", not "locked"/"unlocked") rather
    // than trying to fully parse intent.
    if(/\b(turn|set|dim|lock|unlock|open|close|arm|disarm|switch)\b/.test(text))names.add('homebridge_control');
  }
  // "Draw me a dog" / "sketch a logo" is how most people actually ask for
  // image generation; "generate/create/make/render" alone missed it.
  if(/\b(generate|create|make|render|draw|sketch|paint).{0,30}\b(image|picture|art|photo|video|clip|drawing|painting|sketch|illustration)\b|\b(image|video) generation\b/.test(text))['estimate_media_generation','generate_image','generate_video'].forEach((name)=>names.add(name));
  if(/\b(backup|back up|export axiom|save axiom data)\b/.test(text))names.add('create_verified_backup');
  // A live user asked to "place it on the desktop" (a file-system location)
  // and it collided with the bare word "desktop" here, which was meant for
  // window/screen-control intent ("what's open on my desktop"). That
  // collision offered 13 tools for a one-tool request — and with that many
  // candidates, a generic "you must call a tool" instruction turned out not
  // to be a reliable enough forcing signal (confirmed separately for
  // web_search; same root cause). "screen" already covers the legitimate
  // "what's on my screen" phrasing, so bare "desktop" is dropped here.
  // Bare "restore" collided with the project group's "checkpoint"/"rollback"
  // ("restore my checkpoint" pulled in 8 window-control tools plus 6 project
  // tools, including the destructive-tier restore_project_checkpoint, for a
  // 14-candidate request that should resolve to one). "Restore" is common
  // well outside window-management ("restore a backup," "restore my
  // project," "restore settings"), so — same fix as "desktop" before it —
  // it now only counts paired with the window/app it's meant to restore.
  if(/\b(window|windows|running apps?|screen|foreground|focus|minimize|maximize|close|quit|exit|click|press|button|menu|tab|checkbox|field|type into|fill|paste into|control (?:the )?(?:app|application)|desktop (?:app|application|window|icon|shortcut)|restore (?:the )?(?:window|app|application))\b/.test(text))['query_desktop_graph','get_desktop_graph_summary','list_running_windows','inspect_application_ui','invoke_application_control','select_application_menu','set_application_field','control_application_window'].forEach((name)=>names.add(name));
  if(/\b(clipboard|copied|copy this|copy that|pasteboard)\b/.test(text))['read_clipboard_text','write_clipboard_text'].forEach((name)=>names.add(name));
  if(/\b(volume|mute|unmute|play|pause|next track|previous track|media)\b/.test(text))names.add('control_media');
  if(/\b(build|code|coding|project|source|implement|refactor|developer|development|bug|test suite|typecheck|lint|checkpoint|rollback|revert|delete.*(?:source|file)|remove.*(?:source|file))\b/.test(text))['list_project_files','read_project_file','write_project_file','run_project_check','restore_project_checkpoint','delete_project_file'].forEach((name)=>names.add(name));
  if(/\b(powershell|terminal|command|script)\b/.test(text))['request_powershell_confirmation','execute_confirmed_powershell'].forEach((name)=>names.add(name));
  if(/\b(system|computer|hardware|cpu|processor|gpu|graphics(?: card)?|vram|ram|memory|swap|disk|storage|drive|network|battery|power|uptime|processes?|utili[sz]ation|usage|temps?|temperatures?|thermal|fan|windows version|macos version)\b/.test(text))names.add('get_system_summary');
  if(/\b(what can you do|capabilities|everything you can|all tools|control everything)\b/.test(text))registry.forEach((tool)=>names.add(tool.name));
  if(/\b(color|colour|theme|interface|ui|hud|eyes?|appearance|emotion|glow|motion|animation|density|happy|angry|excited|violet|purple|amber|orange|pink|teal|cyan|green|blue|red|white)\b/.test(text))names.add('set_companion_appearance');
  if(/\b(time|date|day is it|what day)\b/.test(text))names.add('get_local_time');
  // "God's eye view" / "gods eye view" — deliberately the full phrase, not
  // the bare word "eye(s)", which already means the companion-appearance
  // control above; only the named app's own name should trigger this.
  if(/\bgod'?s[ -]?eye([ -]?view)?\b/.test(text))names.add('open_gods_eye_view');
  if(/\bgod'?s[ -]?eye([ -]?view)?\b/.test(text)&&/\b(fly|zoom|go|look|show me|navigate|move|pan)\b/.test(text)){names.add('gods_eye_fly_to');names.add('gods_eye_set_layers');}
  if(/\b(fly to|zoom (?:in )?on|look at|navigate to)\b[\s\S]{0,40}\b(latitude|longitude|coordinates?|globe)\b/.test(text))names.add('gods_eye_fly_to');
  // A real live miss: "You gotta fly the map to St. Louis, Missouri" said
  // "map", not "globe", had no lat/lon wording, and named no live-data
  // domain word either — so it matched none of the patterns above and
  // Axiom, with genuinely zero tool offered, told the user there was no
  // map-control capability at all. A bare movement verb aimed at "the map/
  // camera/globe/view" is unambiguous on its own.
  if(/\b(fly|move|navigate|pan|zoom)\b[\s\S]{0,20}\b(the )?(map|camera|globe|view)\b/i.test(text))names.add('gods_eye_fly_to');
  // A live user asked "find me live flights over St. Louis, MO" with the
  // panel already open and got nothing — the message never says "God's Eye
  // View" at all, since it was already the obvious open context, but the
  // trigger above required the app's name on every single follow-up. These
  // words are otherwise unique to this one feature (nothing else in Axiom
  // deals with live aircraft, vessel tracking, satellites, or the rest of
  // the real layer registry — see GODS_EYE_LAYER_IDS), so they're safe to
  // trigger on without the app's name being repeated every time.
  if(/\b(live )?(flights?|aircraft|planes?|jets?|helicopters?|ships?|vessels?|boats?|satellites?|earthquakes?|military (?:aircraft|installations?|awareness)|rocket launch(?:es)?|bike ?share|submarine cables?|traffic cameras?|\bcctv\b)\b/i.test(text)&&/\b(live|track|tracking|find|show me|near|over|around|enable|turn on|turn off|disable|hide|display|watch)\b/i.test(text)){names.add('gods_eye_fly_to');names.add('gods_eye_set_layers');}
  return registry.filter((tool)=>names.has(tool.name)&&toolAvailable(tool.name)).map((tool)=>({type:'function',name:tool.name,description:tool.description,parameters:tool.parameters,strict:true}));
}

/**
 * OpenAI strict function calling requires every key in `properties` to appear in
 * `required`; an optional parameter is expressed as nullable instead. A single
 * non-conforming schema makes OpenAI reject the whole request, which takes down
 * every other tool offered in that turn.
 *
 * Applied only on the OpenAI path: Gemini's schema dialect wants `nullable:true`
 * rather than a `["string","null"]` type union, so the canonical registry schema
 * is left untouched for the other providers.
 */
export function strictToolSchema(schema:unknown):unknown{
  if(!schema||typeof schema!=='object'||Array.isArray(schema))return schema;
  const node={...schema as Record<string,unknown>};
  if(node.type==='array'&&node.items)node.items=strictToolSchema(node.items);
  const properties=node.properties as Record<string,unknown>|undefined;
  if(!properties||typeof properties!=='object')return node;
  const names=Object.keys(properties),required=Array.isArray(node.required)?node.required as string[]:[];
  const rebuilt:Record<string,unknown>={};
  for(const name of names){
    const child=strictToolSchema(properties[name]) as Record<string,unknown>;
    if(required.includes(name)){rebuilt[name]=child;continue;}
    const type=child.type;
    rebuilt[name]=typeof type==='string'&&type!=='null'?{...child,type:[type,'null']}:child;
  }
  node.properties=rebuilt;node.required=names;node.additionalProperties=false;
  return node;
}

export function permissions(): PermissionInfo[] {
  const all = [{ id:'web-search', label:'Searched live web sources', risk:'read', enabled:true } as PermissionInfo, { id:'screen-capture', label:'One-request screen vision', risk:'sensitive', enabled:true } as PermissionInfo, ...registry.filter((tool)=>toolAvailable(tool.name)).map((tool) => ({ ...tool.permission }))];
  return [...new Map(all.map((permission) => [permission.id, permission])).values()];
}

export interface CapabilityManifestItem {
  name:string;
  purpose:string;
  platforms:Array<'windows'|'macos'|'linux'>;
  permission:PermissionInfo;
  enabled:boolean;
  mutatesState:boolean;
  approval:'automatic'|'fresh-user-approval';
  verification:'structured-result-or-state-observation';
  recovery:string[];
  timeoutMs:number;
  background:boolean;
}

/** The single runtime-readable source of truth behind capability claims. */
export function capabilityManifest(store?:AppStore):CapabilityManifestItem[]{
  const backgroundTools=new Set(['create_commitment','create_agent','create_visual_monitor','show_notification']);
  return registry.filter((tool)=>toolAvailable(tool.name)).map((tool)=>{
    const platforms:Array<'windows'|'macos'|'linux'>=windowsOnlyTools.has(tool.name)?['windows']:macOnlyTools.has(tool.name)?['macos']:['windows','macos','linux'];
    const enabled=tool.permission.enabled&&Boolean(store?store.permissionEnabled(tool.permission.id,tool.permission.enabled):true),risk=toolRisk(tool.permission.risk,tool.name);
    return{name:tool.name,purpose:tool.description,platforms,permission:{...tool.permission,enabled},enabled,mutatesState:risk!=='read',approval:requiresFreshApproval(risk)?'fresh-user-approval':'automatic',verification:'structured-result-or-state-observation',recovery:risk==='read'?['Retry once after a transient failure','Report the exact unavailable sensor or permission']:['Do not replay automatically','Resume from the last verified receipt or reversible checkpoint'],timeoutMs:tool.name.includes('powershell')?30_000:20_000,background:backgroundTools.has(tool.name)};
  });
}

function explicitActionFailure(name:string,args:Record<string,unknown>,userMessage?:string):string|undefined{
  const message=userMessage||'';
  if(name==='delete_project_file'&&!/\b(delete|remove)\b/i.test(message))return'Deleting project source requires an explicit delete or remove request.';
  if(name==='restore_project_checkpoint'&&!/\b(restore|revert|roll ?back|undo)\b/i.test(message))return'Restoring code requires an explicit restore, revert, rollback, or undo request.';
  if(name==='control_application_window'&&String(args.action)==='close'&&!/\b(close|quit|exit)\b/i.test(message))return'Closing an application requires an explicit close, quit, or exit request.';
  if((name==='remove_skill'||name==='remove_agent')&&!/\b(delete|remove)\b/i.test(message))return'Removing a saved capability requires an explicit delete or remove request.';
  if(name==='homebridge_control'){
    // The tool schema types value as string|number|boolean, and models are
    // inconsistent about which one they emit for a numeric enum (e.g. "0" vs
    // 0) — a strict === against the number would let a stringified value
    // silently skip every check below, so compare on the coerced number.
    const characteristic=String(args.characteristic||''),value=Number(args.value);
    // HomeKit's own enum values: LockTargetState 0=unsecured, TargetDoorState
    // 0=open, SecuritySystemTargetState 3=disarm. Locking/closing/arming stay
    // unguarded here, same asymmetry the removed Home Assistant check had —
    // only the direction that reduces security needs an explicit verb.
    if(characteristic==='LockTargetState'&&value===0&&!/\bunlock\b/i.test(message))return'Unlocking a smart lock requires an explicit unlock request.';
    if(characteristic==='TargetDoorState'&&value===0&&!/\bopen\b/i.test(message))return'Opening a smart door or garage requires an explicit open request.';
    if(characteristic==='SecuritySystemTargetState'&&value===3&&!/\bdisarm\b/i.test(message))return'Disarming a security system requires an explicit disarm request.';
  }
  return undefined;
}

function verifyToolOutput(output:string):{method:'structured-result'|'state-observation'|'artifact-check';detail:string}{
  const value=String(output??'');if(!value.trim())throw new Error('Capability returned an empty result, so completion could not be verified.');
  if(value.trimStart().startsWith('{')||value.trimStart().startsWith('[')){
    let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new Error('Capability returned malformed structured evidence.');}
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&'error' in parsed&&typeof (parsed as {error?:unknown}).error==='string')throw new Error(String((parsed as {error:string}).error));
    const keys=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?Object.keys(parsed as Record<string,unknown>).slice(0,8):[];
    return{method:/file|project|backup|media/.test(keys.join(' '))?'artifact-check':'structured-result',detail:keys.length?`Validated structured fields: ${keys.join(', ')}.`:'Validated structured capability result.'};
  }
  return{method:'state-observation',detail:`Validated a non-empty ${Buffer.byteLength(value,'utf8')}-byte observation.`};
}

const transientToolFailure=(reason:unknown):boolean=>/\b(?:temporar|timed? out|timeout|busy|disconnected|connection reset|econnreset|econnrefused|network|resource unavailable|try again)\b/i.test(reason instanceof Error?reason.message:String(reason));

export async function executeTool(name: string, args: Record<string, unknown>, store?: AppStore, userMessage?: string): Promise<{ output: string; event: ToolEvent }> {
  const tool = registry.find((candidate) => candidate.name === name);
  const actionId=crypto.randomUUID();
  if (!tool || !toolAvailable(name) || !tool.permission.enabled || (store&&typeof store.permissionEnabled==='function'&&!store.permissionEnabled(tool.permission.id,tool.permission.enabled))) {
    return { output: JSON.stringify({ error: 'Tool unavailable or disabled' }), event: { name, status: 'blocked', summary: 'Tool was unavailable or disabled.', at: new Date().toISOString(),actionId,risk:'sensitive',reversible:false } };
  }
  const explicitFailure=explicitActionFailure(name,args,userMessage);if(explicitFailure)return{output:JSON.stringify({error:explicitFailure}),event:{name,status:'failed',summary:explicitFailure,at:new Date().toISOString(),actionId,permissionId:tool.permission.id,risk:toolRisk(tool.permission.risk,name,args),reversible:false}};
  const risk=toolRisk(tool.permission.risk,name,args);const reversible=/^(write_project_file|delete_project_file)$/.test(name);let approvalId:string|undefined;
  if(requiresFreshApproval(risk)){
    const authorized=store?.authorizeApproval(name,args,userMessage);
    if(!authorized){
      if(!store)return{output:JSON.stringify({error:'Runtime approval service unavailable.'}),event:{name,status:'blocked',summary:'Runtime approval service unavailable.',at:new Date().toISOString(),actionId,permissionId:tool.permission.id,risk,reversible:false}};
      const rehearsal=approvalPreview(name,args),approval=store.requestApproval(name,args,risk,rehearsal.preview,rehearsal.recovery);
      return{output:JSON.stringify({waitingForApproval:true,approval:{id:approval.id,code:approval.code,risk:approval.risk,preview:approval.preview,recovery:approval.recovery,expiresAt:approval.expiresAt},instruction:`Ask the user to review the exact action and say APPROVE ${approval.code}, or use the CORE approval queue.`}),event:{name,status:'blocked',summary:`${approval.code} awaiting approval · ${approval.preview}`,at:new Date().toISOString(),actionId,approvalId:approval.id,permissionId:tool.permission.id,risk,reversible}};
    }
    approvalId=authorized.id;
  }
  const base={actionId,approvalId,permissionId:tool.permission.id,risk,reversible};let attempts=0,lastError:unknown;
  const maxAttempts=risk==='read'?2:1;
  while(attempts<maxAttempts){
    attempts+=1;
    try {
      const result = await tool.execute(args, store, userMessage),verification=verifyToolOutput(result.output);
      const completedAt=new Date().toISOString();
      try{store?.observeDesktopTool(name,args,result.output,completedAt);}catch{/* desktop perception must never invalidate a successful action */}
      const resultDigest=crypto.createHash('sha256').update(result.output).digest('hex'),recovered=attempts>1;
      return { output: result.output, event: { name, status: 'verified', summary: `${tool.permission.label}${recovered?' · recovered after a transient failure':''}`, at: completedAt,evidenceId:crypto.randomUUID(),resultDigest,attempts,recovered,verification:{...verification,checkedAt:completedAt},...base, uiCommand: result.uiCommand } };
    } catch (error) {
      lastError=error;if(attempts>=maxAttempts||!transientToolFailure(error))break;
      await new Promise((resolve)=>setTimeout(resolve,180));
    }
  }
  const summary = lastError instanceof Error ? lastError.message : 'Tool failed';
  return { output: JSON.stringify({ error: summary }), event: { name, status: 'failed', summary, at: new Date().toISOString(),attempts,recovered:false,...base } };
}
