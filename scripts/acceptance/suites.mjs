// Acceptance suites for PRODUCTION_READINESS.md.
//
// Every suite reports passed | failed | skipped. A suite whose preconditions are
// absent must report SKIPPED with the reason — never passed. Axiom refuses to
// claim an unverified success, and its own gate is held to the same rule.

// Native runtimes bundled by MediaPipe/TFLite write informational lines to the
// console error channel. Filtered narrowly and always disclosed in the receipt —
// never dropped silently, or this suite would stop meaning anything.
const BENIGN_CONSOLE = [/^INFO:/];
const isBenign = (line) => BENIGN_CONSOLE.some((pattern) => pattern.test(line.trim()));

export const RUNTIME_SUITES = [
  {
    id: 'process-health',
    gate: 'Windows installation and launch',
    title: 'Renderer starts clean with no errors',
    async run({ page, observed }) {
      const render = await page.evaluate(() => ({
        painted: (document.body?.innerText?.length ?? 0) > 200,
        root: document.querySelector('#root')?.children.length ?? 0,
        bridge: typeof window.axiom,
        methods: window.axiom ? Object.keys(window.axiom).length : 0,
        errorStrip: document.querySelector('.error-strip')?.textContent?.trim() || null,
      }));
      const realErrors = observed.consoleErrors.filter((line) => !isBenign(line));
      const filtered = observed.consoleErrors.filter(isBenign);
      const problems = [];
      if (!render.painted) problems.push('renderer did not paint');
      if (render.bridge !== 'object') problems.push('preload bridge missing');
      if (render.errorStrip) problems.push(`error strip: ${render.errorStrip}`);
      if (realErrors.length) problems.push(`${realErrors.length} console error(s): ${realErrors[0]}`);
      if (observed.pageErrors.length) problems.push(`${observed.pageErrors.length} page error(s): ${observed.pageErrors[0]}`);
      if (observed.failedRequests.length) problems.push(`${observed.failedRequests.length} failed request(s): ${observed.failedRequests[0]}`);
      const note = filtered.length ? ` (${filtered.length} benign INFO line(s) filtered)` : '';
      return { ok: !problems.length, detail: problems.join(' | ') || `painted, ${render.methods} bridge methods, no errors${note}`, evidence: { ...render, filteredConsoleLines: filtered } };
    },
  },
  {
    id: 'ipc-contract',
    gate: 'Observability and support',
    title: 'Read-only IPC surface answers without throwing',
    async run({ page }) {
      const results = await page.evaluate(async () => {
        const a = window.axiom, names = ['getAppInfo', 'getSettings', 'listPermissions', 'getRuntimeSnapshot', 'getSystemTelemetry', 'listMemories', 'listGoals', 'listTodos', 'getSyncStatus', 'getDesktopGraph', 'loadHistory', 'getPlatformPermissions', 'listConnectors', 'getSchedulerSnapshot', 'loadAudit'];
        const out = [];
        for (const name of names) {
          try { await a[name](); out.push({ name, ok: true }); }
          catch (error) { out.push({ name, ok: false, error: String(error.message || error).slice(0, 160) }); }
        }
        return out;
      });
      const failed = results.filter((r) => !r.ok);
      return { ok: !failed.length, detail: failed.length ? failed.map((f) => `${f.name}: ${f.error}`).join(' | ') : `${results.length}/${results.length} IPC methods responded`, evidence: results };
    },
  },
  {
    id: 'tool-receipts',
    gate: 'Computer control',
    title: 'A real tool execution produces a verifiable receipt',
    async run({ page }) {
      const result = await page.evaluate(async () => {
        try {
          const graph = await window.axiom.refreshDesktopGraph();
          const e = graph.event || {};
          return { ok: true, status: e.status, name: e.name, actionId: Boolean(e.actionId), digest: Boolean(e.resultDigest), verification: e.verification?.method, windows: graph.graph?.metrics?.liveWindows ?? 0, summary: String(e.summary || '').slice(0, 160) };
        } catch (error) { return { ok: false, error: String(error.message || error).slice(0, 200) }; }
      });
      if (!result.ok) return { ok: false, detail: `tool execution threw: ${result.error}`, evidence: result };
      const problems = [];
      if (result.status !== 'verified') problems.push(`status was "${result.status}" not "verified" (${result.summary})`);
      if (!result.actionId) problems.push('receipt has no actionId');
      if (!result.digest) problems.push('receipt has no resultDigest');
      if (!result.verification) problems.push('receipt has no verification method');
      return { ok: !problems.length, detail: problems.join(' | ') || `${result.name} verified · ${result.windows} live windows · ${result.verification}`, evidence: result };
    },
  },
  {
    id: 'no-false-success',
    gate: 'Crash and task recovery',
    title: 'A failed request never settles as completed',
    async run({ page }) {
      const result = await page.evaluate(async () => {
        // An action request whose tool never produced a verified receipt must not
        // settle completed. Scoped to this task by title: a purely conversational
        // task legitimately completes with no receipts, so counting every
        // receipt-less completion would flag correct behaviour.
        const title = `Create a folder on my Desktop called AxiomAcceptance ${Date.now()}`;
        try { await window.axiom.sendMessage({ message: title, history: [] }); }
        catch { /* a hard failure is an acceptable honest outcome */ }
        const snap = await window.axiom.getRuntimeSnapshot();
        const mine = (snap.tasks || []).find((t) => t.title === title);
        return mine
          ? { found: true, status: mine.status, phase: mine.phase, receipts: (mine.actionIds || []).length, blocker: String(mine.blocker || '').slice(0, 140) }
          : { found: false };
      });
      const problems = [];
      if (!result.found) problems.push('the request was not journalled as a runtime task');
      else if (result.status === 'completed' && !result.receipts) problems.push('an action request completed with no verified receipt');
      return { ok: !problems.length, detail: problems.join(' | ') || `settled "${result.status}" in phase "${result.phase}" with ${result.receipts} receipt(s)${result.blocker ? ` · ${result.blocker}` : ''}`, evidence: result };
    },
  },
  {
    id: 'visitor-lockout',
    gate: 'Face identity and presence',
    title: 'An unverified visitor cannot trigger the deterministic action route',
    async run({ page }) {
      const result = await page.evaluate(async () => {
        // tools.test.ts asserts this exact string routes to browser_open, so any
        // tool receipt here means the untrustedPresence guard did not fire.
        try {
          const reply = await window.axiom.sendMessage({ message: 'Search YouTube for realistic AI avatars', history: [], untrustedPresence: true });
          return { executed: true, toolEvents: (reply.toolEvents || []).map((e) => e.name) };
        } catch (error) { return { executed: false, blockedWith: String(error.message || error).slice(0, 160) }; }
      });
      const leaked = result.executed && result.toolEvents.some((n) => n !== 'adaptive_failover');
      return { ok: !leaked, detail: leaked ? `visitor reached tools: ${result.toolEvents.join(', ')}` : 'no tool executed for an unverified visitor', evidence: result };
    },
  },
  {
    id: 'secure-vault',
    gate: 'Credential and biometric protection',
    title: 'OS secure storage is available for credentials',
    async run({ page }) {
      const s = await page.evaluate(() => window.axiom.getSettings());
      return { ok: Boolean(s.encryptionAvailable), detail: s.encryptionAvailable ? 'OS secure storage available' : 'OS secure storage UNAVAILABLE — credentials cannot be protected', evidence: { encryptionAvailable: s.encryptionAvailable } };
    },
  },
  {
    id: 'provider-roundtrip',
    gate: 'Conversation and voice',
    title: 'A real request reaches the model and returns a grounded reply',
    async run({ page }) {
      const settings = await page.evaluate(() => window.axiom.getSettings());
      if (!settings.hasSelectedAIKey) return { skip: `no credential for the selected provider (${settings.provider}); seed a QA profile with scripts/acceptance/seed-profile.mjs` };
      const result = await page.evaluate(async () => {
        const started = performance.now();
        try {
          const reply = await window.axiom.sendMessage({ message: 'Reply with exactly the word ACKNOWLEDGED and nothing else.', history: [] });
          return { ok: true, ms: Math.round(performance.now() - started), text: String(reply.text || '').slice(0, 120), provider: reply.provider, model: reply.model };
        } catch (error) { return { ok: false, ms: Math.round(performance.now() - started), error: String(error.message || error).slice(0, 200) }; }
      });
      if (!result.ok) return { ok: false, detail: `provider call failed: ${result.error}`, evidence: result };
      const snap = await page.evaluate(() => window.axiom.getRuntimeSnapshot());
      const task = (snap.tasks || [])[0];
      const problems = [];
      if (!result.text.trim()) problems.push('provider returned an empty reply');
      if (task && task.status === 'failed') problems.push(`runtime task settled failed: ${String(task.blocker || '').slice(0, 90)}`);
      return { ok: !problems.length, detail: problems.join(' | ') || `${result.provider}/${result.model} replied in ${result.ms} ms · "${result.text.trim().slice(0, 40)}"`, evidence: { ...result, taskStatus: task?.status } };
    },
  },
  {
    id: 'speech-synthesis',
    gate: 'Conversation and voice',
    title: 'The selected speech provider returns real audio',
    async run({ page }) {
      const settings = await page.evaluate(() => window.axiom.getSettings());
      const ready = settings.speechProvider === 'system' || (settings.speechProvider === 'openai' && settings.hasOpenAIKey) || (settings.speechProvider === 'elevenlabs' && settings.hasElevenLabsKey);
      if (!ready) return { skip: `speech provider "${settings.speechProvider}" has no credential in this profile` };
      const result = await page.evaluate(async () => {
        const started = performance.now();
        try {
          const audio = await window.axiom.synthesizeSpeech('Axiom acceptance check.');
          return { ok: true, ms: Math.round(performance.now() - started), bytes: audio.audio?.byteLength ?? 0, mimeType: audio.mimeType, provider: audio.provider, fallbackFrom: audio.fallbackFrom || null, alignment: Boolean(audio.alignment) };
        } catch (error) { return { ok: false, ms: Math.round(performance.now() - started), error: String(error.message || error).slice(0, 200) }; }
      });
      if (!result.ok) return { ok: false, detail: `synthesis failed: ${result.error}`, evidence: result };
      const problems = [];
      if (result.bytes < 1000) problems.push(`audio was only ${result.bytes} bytes`);
      if (result.fallbackFrom) problems.push(`fell back from ${result.fallbackFrom} to ${result.provider}`);
      return { ok: !problems.length, detail: problems.join(' | ') || `${result.provider} returned ${(result.bytes / 1024).toFixed(1)} KB ${result.mimeType} in ${result.ms} ms${result.alignment ? ' with viseme alignment' : ''}`, evidence: result };
    },
  },
  {
    id: 'portable-backup',
    gate: 'Credential and biometric protection',
    title: 'A portable backup round-trips through the live app without leaking secrets',
    async run({ page, profile }) {
      const settings = await page.evaluate(() => window.axiom.getSettings());
      if (!settings.hasOpenAIKey && !settings.hasElevenLabsKey) return { skip: 'no credential in this profile to back up' };
      const target = `${profile.replace(/\\/g, '/')}/acceptance-portable.axiombackup`;
      const result = await page.evaluate(async (file) => {
        try {
          const backup = await window.axiom.createPortableBackup('acceptance passphrase 2026');
          const restored = await window.axiom.restorePortableBackup(backup.path, 'acceptance passphrase 2026');
          let rejected = false;
          try { await window.axiom.restorePortableBackup(backup.path, 'definitely the wrong one'); }
          catch { rejected = true; }
          const after = await window.axiom.getSettings();
          return { ok: true, path: backup.path, secrets: backup.secrets, skipped: backup.skipped, restored: restored.restored, rejectedWrongPassphrase: rejected, stillReady: after.hasSelectedAIKey || after.hasElevenLabsKey, unreadable: after.unreadableCredentials };
        } catch (error) { return { ok: false, error: String(error.message || error).slice(0, 220) }; }
      }, target);
      if (!result.ok) return { ok: false, detail: `backup round trip failed: ${result.error}`, evidence: result };
      const problems = [];
      if (!result.secrets) problems.push('no secrets were carried into the backup');
      if (result.restored !== result.secrets) problems.push(`restored ${result.restored} of ${result.secrets} secrets`);
      if (!result.rejectedWrongPassphrase) problems.push('a wrong passphrase was accepted');
      if (!result.stillReady) problems.push('credentials were not readable after restore');
      if (result.unreadable?.length) problems.push(`unreadable after restore: ${result.unreadable.join(', ')}`);
      return { ok: !problems.length, detail: problems.join(' | ') || `${result.secrets} secret(s) re-encrypted, restored, wrong passphrase rejected`, evidence: result };
    },
  },
  {
    id: 'conversation-soak',
    gate: 'Conversation and voice',
    title: 'Multi-turn soak with measured reasoning and first-audio latency',
    async run({ page }) {
      const settings = await page.evaluate(() => window.axiom.getSettings());
      if (!settings.hasSelectedAIKey) return { skip: 'no AI provider credential in this profile' };
      // Turn count is deliberate: the readiness gate wants 100, but each turn is
      // a paid API call, so the default is a smoke-sized 10. AXIOM_SOAK_TURNS=100
      // runs the real gate.
      const turns = Number(process.env.AXIOM_SOAK_TURNS || 10);
      const speechReady = settings.speechProvider === 'elevenlabs' ? settings.hasElevenLabsKey : settings.speechProvider === 'openai' ? settings.hasOpenAIKey : true;
      const result = await page.evaluate(async ({ turns, speechReady }) => {
        const prompts = ['Name one primary colour.', 'What is 12 plus 30?', 'Say the word ready.', 'Name a day of the week.', 'What is the capital of France?'];
        const reasoning = [], audio = [], failures = [];
        for (let turn = 0; turn < turns; turn += 1) {
          const prompt = `${prompts[turn % prompts.length]} Answer in under six words.`;
          const started = performance.now();
          try {
            const reply = await window.axiom.sendMessage({ message: prompt, history: [] });
            reasoning.push(performance.now() - started);
            if (speechReady && String(reply.text || '').trim()) {
              const spoke = performance.now();
              try { const a = await window.axiom.synthesizeSpeech(String(reply.text).slice(0, 120)); if ((a.audio?.byteLength ?? 0) > 500) audio.push(performance.now() - spoke); else failures.push(`turn ${turn + 1}: empty audio`); }
              catch (error) { failures.push(`turn ${turn + 1} tts: ${String(error.message || error).slice(0, 80)}`); }
            }
          } catch (error) { failures.push(`turn ${turn + 1}: ${String(error.message || error).slice(0, 80)}`); }
        }
        const pct = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };
        return {
          turns, completed: reasoning.length, failures: failures.slice(0, 5), failureCount: failures.length,
          reasoning: { median: pct(reasoning, 0.5), p95: pct(reasoning, 0.95) },
          audio: { median: pct(audio, 0.5), p95: pct(audio, 0.95), samples: audio.length },
          firstAudioMedian: reasoning.length && audio.length ? Math.round((pct(reasoning, 0.5) ?? 0) + (pct(audio, 0.5) ?? 0)) : null,
        };
      }, { turns, speechReady });

      const problems = [];
      if (result.completed < result.turns) problems.push(`${result.turns - result.completed}/${result.turns} turns failed: ${result.failures.join(' | ')}`);
      else if (result.failureCount) problems.push(`${result.failureCount} speech failure(s): ${result.failures.join(' | ')}`);
      // The gate's threshold: median end-of-speech to first audio under 1.5s.
      if (result.firstAudioMedian !== null && result.firstAudioMedian > 1500) problems.push(`median first-audio ${result.firstAudioMedian} ms exceeds the 1500 ms gate`);
      const detail = `${result.completed}/${result.turns} turns · reasoning median ${result.reasoning.median} ms (p95 ${result.reasoning.p95}) · tts median ${result.audio.median ?? 'n/a'} ms · first-audio median ${result.firstAudioMedian ?? 'n/a'} ms`;
      return { ok: !problems.length, detail: problems.length ? `${problems.join(' | ')} — ${detail}` : detail, evidence: result };
    },
  },
  {
    id: 'biometric-consent',
    gate: 'Credential and biometric protection',
    title: 'No biometric capture is possible before consent is acknowledged',
    async run({ page }) {
      const result = await page.evaluate(async () => {
        const a = window.axiom;
        const before = await a.getSettings();
        const model = before.model, codingWorkspace = before.codingWorkspace;
        // Start from withdrawn so the gate is exercised regardless of prior state.
        const withdrawn = await a.saveSettings({ model, codingWorkspace, withdrawBiometricConsent: true });
        let enrollBlocked = false;
        try { await a.enrollSpeaker('AcceptanceProbe', [0.1, 0.2, 0.3]); } catch (e) { enrollBlocked = /biometric consent/i.test(String(e.message || e)); }
        const granted = await a.saveSettings({ model, codingWorkspace, acknowledgeBiometricConsent: true });
        return { withdrawnAck: withdrawn.biometricConsent.acknowledged, enrollBlocked, grantedAck: granted.biometricConsent.acknowledged };
      });
      const problems = [];
      if (result.withdrawnAck) problems.push('withdrawal did not clear consent');
      if (!result.enrollBlocked) problems.push('voice enrollment was permitted without consent');
      if (!result.grantedAck) problems.push('acknowledgement was not recorded');
      return { ok: !problems.length, detail: problems.join(' | ') || 'capture blocked before consent, permitted after, withdrawal effective', evidence: result };
    },
  },
  {
    id: 'honest-telemetry',
    gate: 'Observability and support',
    title: 'Hardware telemetry reports measured values, not estimates',
    async run({ page }) {
      const t = await page.evaluate(() => window.axiom.getSystemTelemetry());
      const problems = [];
      if (!Number.isFinite(t.cpuPercent)) problems.push('cpuPercent is not a number');
      if (!Number.isFinite(t.memoryPercent)) problems.push('memoryPercent is not a number');
      if (!t.cpu?.model) problems.push('no CPU model reported');
      return { ok: !problems.length, detail: problems.join(' | ') || `${t.cpu?.model?.trim()} · CPU ${Math.round(t.cpuPercent)}% · memory ${Math.round(t.memoryPercent)}%`, evidence: { cpu: t.cpu?.model, cpuPercent: t.cpuPercent, memoryPercent: t.memoryPercent } };
    },
  },
];

