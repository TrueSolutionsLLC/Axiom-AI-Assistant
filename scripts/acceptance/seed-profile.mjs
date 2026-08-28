import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Builds a QA profile that can reach the real providers without carrying the
// user's personal data. Credentials stay DPAPI/Keychain-encrypted and are never
// decrypted, printed, or copied outside this machine's user account.
//
// Deliberately NOT copied: conversation history, memories, biometric templates,
// known people, speaker profiles, sync passphrase, audit trail.

const source = process.env.AXIOM_SOURCE_PROFILE || path.join(os.homedir(), 'AppData', 'Roaming', 'axiom-assistant');
const target = process.env.AXIOM_ACCEPTANCE_PROFILE || path.join(os.homedir(), 'AppData', 'Local', 'AxiomAcceptanceQA');
const sourceFile = path.join(source, 'axiom-data.json');

if (!fs.existsSync(sourceFile)) throw new Error(`No Axiom profile found at ${sourceFile}. Open Axiom and save your keys first.`);
const data = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

// Credentials plus the settings that select how they are used. Nothing else.
const CARRY = [
  'encryptedOpenAIKey', 'encryptedAnthropicKey', 'encryptedGeminiKey', 'encryptedElevenLabsKey',
  'provider', 'model', 'providerModels', 'codingProvider', 'researchProvider', 'autoFailover',
  'speechProvider', 'elevenLabsVoiceId', 'elevenLabsVoiceName', 'elevenLabsModel',
  'voiceStability', 'voiceSimilarity', 'voiceStyle', 'voiceSpeed',
];

const seeded = {};
const carried = [];
for (const key of CARRY) {
  if (data[key] === undefined) continue;
  seeded[key] = data[key];
  carried.push(key);
}

// Acceptance runs must not enable hands-free voice locking.
seeded.speakerLockEnabled = false;
seeded.handsFreeEnabled = false;

fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'axiom-data.json'), JSON.stringify(seeded, null, 2), 'utf8');

// safeStorage on Windows is Chromium os_crypt, not raw DPAPI: the AES key lives
// in the profile's "Local State" and is itself DPAPI-wrapped. Without this file
// the copied credentials are present but undecryptable.
const localState = path.join(source, 'Local State');
if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(target, 'Local State'));
else console.warn('Warning: no "Local State" in the source profile; credentials will not decrypt.');

const credentials = carried.filter((k) => /encrypted/i.test(k));
const excluded = Object.keys(data).filter((k) => !carried.includes(k));
console.log(`QA profile seeded: ${target}`);
console.log(`  credentials carried (still encrypted): ${credentials.join(', ') || 'none'}`);
console.log(`  settings carried: ${carried.length - credentials.length}`);
console.log(`  personal-data fields deliberately excluded: ${excluded.length}`);
console.log(`\nRun:  AXIOM_ACCEPTANCE_PROFILE="${target}" npm run acceptance`);
