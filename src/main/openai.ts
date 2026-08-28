import type { AIProvider, AssistantReply, AssistantRequest, ToolEvent } from '../shared/contracts';
import { approvalCodeFromMessage, deterministicActionRoute, deterministicReadRoute, executeTool, providerTools, requiresLiveWeb, requiresToolUse, strictToolSchema } from './tools';
import type { AppStore } from './store';

// providerTools() offers exactly one of these for any given live-research
// message (see tools.ts) — never both — specifically so a real failure could
// be fixed here: a generic "you must call a tool" instruction (tool_choice
// 'required'/'any') was silently ignored by the model for some requests,
// confirmed via the app's own runtime task ledger showing zero tool
// execution despite 'required' being set. Forcing one exact tool by name is
// a harder, API-level constraint on all three providers than a generic
// hint, and having exactly one candidate is what makes forcing "this one,
// by name" possible instead of an ambiguous "any of these."
const LIVE_RESEARCH_TOOLS=new Set(['web_search','get_news_headlines']);
const liveResearchToolName=(tools:Record<string,unknown>[]):string|undefined=>tools.find((tool)=>LIVE_RESEARCH_TOOLS.has(String(tool.name||'')))?.name as string|undefined;
// Same fix, generalized: a live "create a new folder" request offered 5
// plausible file tools (a separate keyword-overlap bug, fixed in tools.ts)
// and hit the identical "model ignores generic required" failure. Whenever
// exactly one tool is on the table for a mandatory request — for any
// reason, not just live research — force that one by exact name.
const soleToolName=(tools:Record<string,unknown>[]):string|undefined=>tools.length===1?tools[0]?.name as string|undefined:undefined;

interface OpenAIResponse {
  id?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
    status?: string;
    action?: { sources?: Array<{ url?: string; title?: string }> };
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string; title?: string }>;
    }>;
  }>;
  error?: { message?: string };
}

interface VerifiedPreflight {name:string;output:string;event:ToolEvent}
const preflightContext=(preflight?:VerifiedPreflight)=>preflight?`\n\nAxiom reliability preflight already executed ${preflight.name}. Its ${preflight.event.status} result follows. Do not call that capability again; answer from this verified evidence and clearly report a real failure if present:\n${preflight.output.slice(0,120_000)}`:'';

const baseInstructions = `You are Axiom, a private cross-device companion and coding partner. You are software, not conscious. Be useful, direct, and plainly consistent — prioritize being predictable and easy to trust over sounding varied or performing warmth. You are an operating assistant, not a chatbot trapped in a text box: whenever the user asks you to search, inspect, remember, create, change, open, control, build, or otherwise act and a relevant tool is offered, call that tool before replying. Never replace an available tool call with instructions for the user to do the task manually, and never say you lack web, file, application, or computer access when the corresponding tool is present. Never claim an action succeeded unless a tool result verifies it. Never invent live facts; for current or changing information, use live search and ground the answer in sources. The user owns their data and remains in control. Memory is governed: save only when the user explicitly asks, classify the record accurately, retrieve rather than guess, supersede an incorrect memory instead of silently rewriting history, and permanently forget a record when explicitly requested. If you promise future work, a follow-up, monitoring, or anything that cannot be finished in the current turn, call create_commitment so the promise is durable; resolve it only after a verified outcome, and never imply that background work is happening unless an actual scheduled or running system confirms it. Axiom's Permission Kernel enforces one-time approval for destructive and external actions. When a tool returns waitingForApproval, clearly state the exact preview, recovery information, expiry, and approval code; do not retry, weaken, or bypass it. The user can approve from CORE or say APPROVE followed by that exact code. For coding work, inventory the configured Build Lab, read every relevant source file before editing, make the smallest coherent change, use the automatic checkpoint returned by each write, and run the project's real tests or build before claiming success. Report changed files, checks, and checkpoint IDs. Never edit generated dependencies or checkpoint storage. For computer control, inventory the live applications first when the target may be ambiguous, use only tools actually offered on this operating system, perform only the action the user requested, and use returned verification. Never type credentials, approve security prompts, purchase anything, or send external messages without a fresh explicit confirmation. If you believe a request is a mistake — likely to cause a worse outcome than the user intends, based on something they may not have considered — say so plainly before proceeding: begin that reply with CONCERN: followed by the specific reason, then either comply once you have said it or explain what you would do instead. This is not a refusal mechanism and must never be used to avoid a legitimate request; it exists so disagreement is visible instead of buried in a hedge or silently complied with.`;

