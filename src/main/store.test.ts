import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Models the real failure precisely: Electron safeStorage is bound to a
// per-profile os_crypt key, so ciphertext written on one machine cannot be read
// on another. Flipping `machineKey` simulates moving to a different computer.
let machineKey = 'machine-A';
let userData = '';

vi.mock('electron', () => ({
  // getAppPath points at this repo's own root so embedText() (used by real
  // memory tests below) loads the actual bundled all-MiniLM-L6-v2 model
  // from dist-renderer/models, the same path the packaged app resolves.
  app: { getPath: (name: string) => (name === 'userData' ? userData : userData), getVersion: () => '3.0.5', getAppPath: () => path.join(__dirname, '..', '..') },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`${machineKey}::${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8'), prefix = `${machineKey}::`;
      if (!text.startsWith(prefix)) throw new Error('os_crypt key mismatch');
      return text.slice(prefix.length);
    },
  },
}));

// vi.mock is hoisted above imports, so the electron mock is in place for this.
import { AppStore } from './store';

const newStore = () => { const store = new AppStore(); store.init(); return store; };
const dataFile = () => path.join(userData, 'axiom-data.json');
// saveSettings expects a full SaveSettingsRequest; supply the required fields.
const saveKeys = (store: InstanceType<typeof AppStore>, keys: Record<string, string>) =>
  store.saveSettings({ model: '', ...keys } as never);

describe('portable backup', () => {
  beforeEach(() => {
    machineKey = 'machine-A';
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-'));
  });

  it('survives a move to another machine, which a file copy does not', () => {
    const origin = newStore();
    saveKeys(origin, { openAIKey: 'sk-test-openai-value', elevenLabsKey: 'el-test-value' });
    expect(origin.openAIKey()).toBe('sk-test-openai-value');

    const backupPath = path.join(userData, 'portable.axiombackup');
    const backup = origin.createPortableBackup('correct horse battery staple', backupPath);
    expect(backup.secrets).toBeGreaterThanOrEqual(2);
    expect(backup.skipped).toEqual([]);

    // The backup must never contain a readable secret.
    const onDisk = fs.readFileSync(backupPath, 'utf8');
    expect(onDisk).not.toContain('sk-test-openai-value');
    expect(onDisk).not.toContain('el-test-value');

    // Now we are a different computer. The existing profile becomes unreadable —
    // this is exactly what a plain copy of axiom-data.json produces.
    machineKey = 'machine-B';
    const moved = newStore();
    expect(moved.openAIKey()).toBe('');
    expect(moved.unreadableCredentials()).toContain('OpenAI key');

    const result = moved.restorePortableBackup(backupPath, 'correct horse battery staple');
    expect(result.skipped).toEqual([]);
    const restored = newStore();
    expect(restored.openAIKey()).toBe('sk-test-openai-value');
    expect(restored.elevenLabsKey()).toBe('el-test-value');
    expect(restored.unreadableCredentials()).toEqual([]);
  });

  it('refuses a wrong passphrase instead of half-restoring', () => {
    const origin = newStore();
    saveKeys(origin, { openAIKey: 'sk-test-openai-value' });
    const backupPath = path.join(userData, 'portable.axiombackup');
    origin.createPortableBackup('correct horse battery staple', backupPath);
    const before = fs.readFileSync(dataFile(), 'utf8');

    expect(() => origin.restorePortableBackup(backupPath, 'wrong passphrase here')).toThrow(/passphrase does not match/i);
    expect(fs.readFileSync(dataFile(), 'utf8')).toBe(before);
  });

  it('requires a passphrase long enough to be worth having', () => {
    const store = newStore();
    expect(() => store.createPortableBackup('short')).toThrow(/at least 12 characters/i);
  });

  it('refuses a missing or non-file backup path instead of letting fs.readFileSync throw a raw ENOENT/EISDIR',()=>{
    const store=newStore();
    expect(()=>store.restorePortableBackup(path.join(userData,'does-not-exist.axiombackup'),'correct horse battery staple')).toThrow(/backup file not found/i);
    expect(()=>store.restorePortableBackup(userData,'correct horse battery staple')).toThrow(/backup file not found/i);
  });
});

describe('data export and erasure', () => {
  beforeEach(() => { machineKey = 'machine-A'; userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-')); });

  it('exports a human-readable copy without operator secrets', () => {
    const store = newStore();
    saveKeys(store, { openAIKey: 'sk-test-openai-value' });
    store.saveSettings({ model: '', acknowledgeBiometricConsent: true } as never);
    store.addMemory('Loves synthwave', { kind: 'preference' });
    const target = path.join(userData, 'export.json');
    const result = store.exportAllData(target);
    const exported = fs.readFileSync(target, 'utf8');
    expect(exported).toContain('Loves synthwave');
    // The point of this export is portability of the user's own data, not a
    // second copy of the operator's provider credentials.
    expect(exported).not.toContain('sk-test-openai-value');
    expect(exported).not.toMatch(/encryptedOpenAIKey/);
    const parsed = JSON.parse(exported);
    expect(parsed.format).toBe('axiom-data-export');
    expect(fs.statSync(target).size).toBe(result.bytes);
  });

  it('refuses to erase without the exact confirmation phrase', () => {
    const store = newStore();
    store.addMemory('Keep me', { kind: 'fact' });
    expect(() => store.eraseAllLocalData('delete all axiom data')).toThrow(/exact phrase/i);
    expect(() => store.eraseAllLocalData('DELETE')).toThrow(/exact phrase/i);
    expect(store.memories()).toHaveLength(1);
  });

  it('erases everything including media artifact files, and API keys stop decrypting', () => {
    const store = newStore();
    saveKeys(store, { openAIKey: 'sk-test-openai-value' });
    store.addMemory('Keep me', { kind: 'fact' });
    store.saveSettings({ model: '', acknowledgeBiometricConsent: true } as never);
    const mediaFile = path.join(userData, 'a-generated-image.png');
    fs.writeFileSync(mediaFile, 'x', 'utf8');
    const file = path.join(userData, 'axiom-data.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.mediaArtifacts = [{ id: 'm1', kind: 'image', provider: 'openai', model: 'test', prompt: 'p', status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), path: mediaFile, estimatedCostUsd: 0 }];
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    const reloaded = newStore();

    const result = reloaded.eraseAllLocalData('DELETE ALL AXIOM DATA');
    expect(result.erased).toBe(true);
    expect(result.filesRemoved).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(mediaFile)).toBe(false);
    expect(reloaded.memories()).toHaveLength(0);
    expect(reloaded.openAIKey()).toBe('');
    expect(reloaded.biometricConsentGranted()).toBe(false);
  });
});

describe('biometric consent gate', () => {
  beforeEach(() => { machineKey = 'machine-A'; userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-')); });

  it('refuses face and voice enrollment until consent is acknowledged', () => {
    const store = newStore();
    expect(store.biometricConsentGranted()).toBe(false);
    expect(() => store.saveKnownPerson('Robbie', [0.1, 0.2])).toThrow(/biometric consent/i);
    expect(() => store.enrollSpeaker('Robbie', [0.1, 0.2])).toThrow(/biometric consent/i);

    store.saveSettings({ model: '', acknowledgeBiometricConsent: true } as never);
    expect(store.biometricConsentGranted()).toBe(true);
    // Past the gate the remaining objection is descriptor validity, not consent.
    expect(() => store.saveKnownPerson('Robbie', [0.1, 0.2])).not.toThrow(/biometric consent/i);
    expect(() => store.enrollSpeaker('Robbie', [0.1, 0.2])).not.toThrow(/biometric consent/i);
  });

  it('withdrawal stops future capture rather than only hiding it', () => {
    const store = newStore();
    store.saveSettings({ model: '', acknowledgeBiometricConsent: true } as never);
    const after = store.saveSettings({ model: '', withdrawBiometricConsent: true } as never);
    expect(after.biometricConsent.acknowledged).toBe(false);
    expect(() => store.enrollSpeaker('Robbie', [0.1])).toThrow(/biometric consent/i);
  });
});

describe('credential state honesty', () => {
  beforeEach(() => { machineKey = 'machine-A'; userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-')); });

  it('separates absent from present-but-undecryptable', () => {
    const store = newStore();
    expect(store.credentialState(undefined)).toBe('absent');
    saveKeys(store, { openAIKey: 'sk-test-openai-value' });
    const stored = JSON.parse(fs.readFileSync(dataFile(), 'utf8')).encryptedOpenAIKey;
    expect(store.credentialState(stored)).toBe('ready');
    machineKey = 'machine-B';
    expect(store.credentialState(stored)).toBe('unreadable');
    // The distinction must reach the renderer, not be collapsed into "no key".
    expect(newStore().publicSettings().unreadableCredentials).toContain('OpenAI key');
  });
});

describe('owner override phrase', () => {
  beforeEach(() => { machineKey = 'machine-A'; userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-')); });

  it('is absent by default and never accepts a guess before one is set', () => {
    const store = newStore();
    expect(store.hasOwnerOverridePhrase()).toBe(false);
    expect(store.publicSettings().hasOwnerOverridePhrase).toBe(false);
    expect(store.verifyOwnerOverridePhrase('anything')).toBe(false);
  });

  it('accepts only the exact enrolled phrase, and only after it is set', () => {
    const store = newStore();
    saveKeys(store, { ownerOverridePhrase: 'correct horse battery staple' });
    expect(store.publicSettings().hasOwnerOverridePhrase).toBe(true);
    expect(store.verifyOwnerOverridePhrase('correct horse battery staple')).toBe(true);
    expect(store.verifyOwnerOverridePhrase('Correct Horse Battery Staple')).toBe(false);
    expect(store.verifyOwnerOverridePhrase('wrong phrase entirely')).toBe(false);
  });

  it('refuses to enroll a short phrase — a bare name must not qualify', () => {
    const store = newStore();
    expect(() => saveKeys(store, { ownerOverridePhrase: 'Robbie' })).toThrow(/at least 8/i);
  });

  it('locks out after 5 wrong attempts and stays locked for enrolled-correct guesses too', () => {
    const store = newStore();
    saveKeys(store, { ownerOverridePhrase: 'correct horse battery staple' });
    for (let attempt = 0; attempt < 5; attempt += 1) expect(store.verifyOwnerOverridePhrase('nope')).toBe(false);
    // Even the genuinely correct phrase must not work while locked out.
    expect(store.verifyOwnerOverridePhrase('correct horse battery staple')).toBe(false);
  });

  it('is stored hashed, never as plaintext, in the persisted file', () => {
    const store = newStore();
    saveKeys(store, { ownerOverridePhrase: 'correct horse battery staple' });
    const raw = fs.readFileSync(dataFile(), 'utf8');
    expect(raw).not.toContain('correct horse battery staple');
  });

  it('can be cleared, after which no phrase verifies', () => {
    const store = newStore();
    saveKeys(store, { ownerOverridePhrase: 'correct horse battery staple' });
    store.saveSettings({ model: '', clearOwnerOverridePhrase: true } as never);
    expect(store.publicSettings().hasOwnerOverridePhrase).toBe(false);
    expect(store.verifyOwnerOverridePhrase('correct horse battery staple')).toBe(false);
  });
});

// A separate, distinct secret from the owner override phrase above — an
// opt-in shortcut Robbie explicitly asked for in place of the default
// per-action AX-XXXXXX approval code, after being told the real trade-off
// (a static phrase can't tell two simultaneously-pending actions apart, the
// way a fresh random code per action can). Same scrypt-hashed, rate-limited
// storage pattern, deliberately mirrored rather than reusing the owner
// override phrase's own fields, since they authorize genuinely different
// things and must be independently settable/clearable.
describe('action approval phrase', () => {
  beforeEach(() => { machineKey = 'machine-A'; userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-')); });

  it('is absent by default and never accepts a guess before one is set', () => {
    const store = newStore();
    expect(store.hasActionApprovalPhrase()).toBe(false);
    expect(store.publicSettings().hasActionApprovalPhrase).toBe(false);
    expect(store.verifyActionApprovalPhrase('anything')).toBe(false);
  });

  it('accepts only the exact enrolled phrase, and only after it is set', () => {
    const store = newStore();
    saveKeys(store, { actionApprovalPhrase: 'unlock the gates of dawn' });
    expect(store.publicSettings().hasActionApprovalPhrase).toBe(true);
    expect(store.verifyActionApprovalPhrase('unlock the gates of dawn')).toBe(true);
    expect(store.verifyActionApprovalPhrase('Unlock The Gates Of Dawn')).toBe(false);
    expect(store.verifyActionApprovalPhrase('wrong phrase entirely')).toBe(false);
  });

  it('refuses to enroll a short phrase', () => {
    const store = newStore();
    expect(() => saveKeys(store, { actionApprovalPhrase: 'short' })).toThrow(/at least 8/i);
  });

  it('locks out after 5 wrong attempts and stays locked for the genuinely correct phrase too', () => {
    const store = newStore();
    saveKeys(store, { actionApprovalPhrase: 'unlock the gates of dawn' });
    for (let attempt = 0; attempt < 5; attempt += 1) expect(store.verifyActionApprovalPhrase('nope')).toBe(false);
    expect(store.verifyActionApprovalPhrase('unlock the gates of dawn')).toBe(false);
  });

  it('is stored hashed, never as plaintext, in the persisted file', () => {
    const store = newStore();
    saveKeys(store, { actionApprovalPhrase: 'unlock the gates of dawn' });
    const raw = fs.readFileSync(dataFile(), 'utf8');
    expect(raw).not.toContain('unlock the gates of dawn');
  });

  it('can be cleared, after which no phrase verifies', () => {
    const store = newStore();
    saveKeys(store, { actionApprovalPhrase: 'unlock the gates of dawn' });
    store.saveSettings({ model: '', clearActionApprovalPhrase: true } as never);
    expect(store.publicSettings().hasActionApprovalPhrase).toBe(false);
    expect(store.verifyActionApprovalPhrase('unlock the gates of dawn')).toBe(false);
  });

  it('is independent of the owner override phrase — setting one never affects the other', () => {
    const store = newStore();
    saveKeys(store, { ownerOverridePhrase: 'correct horse battery staple', actionApprovalPhrase: 'unlock the gates of dawn' });
    expect(store.verifyOwnerOverridePhrase('unlock the gates of dawn')).toBe(false);
    expect(store.verifyActionApprovalPhrase('correct horse battery staple')).toBe(false);
    expect(store.verifyOwnerOverridePhrase('correct horse battery staple')).toBe(true);
    expect(store.verifyActionApprovalPhrase('unlock the gates of dawn')).toBe(true);
  });
});

describe('self-corrections — Axiom remembering its own past mistakes', () => {
  beforeEach(() => { machineKey = 'machine-A'; userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-')); });

  it('ships pre-seeded with real lessons on a fresh install', () => {
    const store = newStore();
    expect(store.selfCorrections().length).toBeGreaterThan(0);
  });

  it('records, matches by keyword overlap, and forgets a correction', async () => {
    const store = newStore();
    const before = store.selfCorrections().length;
    store.recordSelfCorrection('user asks about the weather', 'Assumed no tool was available.', 'Broadened the search trigger.');
    expect(store.selfCorrections().length).toBe(before + 1);
    const matches = await store.relevantSelfCorrections('what is the weather like today');
    expect(matches.some((item) => item.fix === 'Broadened the search trigger.')).toBe(true);
    // An unrelated message should not match.
    expect((await store.relevantSelfCorrections('turn off the lights')).some((item) => item.fix === 'Broadened the search trigger.')).toBe(false);
    const id = store.selfCorrections().find((item) => item.fix === 'Broadened the search trigger.')!.id;
    const after = store.forgetSelfCorrection(id);
    expect(after.some((item) => item.id === id)).toBe(false);
  });

  it('matches a lesson by meaning, not just shared keywords, using a real embedding',async()=>{
    const store=newStore();
    store.recordSelfCorrection('user asks about the weather','Assumed no tool was available.','Broadened the search trigger.');
    await store.backfillSelfCorrectionEmbeddings();
    const rephrased=await store.relevantSelfCorrections("what's it like outside today");
    expect(rephrased.some((item)=>item.fix==='Broadened the search trigger.')).toBe(true);
  },15_000);
});

describe('settings snapshot and revert', () => {
  beforeEach(() => { machineKey = 'machine-A'; userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-')); });

  it('has no snapshot before any settings change', () => {
    const store = newStore();
    expect(store.lastSettingsSnapshot()).toBeUndefined();
  });

  it('reverts the most recent settings change back to its prior value', () => {
    const store = newStore();
    store.saveSettings({ model: '', speakerLockEnabled: true } as never);
    store.saveSettings({ model: '', speakerLockEnabled: false } as never);
    expect(store.publicSettings().speakerLockEnabled).toBe(false);
    expect(store.lastSettingsSnapshot()).toBeDefined();
    const reverted = store.revertLastSettingsChange();
    expect(reverted.speakerLockEnabled).toBe(true);
  });

  it('throws when there is nothing to revert', () => {
    const store = newStore();
    expect(() => store.revertLastSettingsChange()).toThrow(/no recent settings change/i);
  });

  it('consumes the snapshot on revert — reverting twice in a row fails the second time', () => {
    const store = newStore();
    store.saveSettings({ model: '', speakerLockEnabled: true } as never);
    store.saveSettings({ model: '', speakerLockEnabled: false } as never);
    store.revertLastSettingsChange();
    expect(() => store.revertLastSettingsChange()).toThrow(/no recent settings change/i);
  });
});

describe('init() failure recovery — a defect this size deserves its own coverage',()=>{
  beforeEach(()=>{machineKey='machine-A';userData=fs.mkdtempSync(path.join(os.tmpdir(),'axiom-store-'));});
  const diagnosticLog=()=>path.join(userData,'diagnostics','axiom-runtime.log');
  // The getPath mock resolves every root (desktop/documents/downloads) to
  // the same userData temp dir, so a valid workspace path has to live
  // inside it for saveSettings' "must be inside Desktop/Documents/Downloads"
  // check to accept it.
  const workspacePath=()=>path.resolve(path.join(userData,'Axiom Projects','MyProj'));

  it('recovers from .bak when the primary file is corrupt JSON, same as before',()=>{
    const good=newStore();
    good.saveSettings({model:'',codingWorkspace:workspacePath()} as never);
    fs.copyFileSync(dataFile(),`${dataFile()}.bak`);
    fs.writeFileSync(dataFile(),'{not valid json',{encoding:'utf8'});
    const recovered=newStore();
    expect(recovered.publicSettings().codingWorkspace).toBe(workspacePath());
  });

  // The bug this covers: the .bak recovery path only used to trigger on a
  // JSON.parse failure. A failure in the *migration* logic further down —
  // parseable JSON with an unexpected shape — used to skip straight past
  // the backup and silently wipe the whole profile to defaults with no log.
  // fallbackOrder here is an object, not an array, so validOrder()'s
  // .filter() call throws a TypeError partway through migration — parse
  // succeeds, migration doesn't.
  it('recovers from .bak when the primary file parses but the migration step throws',()=>{
    const good=newStore();
    good.saveSettings({model:'',codingWorkspace:workspacePath()} as never);
    fs.copyFileSync(dataFile(),`${dataFile()}.bak`);
    fs.writeFileSync(dataFile(),JSON.stringify({fallbackOrder:{notAnArray:true}}),{encoding:'utf8'});
    const recovered=newStore();
    expect(recovered.publicSettings().codingWorkspace).toBe(workspacePath());
  });

  it('logs a diagnostic instead of silently wiping the profile when both the primary file and .bak are unusable',()=>{
    fs.writeFileSync(dataFile(),'{not valid json',{encoding:'utf8'});
    const store=newStore();
    // Defaulted, not carrying over anything from the unreadable file —
    // proven directly via the diagnostic log below rather than guessing at
    // defaults()'s exact codingWorkspace value (itself getPath-mock-derived).
    expect(store.publicSettings().codingWorkspace).not.toBe(workspacePath());
    const log=fs.readFileSync(diagnosticLog(),'utf8');
    expect(log).toContain('store-init-DATA-LOSS-fell-back-to-defaults');
  });

  it('logs a diagnostic on successful .bak recovery too, not just on total failure',()=>{
    const good=newStore();
    good.saveSettings({model:'',codingWorkspace:workspacePath()} as never);
    fs.copyFileSync(dataFile(),`${dataFile()}.bak`);
    fs.writeFileSync(dataFile(),'{not valid json',{encoding:'utf8'});
    newStore();
    const log=fs.readFileSync(diagnosticLog(),'utf8');
    expect(log).toContain('store-init-recovered-from-backup');
  });

  // A genuinely fresh install (no axiom-data.json yet at all) used to fall
  // through to the exact same recovery branch as a corrupt file with no
  // backup, logging a max-severity "DATA-LOSS" event on every single first
  // launch — burying real reports under one for every routine install.
  it('does not log a DATA-LOSS diagnostic on a brand-new install with no saved file yet',()=>{
    expect(fs.existsSync(dataFile())).toBe(false);
    const store=newStore();
    expect(store.memories()).toEqual([]);
    expect(fs.existsSync(diagnosticLog())).toBe(false);
  });
});

describe('goal and to-do validation — matches sibling addMemory/addTodo/addCommitment guards',()=>{
  beforeEach(()=>{machineKey='machine-A';userData=fs.mkdtempSync(path.join(os.tmpdir(),'axiom-store-'));});

  it('refuses an empty goal title instead of silently storing a blank goal',()=>{
    const store=newStore();
    expect(()=>store.addGoal('   ')).toThrow(/goal title is required/i);
    expect(store.addGoal('Finish the launch').title).toBe('Finish the launch');
  });

  it('refuses an out-of-range to-do status instead of persisting it verbatim',()=>{
    const store=newStore();
    const todo=store.addTodo('Buy groceries');
    expect(()=>store.setTodoStatus(todo.id,'archived' as never)).toThrow(/must be "open" or "completed"/i);
    expect(store.setTodoStatus(todo.id,'completed').find((item)=>item.id===todo.id)?.status).toBe('completed');
  });
});

describe('semantic memory — real embeddings, not stubbed vectors',()=>{
  beforeEach(()=>{machineKey='machine-A';userData=fs.mkdtempSync(path.join(os.tmpdir(),'axiom-store-'));});

  it('backfills embeddings for existing memories and finds a match sharing no keywords with the query',async()=>{
    const store=newStore();
    store.addMemory('Robbie lives in St. Louis and loves synthwave music.',{kind:'fact'});
    store.addMemory('The garage door opener uses a rolling code.',{kind:'fact'});
    // addMemory attaches embeddings in the background — wait for real
    // inference to finish rather than the immediately-returned record.
    await store.backfillMemoryEmbeddings();
    const matches=await store.searchMemories('Where is my hometown?');
    expect(matches.map((item)=>item.text)).toContain('Robbie lives in St. Louis and loves synthwave music.');
  },15_000);

  it('flags a same-topic, different-value memory as a likely conflict without treating it as a duplicate',async()=>{
    const store=newStore();
    const original=store.addMemory('Robbie lives in St. Louis.',{kind:'fact'});
    await store.backfillMemoryEmbeddings();
    const conflict=await store.findSimilarActiveMemory('fact','Robbie now lives in Austin, Texas.');
    expect(conflict?.item.id).toBe(original.id);
    expect(conflict!.similarity).toBeGreaterThanOrEqual(0.7);
    expect(conflict!.similarity).toBeLessThan(0.95);
  },15_000);

  it('recognizes a near-identical paraphrase as a duplicate, not a conflict',async()=>{
    const store=newStore();
    const original=store.addMemory('Robbie lives in St. Louis.',{kind:'fact'});
    await store.backfillMemoryEmbeddings();
    const duplicate=await store.findSimilarActiveMemory('fact','Robbie lives in the St. Louis area.');
    expect(duplicate!.similarity).toBeGreaterThanOrEqual(0.95);
  },15_000);

  it('does not flag two genuinely different facts about the same person as a conflict',async()=>{
    const store=newStore();
    const original=store.addMemory('Robbie lives in St. Louis.',{kind:'fact'});
    await store.backfillMemoryEmbeddings();
    const unrelated=await store.findSimilarActiveMemory('fact','Robbie loves synthwave music.');
    expect(unrelated!.similarity).toBeLessThan(0.7);
  },15_000);
});

describe("God's Eye View settings", () => {
  beforeEach(() => {
    machineKey = 'machine-A';
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-store-'));
  });

  it('persists the project path and returns it from the getter and public settings', () => {
    const store = newStore();
    expect(store.godsEyeViewPath()).toBe('');
    saveKeys(store, { godsEyeViewPath: '/Users/robbie/Desktop/gods-eye-view' });
    expect(store.godsEyeViewPath()).toBe('/Users/robbie/Desktop/gods-eye-view');
    expect(store.publicSettings().godsEyeViewPath).toBe('/Users/robbie/Desktop/gods-eye-view');
  });

  it('trims whitespace and survives a reload from disk', () => {
    const origin = newStore();
    saveKeys(origin, { godsEyeViewPath: '  /Users/robbie/Desktop/gods-eye-view  ' });
    expect(origin.godsEyeViewPath()).toBe('/Users/robbie/Desktop/gods-eye-view');
    const reloaded = newStore();
    expect(reloaded.godsEyeViewPath()).toBe('/Users/robbie/Desktop/gods-eye-view');
  });

  // Runtime-only reference — never persisted, never touches disk — so
  // gods_eye_fly_to (tools.ts) can reach the live GodsEyeViewManager the main
  // process owns through the same `store` parameter every tool already
  // receives, without tools.ts and main.ts importing each other.
  it('holds a runtime-only manager reference that does not persist to disk', () => {
    const store = newStore();
    expect(store.getGodsEyeViewManager()).toBeUndefined();
    const fakeManager = { open: async () => ({ ready: true, url: 'http://localhost:4173/' }) } as never;
    store.setGodsEyeViewManager(fakeManager);
    expect(store.getGodsEyeViewManager()).toBe(fakeManager);
    store.setGodsEyeViewManager(undefined);
    expect(store.getGodsEyeViewManager()).toBeUndefined();
  });
});