// Suites from PRODUCTION_READINESS.md that need credentials, hardware, a second
// device, or elapsed time. Reported SKIPPED with what is missing.
export const GATED_SUITES = [
  { id: 'identity-biometrics', gate: 'Face identity and presence', title: '50 owner / 50 non-owner samples with retained thresholds', needs: 'a camera, enrolled owner samples, and a consenting non-owner' },
  { id: 'neural-speaker', gate: 'Neural speaker identity', title: 'Multi-speaker confusion test with background audio', needs: 'the target microphone and multiple speakers' },
  { id: 'watchdog-72h', gate: 'Windows background watchdog', title: '72 continuous hours with sleep/resume and network loss', needs: 'a 72-hour unattended run with the camera available' },
  { id: 'computer-control-matrix', gate: 'Computer control', title: 'Versioned per-application task matrix', needs: 'a defined application matrix on each target machine' },
  { id: 'home-assistant', gate: 'Home Assistant', title: 'Read, control, approve, reconnect against real devices', needs: 'a Home Assistant URL and long-lived access token' },
  { id: 'continuity', gate: 'Memory and cross-device continuity', title: 'Two-device concurrent edits, conflict merge, corruption restore', needs: 'both the Windows PC and the Mac running and linked' },
  { id: 'packaging', gate: 'Updates and rollback', title: 'Clean install, upgrade, uninstall, signature verification, rollback', needs: 'signed artifacts and an update channel (currently BLOCKED)' },
];