// Was a randomly rotated set of "sound varied" personality instructions.
// Replaced with one stable directive: consistency was chosen deliberately
// over performed variety, so the same kind of request gets recognizably the
// same kind of answer, not a personality roll per turn.
const conversationMode=():string=>'Answer plainly and concisely; do not perform warmth or variety for its own sake.';

const capabilityInstructions = (mandatory:boolean, live:boolean):string => `${live?' This request requires current information. You MUST execute live web search before answering, use the returned evidence, and include source links. Do not answer from memory and do not claim that live access is unavailable.':''}${mandatory?' This is an action request. You MUST use at least one offered capability before your final answer. If execution is blocked, report the real tool or permission result instead of pretending the request is impossible.':''}`;

export function normalizeActionReply(text:string,events:ToolEvent[],mandatory:boolean):string{
  const clean=text.trim();
  const approval=events.find((event)=>event.status==='blocked'&&event.approvalId);
  if(approval)return `BLOCKED: ${approval.summary}\nNEEDED: Review the exact action in CORE and approve or deny it.\nCOMPLETED SO FAR: No consequential action was executed.\nNEXT ACTION: Approve the displayed one-time request if you want Axiom to continue.`;
  const blocked=events.find((event)=>event.status==='blocked');
  if(blocked)return `BLOCKED: ${blocked.summary}\nNEEDED: Restore the reported capability or permission.\nCOMPLETED SO FAR: ${events.some((event)=>event.status==='verified')?'Some earlier steps have verified receipts.':'No requested computer action was verified.'}\nNEXT ACTION: Fix the reported condition, then resume the task from CORE.`;
  const unresolved=events.filter((event)=>event.status==='failed'&&!events.some((candidate)=>candidate.status==='verified'&&candidate.name===event.name&&Date.parse(candidate.at)>=Date.parse(event.at)));
  if(unresolved.length)return `BLOCKED: ${unresolved.map((event)=>event.summary).join(' | ').slice(0,800)}\nNEEDED: A working capability route for the failed step.\nCOMPLETED SO FAR: ${events.filter((event)=>event.status==='verified').length} action(s) have verified receipts.\nNEXT ACTION: Inspect capability health and retry through a safe alternate route.`;
  if(mandatory&&!events.some((event)=>event.status==='verified'))return 'BLOCKED: This request required a computer action, but no capability produced verified evidence.\nNEEDED: An available tool route that can perform and verify the requested action.\nCOMPLETED SO FAR: No computer action was marked complete.\nNEXT ACTION: Replan with the capability registry instead of answering from the model alone.';
  return clean||'The response ended without readable output. No unverified completion has been recorded.';
}

// Disagreement and uncertainty are surfaced from real signals, not a
// self-reported confidence score — that would itself be exactly the kind of
// unverified claim Axiom's honesty rules forbid. 'concern' comes from an
// explicit CONCERN: marker the model is instructed to use when it believes a
// request is a mistake (see baseInstructions); the marker is stripped before
// display. 'uncertain' comes from hedging language landing with zero
// verified tool evidence behind it — the model saying it doesn't know, and
// nothing in the transcript proving otherwise.
// Apostrophe class ['’] over a bare '? — a straight-quote-only pattern
// silently misses real model output that uses a curly apostrophe (a real
// past model reply used ’, not ').
const hedgePattern=/\b(i['’]?m not sure|i don['’]?t know|i can(?:no|['’])?t confirm|uncertain|not certain|may not be accurate|i don['’]?t have enough information|hard to say|no way (?:for me )?to verify)\b/i;

export function finalizeReplyTone(text:string,events:ToolEvent[]):{text:string;tone?:'concern'|'uncertain'}{
  const concernMatch=/^\s*CONCERN:\s*/i.exec(text);
  if(concernMatch)return{text:text.slice(concernMatch[0].length).trim(),tone:'concern'};
  if(hedgePattern.test(text)&&!events.some((event)=>event.status==='verified'))return{text,tone:'uncertain'};
  return{text};
}

function transcriptText(text:string):string {
  return text.replace(/\n\nCamera context:\s*Describe only what is actually visible; if an action is uncertain, say so\.?$/i,'').trim();
}

function recentTranscript(input:AssistantRequest):string {
  if(input.untrustedPresence)return '';
  return input.history.slice(-8).map((message)=>`${message.role==='user'?'User':'Axiom'}: ${transcriptText(message.text).slice(0,1200)}`).join('\n');
}

async function identityAndMemoryContext(store:AppStore,input?:AssistantRequest):Promise<string>{
  const people=store.knownPeople(),speakers=store.speakerProfiles(),now=Date.now();
  const personMemories=store.memories().filter((item)=>item.status==='active'&&item.kind==='person').slice(-8);
  const relevant=input?.message?(await store.searchMemories(input.message)).filter((item)=>item.status==='active').slice(0,6):[];
  const memories=[...new Map([...personMemories,...relevant].map((item)=>[item.id,item])).values()];
  const face=input?.identity?.face,faceProfile=face&&people.find((person)=>person.name.toLowerCase()===face.name.trim().toLowerCase());
  const faceFresh=Boolean(faceProfile&&Number.isFinite(Date.parse(face!.observedAt))&&now-Date.parse(face!.observedAt)<15_000);
  const speaker=input?.identity?.speaker,speakerProfile=speaker&&speakers.find((profile)=>profile.name.toLowerCase()===speaker.name.trim().toLowerCase());
  const speakerFresh=Boolean(speakerProfile&&Number.isFinite(Date.parse(speaker!.verifiedAt))&&now-Date.parse(speaker!.verifiedAt)<30_000);
  const current=[faceFresh?`FACE VERIFIED: ${faceProfile!.name} (${Math.round(Math.max(0,Math.min(1,face!.confidence))*100)}% confidence)`:'',speakerFresh?`VOICE VERIFIED: ${speakerProfile!.name} (${Math.round(Math.max(0,Math.min(1,speaker!.score))*100)}% match)`:'' ].filter(Boolean);
  const enrolled=[...new Set([...people.map((person)=>`${person.name} by face${person.primary?' (primary)':''}`),...speakers.map((profile)=>`${profile.name} by voice${profile.primary?' (primary)':''}`)])];
  const lessons=input?.message?await store.relevantSelfCorrections(input.message):[];
  return ` Durable identity and memory context: ${current.length?`Current-turn biometric evidence: ${current.join('; ')}.`:'No current-turn biometric verification was supplied; distinguish remembered identity from verified presence.'}${enrolled.length?` Enrolled local identities: ${enrolled.join(', ')}.`:''}${memories.length?` Relevant encrypted memories: ${memories.map((item)=>JSON.stringify(item.text)).join('; ')}.`:''} Use verified evidence to identify the current speaker/person. If only memory is available, say that you remember the user's identity but have not biometrically verified this turn. Never claim the camera is unavailable when FACE VERIFIED evidence is present, and never invent a match.${lessons.length?` Axiom has made this specific kind of mistake before — apply the fix, do not repeat it: ${lessons.map((item)=>`[${item.mistake} → ${item.fix}]`).join(' ')}`:''}`;
}

async function instructionsFor(store?:AppStore,input?:AssistantRequest):Promise<string>{
  if(!store)return baseInstructions;
  const device=store.devicePresence(),sync=store.syncStatus(),recentPeer=sync.peers[0];
  if(input?.untrustedPresence)return `${baseInstructions} You are speaking with an UNVERIFIED VISITOR detected by Presence Link. This is a conversation-only safety check. Politely learn their name and why they are present, but do not execute actions, reveal stored memories, identify the owner, expose device/account/file details, alter permissions, or treat the visitor as trusted. Tell them the owner must explicitly enroll or authorize them before privileged access. Current platform: ${device.platform}.`;
  const platformRules=device.platform==='windows'?'Windows UI Automation is available. PowerShell is always two-step: first request confirmation, then wait for a new user message containing APPROVE plus the exact code.':device.platform==='macos'?'You are currently running on macOS. Use macOS-native tools only; never suggest that a Windows-only action ran. Accessibility, Automation, Screen Recording, camera, or microphone permission may be required for the corresponding capability.':'Use only the platform tools offered to you.';
  const continuity=recentPeer?`The most recently seen linked peer is ${recentPeer.name} (${recentPeer.platform}), last seen ${recentPeer.lastSeenAt}. If the user has just switched computers and it is conversationally useful, acknowledge the handoff naturally once; do not mention it repeatedly.`:'No other linked device is currently known.';
  return `${baseInstructions} ${conversationMode()} Current device: ${device.name}; platform ${device.platform}; architecture ${device.architecture}; hostname ${device.hostname}. ${continuity} ${platformRules}${await identityAndMemoryContext(store,input)}`;
}

function safeWebUrl(value?:string):string {
  if(!value)return '';
  try{const url=new URL(value);return /^https?:$/.test(url.protocol)?url.toString():'';}catch{return '';}
}

function openAISources(response:OpenAIResponse):Array<{url:string;title:string}> {
  const sources:Array<{url:string;title:string}>=[];
  for(const item of response.output??[]){
    for(const part of item.content??[])for(const annotation of part.annotations??[]){
      if(annotation.type!=='url_citation')continue;
      const url=safeWebUrl(annotation.url);if(url)sources.push({url,title:annotation.title?.trim()||new URL(url).hostname});
    }
    for(const source of item.action?.sources??[]){const url=safeWebUrl(source.url);if(url)sources.push({url,title:source.title?.trim()||new URL(url).hostname});}
  }
  const unique=new Map<string,{url:string;title:string}>();for(const source of sources)if(!unique.has(source.url))unique.set(source.url,source);
  return [...unique.values()].slice(0,8);
}

function appendSources(text:string,sources:Array<{url:string;title:string}>):string {
  const unseen=sources.filter((source)=>!text.includes(source.url));
  if(!unseen.length)return text.trim();
  return `${text.trim()}\n\nSources:\n${unseen.map((source)=>`- ${source.title}: ${source.url}`).join('\n')}`;
}

function outputText(response: OpenAIResponse): string {
  const text=response.output_text?.trim()||(response.output ?? []).flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text' && part.text).map((part) => part.text).join('\n').trim();
  return appendSources(text,openAISources(response));
}

function userContent(text: string, imageDataUrl?: string): string | Array<Record<string, string>> {
  if (!imageDataUrl) return text;
  if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(imageDataUrl) || imageDataUrl.length > 10_000_000) throw new Error('The attached screen capture is invalid or too large.');
  return [{ type: 'input_text', text }, { type: 'input_image', image_url: imageDataUrl, detail: 'low' }];
}

function imagePayload(imageDataUrl?:string):{mediaType:string;data:string}|undefined{
  if(!imageDataUrl)return undefined;const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(imageDataUrl);
  if(!match||imageDataUrl.length>10_000_000)throw new Error('The attached screen capture is invalid or too large.');return{mediaType:match[1].toLowerCase(),data:match[2]};
}

async function request(key: string, body: Record<string, unknown>): Promise<OpenAIResponse> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal:AbortSignal.timeout(90_000),
  });
  const data = await response.json() as OpenAIResponse;
  if (!response.ok) throw new Error(data.error?.message || `OpenAI request failed (${response.status})`);
  return data;
}

async function requestStreaming(key: string, body: Record<string, unknown>, onDelta: (delta: string) => void): Promise<OpenAIResponse> {
  const response = await fetch('https://api.openai.com/v1/responses', { method:'POST', headers:{'content-type':'application/json',authorization:`Bearer ${key}`}, body:JSON.stringify({...body,stream:true}),signal:AbortSignal.timeout(90_000) });
  if (!response.ok) { const data=await response.json() as OpenAIResponse; throw new Error(data.error?.message||`OpenAI request failed (${response.status})`); }
  if (!response.body) throw new Error('OpenAI returned no response stream.');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',text='',completed:OpenAIResponse|undefined;
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const events=buffer.split('\n\n');buffer=events.pop()||'';for(const event of events){const dataLine=event.split('\n').find((line)=>line.startsWith('data:'));if(!dataLine)continue;const raw=dataLine.slice(5).trim();if(!raw||raw==='[DONE]')continue;try{const item=JSON.parse(raw) as {type?:string;delta?:string;response?:OpenAIResponse;error?:{message?:string}};if(item.type==='response.output_text.delta'&&item.delta){text+=item.delta;onDelta(item.delta);}if(item.type==='response.completed'&&item.response)completed=item.response;if(item.type==='error')throw new Error(item.error?.message||'OpenAI stream failed.');}catch(error){if(error instanceof SyntaxError)continue;throw error;}}}
  return completed ?? { output_text:text };
}

async function runOpenAI(key: string, model: string, input: AssistantRequest, store?: AppStore, onDelta: (delta: string) => void = () => {},preflight?:VerifiedPreflight): Promise<AssistantReply> {
  if (!key) throw new Error('Add an OpenAI API key in Settings.');
  const transcript = recentTranscript(input);
  const firstInput = `${transcript ? `Conversation so far:\n${transcript}\n\n` : ''}User: ${input.message}${preflightContext(preflight)}`;
  const tools = (input.untrustedPresence?[]:providerTools(input.message,store))
    .filter((tool)=>tool.name!==preflight?.name)
    .map((tool)=>tool.type==='function'?{...tool,parameters:strictToolSchema(tool.parameters)}:tool);
  // web_search is a real function tool now (see tools.ts), executed by
  // Axiom's own code — not a provider-hosted tool type. liveResearch still
  // drives the "you must search" prompt instruction; actual verification
  // that the search happened is the same generic toolEvents check every
  // other tool gets, since a real executeTool() call produces a real
  // 'verified' or 'failed' ToolEvent — no more provider-specific success
  // tracking needed.
  const researchTool = liveResearchToolName(tools);
  const liveResearch = requiresLiveWeb(input.message) && Boolean(researchTool);
  const mandatoryTool = !preflight&&requiresToolUse(input.message, tools);
  const codingRequest = tools.some((tool) => ['list_project_files','read_project_file','write_project_file','run_project_check','restore_project_checkpoint','delete_project_file'].includes(String(tool.name || '')));
  const toolEvents: ToolEvent[] = preflight?[preflight.event]:[];
  const conversation: Array<Record<string, unknown>> = [{ role: 'user', content: userContent(firstInput, input.imageDataUrl) }];
  const forceTool = mandatoryTool ? (researchTool||soleToolName(tools)) : undefined;
  const body = { model, instructions: `${await instructionsFor(store,input)}${capabilityInstructions(mandatoryTool,liveResearch)} Complete every requested step before replying. For multi-step tasks, continue using tools until every step has a verified result.`, input: conversation, ...(tools.length?{tools}:{}), ...(forceTool?{tool_choice:{type:'function',name:forceTool}}:mandatoryTool?{tool_choice:'required'}:{}), reasoning: { effort: codingRequest ? 'low' : 'none' }, max_output_tokens: codingRequest ? 6000 : 1200, store: false };
  // Only the very first request can have tool_choice forced (a specific
  // function name, or 'required') — that round exists purely to make the
  // model call a tool and may interleave stray preamble text with the
  // call, so its deltas are buffered rather than shown live. Every round
  // after that uses tool_choice:'auto': the model is choosing freely
  // whether to speak or act, so its text is the real, final answer and
  // should stream to the user as it's generated instead of waiting for
  // the whole reply to finish — previously every round reused the same
  // buffering emit, so ANY mandatory-tool request (weather, news, most
  // actions) silently never streamed at all, dumping the full answer in
  // one shot no matter how long it took to generate.
  let buffered='';const bufferedEmit=(delta:string)=>{buffered+=delta;};
  let response = await requestStreaming(key, body, mandatoryTool?bufferedEmit:onDelta);

  for (let round = 0; round < 16; round += 1) {
    const calls = (response.output ?? []).filter((item) => item.type === 'function_call' && item.name && item.call_id);
    if (!calls.length) break;
    const outputs = [];
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.arguments || '{}') as Record<string, unknown>; } catch { args = {}; }
      const result = await executeTool(call.name!, args, store, input.message);
      toolEvents.push(result.event);
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: result.output });
    }
    conversation.push(...(response.output ?? []), ...outputs);
    response = await requestStreaming(key, { ...body, input: conversation, tool_choice:'auto' }, onDelta);
  }

  const rawText=outputText(response);
  // web_search's real ToolEvent (verified or failed, with the real error
  // message from webSearch.ts) is already in toolEvents from the loop above
  // — no separate provider-specific "did the hosted tool succeed" tracking
  // needed anymore.
  // A live failure showed the model correctly attempting the search, the
  // search tool itself genuinely failing (a real network/parse error), and
  // the model honestly telling the user it couldn't get reliable data —
  // exactly the behavior this app wants. That got thrown away here anyway,
  // because this used to treat "the tool ran and failed" identically to
  // "the model never even tried" and hard-blocked both the same way,
  // turning an already-delivered, honest, correctly-caveated answer into a
  // scary top-level "AI providers unavailable" error instead of just
  // letting it stand. Only block the case that's actually dangerous: the
  // tool never being attempted at all (the model silently skipping the
  // requirement). A tool that ran and failed already produced a real,
  // honest ToolEvent — normalizeActionReply below is what keeps the reply
  // text honest about that, not a hard exception here.
  const searchEvent=toolEvents.find((event)=>LIVE_RESEARCH_TOOLS.has(event.name));
  if(liveResearch&&!searchEvent)throw new Error('The required live web search was never attempted.');
  if(mandatoryTool&&!toolEvents.length)throw new Error('OpenAI did not execute the required Axiom capability.');
  if(buffered)onDelta(buffered);
  const finalized=finalizeReplyTone(normalizeActionReply(rawText,toolEvents,mandatoryTool),toolEvents);
  return { text: finalized.text, provider: 'openai', model, toolEvents, tone: finalized.tone };
}

interface AnthropicBlock { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
interface AnthropicResponse { content?: AnthropicBlock[]; error?: { message?: string } }

// web_search is a normal function tool now (see tools.ts) — no more
// Anthropic-hosted web_search_20250305 server tool needed; it flows through
// the same function-tool mapping as everything else.
function anthropicTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  return tools.filter((tool) => tool.type === 'function').map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}

async function anthropicRequest(key: string, body: Record<string, unknown>): Promise<AnthropicResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'}, body:JSON.stringify(body),signal:AbortSignal.timeout(90_000) });
  const data = await response.json() as AnthropicResponse;
  if (!response.ok) throw new Error(data.error?.message || `Anthropic request failed (${response.status})`);
  return data;
}

async function runAnthropic(key: string, model: string, input: AssistantRequest, store?: AppStore, onDelta: (delta: string) => void = () => {},preflight?:VerifiedPreflight): Promise<AssistantReply> {
  if (!key) throw new Error('Add an Anthropic API key in Settings.');
  const transcript=recentTranscript(input);
  const first=`${transcript?`Conversation so far:\n${transcript}\n\n`:''}User: ${input.message}${preflightContext(preflight)}`;
  const toolDefinitions=(input.untrustedPresence?[]:providerTools(input.message,store)).filter((tool)=>tool.name!==preflight?.name); const tools=anthropicTools(toolDefinitions); const toolEvents:ToolEvent[]=preflight?[preflight.event]:[];
  const researchTool=liveResearchToolName(toolDefinitions);
  const liveResearch=requiresLiveWeb(input.message)&&Boolean(researchTool);const mandatoryTool=!preflight&&requiresToolUse(input.message,toolDefinitions);
  const image=imagePayload(input.imageDataUrl);const firstContent=image?[{type:'text',text:first},{type:'image',source:{type:'base64',media_type:image.mediaType,data:image.data}}]:first;
  const messages:Array<Record<string,unknown>>=[{role:'user',content:firstContent}];
  const forceTool=mandatoryTool?(researchTool||soleToolName(toolDefinitions)):undefined;
  const system=`${await instructionsFor(store,input)}${capabilityInstructions(mandatoryTool,liveResearch)}`;let response=await anthropicRequest(key,{model,max_tokens:6000,system,messages,...(tools.length?{tools}: {}),...(forceTool?{tool_choice:{type:'tool',name:forceTool}}:mandatoryTool?{tool_choice:{type:'any'}}:{})});
  for(let round=0;round<16;round+=1){
    const calls=(response.content??[]).filter((part)=>part.type==='tool_use'&&part.id&&part.name);
    if(!calls.length)break;
    const results=[];
    for(const call of calls){const result=await executeTool(call.name!,call.input??{},store,input.message);toolEvents.push(result.event);results.push({type:'tool_result',tool_use_id:call.id,content:result.output});}
    messages.push({role:'assistant',content:response.content??[]},{role:'user',content:results});
    response=await anthropicRequest(key,{model,max_tokens:6000,system,messages,...(tools.length?{tools}: {})});
  }
  const text=(response.content??[]).filter((part)=>part.type==='text'&&part.text).map((part)=>part.text).join('\n').trim();
  // See the matching comment in runOpenAI above: only block a search that
  // was never attempted, not one that ran and genuinely failed — the
  // latter already produced a real ToolEvent and an honest reply via
  // normalizeActionReply below, not something to discard with an error.
  const searchEvent=toolEvents.find((event)=>LIVE_RESEARCH_TOOLS.has(event.name));
  if(liveResearch&&!searchEvent)throw new Error('The required live web search was never attempted.');
  if(mandatoryTool&&!toolEvents.length)throw new Error('Anthropic did not execute the required Axiom capability.');
  const normalized=normalizeActionReply(text,toolEvents,mandatoryTool);const finalized=finalizeReplyTone(normalized,toolEvents);onDelta(finalized.text); return {text:finalized.text,provider:'anthropic',model,toolEvents,tone:finalized.tone};
}

interface GeminiPart { text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }
interface GeminiResponse { candidates?: Array<{ content?: { role?: string; parts?: GeminiPart[] }; groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: unknown[] } }>; error?: { message?: string } }

// web_search is a normal function tool now (see tools.ts) — no more
// Gemini-hosted googleSearch grounding tool needed; it flows through the
// same function declarations as everything else, and can be forced with
// toolConfig like any other function (native googleSearch grounding could
// not be combined with forced function-calling mode; a plain function tool
// has no such restriction).
function geminiTools(tools:Record<string,unknown>[]):Record<string,unknown>[] {
  const declarations=tools.filter((tool)=>tool.type==='function').map((tool)=>({name:tool.name,description:tool.description,parameters:tool.parameters}));
  return declarations.length?[{functionDeclarations:declarations}]:[];
}

async function geminiRequest(key:string,model:string,body:Record<string,unknown>):Promise<GeminiResponse>{
  const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(90_000)});
  const data=await response.json() as GeminiResponse;if(!response.ok)throw new Error(data.error?.message||`Gemini request failed (${response.status})`);return data;
}

async function runGemini(key:string,model:string,input:AssistantRequest,store?:AppStore,onDelta:(delta:string)=>void=()=>{},preflight?:VerifiedPreflight):Promise<AssistantReply>{
  if(!key)throw new Error('Add a Google Gemini API key in Settings.');
  const transcript=recentTranscript(input);
  const toolDefinitions=(input.untrustedPresence?[]:providerTools(input.message,store)).filter((tool)=>tool.name!==preflight?.name);const tools=geminiTools(toolDefinitions);const toolEvents:ToolEvent[]=preflight?[preflight.event]:[];
  const researchTool=liveResearchToolName(toolDefinitions);
  const liveResearch=requiresLiveWeb(input.message)&&Boolean(researchTool);const mandatoryTool=!preflight&&requiresToolUse(input.message,toolDefinitions);
  const image=imagePayload(input.imageDataUrl);const firstParts:Array<Record<string,unknown>>=[{text:`${transcript?`Conversation so far:\n${transcript}\n\n`:''}User: ${input.message}${preflightContext(preflight)}`}];if(image)firstParts.push({inlineData:{mimeType:image.mediaType,data:image.data}});
  const contents:Array<Record<string,unknown>>=[{role:'user',parts:firstParts}];
  const forceTool=mandatoryTool?(researchTool||soleToolName(toolDefinitions)):undefined;
  const system=`${await instructionsFor(store,input)}${capabilityInstructions(mandatoryTool,liveResearch)}`;const forceFunctions=mandatoryTool&&toolDefinitions.some((tool)=>tool.type==='function');let response=await geminiRequest(key,model,{systemInstruction:{parts:[{text:system}]},contents,...(tools.length?{tools}: {}),...(forceTool?{toolConfig:{functionCallingConfig:{mode:'ANY',allowedFunctionNames:[forceTool]}}}:forceFunctions?{toolConfig:{functionCallingConfig:{mode:'ANY'}}}:{})});
  for(let round=0;round<16;round+=1){
    const modelContent=response.candidates?.[0]?.content;const calls=(modelContent?.parts??[]).filter((part)=>part.functionCall?.name);
    if(!calls.length)break;if(modelContent)contents.push({role:'model',parts:modelContent.parts});
    const parts=[];for(const call of calls){const fn=call.functionCall!;const result=await executeTool(fn.name!,fn.args??{},store,input.message);toolEvents.push(result.event);parts.push({functionResponse:{name:fn.name,response:{result:result.output}}});}
    contents.push({role:'user',parts});response=await geminiRequest(key,model,{systemInstruction:{parts:[{text:system}]},contents,...(tools.length?{tools}: {})});
  }
  const text=(response.candidates?.[0]?.content?.parts??[]).map((part)=>part.text??'').join('\n').trim();
  // See the matching comment in runOpenAI above: only block a search that
  // was never attempted, not one that ran and genuinely failed.
  const searchEvent=toolEvents.find((event)=>LIVE_RESEARCH_TOOLS.has(event.name));
  if(liveResearch&&!searchEvent)throw new Error('The required live web search was never attempted.');
  if(mandatoryTool&&!toolEvents.length)throw new Error('Gemini did not execute the required Axiom capability.');
  const normalized=normalizeActionReply(text,toolEvents,mandatoryTool);const finalized=finalizeReplyTone(normalized,toolEvents);onDelta(finalized.text);return{text:finalized.text,provider:'gemini',model,toolEvents,tone:finalized.tone};
}

export async function runAssistant(key:string,provider:AIProvider,model:string,input:AssistantRequest,store?:AppStore,onDelta:(delta:string)=>void=()=>{}):Promise<AssistantReply>{
  let preflight:VerifiedPreflight|undefined;
  if(store&&!input.untrustedPresence){
    const approvalCode=approvalCodeFromMessage(input.message);
    if(approvalCode){
      const payload=store.approvalPayload(approvalCode);
      if(!payload){
        const text=`I don't have a pending approval matching ${approvalCode} — it may already be approved, denied, or expired. Ask me to do the action again if you still want it done.`;
        onDelta(text);return{text,provider,model,toolEvents:[]};
      }
      // executeTool re-runs the same requiresFreshApproval → authorizeApproval
      // check it did the first time; passing the original stored args back
      // with this message (which contains the matching APPROVE phrase) is
      // what lets that check succeed on this second pass.
      const result=await executeTool(payload.toolName,payload.args,store,input.message);
      const text=normalizeActionReply(`Approved. ${payload.preview}`,[result.event],true);
      onDelta(text);return{text,provider,model,toolEvents:[result.event]};
    }
    const action=deterministicActionRoute(input.message);
    if(action){
      const result=await executeTool(action.name,action.args,store,input.message),text=normalizeActionReply(action.successText,[result.event],true);
      onDelta(text);return{text,provider,model,toolEvents:[result.event]};
    }
    const route=deterministicReadRoute(input.message,store);if(route){const result=await executeTool(route.name,route.args,store,input.message);preflight={name:route.name,output:result.output,event:result.event};}
  }
  if(provider==='anthropic')return runAnthropic(key,model,input,store,onDelta,preflight);
  if(provider==='gemini')return runGemini(key,model,input,store,onDelta,preflight);
  return runOpenAI(key,model,input,store,onDelta,preflight);
}

export const responseTextForTest = outputText;
export const userContentForTest = userContent;
export const anthropicToolsForTest = anthropicTools;
export const geminiToolsForTest = geminiTools;
export const identityAndMemoryContextForTest = identityAndMemoryContext;
export const transcriptTextForTest = transcriptText;
export const recentTranscriptForTest = recentTranscript;
export const liveResearchToolNameForTest = liveResearchToolName;
export const soleToolNameForTest = soleToolName;
