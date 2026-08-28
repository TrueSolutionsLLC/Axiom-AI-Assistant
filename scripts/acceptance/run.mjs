import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RUNTIME_SUITES, GATED_SUITES } from './suites.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.AXIOM_QA_PORT || 9455);
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const keepProfile = process.argv.includes('--keep-profile');

// A throwaway profile: acceptance runs must never touch the real Axiom identity,
// credentials, memory, or single-instance lock.
const profile = process.env.AXIOM_ACCEPTANCE_PROFILE
  ? path.resolve(process.env.AXIOM_ACCEPTANCE_PROFILE)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-acceptance-'));

if (!fs.existsSync(path.join(root, 'dist-main', 'main', 'main.js'))) throw new Error('Build first: npm run build');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`Axiom did not expose a debugging port within ${timeoutMs / 1000}s.`);
}

const child = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AXIOM_QA: '1', AXIOM_QA_USER_DATA: profile },
});
let mainLog = '';
child.stdout.on('data', (c) => { mainLog = (mainLog + c).slice(-40_000); });
child.stderr.on('data', (c) => { mainLog = (mainLog + c).slice(-40_000); });

const results = [];
let browser;
try {
  const version = await waitForCdp();
  const { chromium } = require('playwright');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'));
  if (!page) throw new Error('Axiom renderer page was not found over CDP.');

  // Attach listeners, then reload so a full load cycle is observed rather than
  // whatever happened before we connected.
  const observed = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on('console', (m) => { if (m.type() === 'error') observed.consoleErrors.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => observed.pageErrors.push(String(e.message).slice(0, 240)));
  page.on('requestfailed', (r) => { const t = r.failure()?.errorText || ''; if (!/ERR_ABORTED/.test(t)) observed.failedRequests.push(`${r.url().slice(0, 100)} :: ${t}`); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.axiom === 'object', null, { timeout: 30_000 });
  await sleep(3500);

  for (const suite of RUNTIME_SUITES) {
    if (only && suite.id !== only) continue;
    const started = Date.now();
    try {
      const outcome = await suite.run({ page, observed, profile });
      // A suite may decide at runtime that its preconditions are absent. That is
      // a skip with a stated reason, never a pass.
      const status = outcome.skip ? 'skipped' : outcome.ok ? 'passed' : 'failed';
      results.push({ ...suite, status, detail: outcome.skip || outcome.detail, evidence: outcome.evidence, ms: Date.now() - started });
    } catch (error) {
      results.push({ ...suite, status: 'failed', detail: `suite threw: ${String(error.message || error).slice(0, 240)}`, ms: Date.now() - started });
    }
    process.stdout.write(`  ${{ passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' }[results.at(-1).status]}  ${suite.id}\n`);
  }

  const shot = path.join(root, 'qa', 'acceptance', 'axiom-acceptance.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });

  for (const suite of GATED_SUITES) {
    if (only && suite.id !== only) continue;
    results.push({ ...suite, status: 'skipped', detail: `requires ${suite.needs}` });
    process.stdout.write(`  SKIP  ${suite.id}\n`);
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const report = {
    generatedAt: new Date().toISOString(),
    axiom: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    electron: version.Browser,
    platform: `${process.platform}-${process.arch}`,
    host: os.hostname(),
    totals: { passed, failed: failed.length, skipped },
    // The gate is not "passed" until nothing is skipped, per PRODUCTION_READINESS.md.
    gateStatus: failed.length ? 'FAILED' : skipped ? 'INCOMPLETE' : 'PASSED',
    results: results.map(({ run: _run, needs: _needs, ...keep }) => keep),
  };
  const file = path.join(root, 'qa', 'acceptance', `acceptance-${report.axiom}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  report.reportFile = file;
  report.integrity = crypto.createHash('sha256').update(JSON.stringify(report.results)).digest('hex').slice(0, 16);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`Axiom ${report.axiom} · ${report.platform} · ${report.electron}`);
  console.log(`${passed} passed · ${failed.length} failed · ${skipped} skipped (credential/hardware gated)`);
  console.log(`GATE: ${report.gateStatus}${report.gateStatus === 'INCOMPLETE' ? ' — runtime suites pass; gated suites still unproven' : ''}`);
  for (const f of failed) console.log(`\n  FAILED  ${f.id} (${f.gate})\n          ${f.detail}`);
  console.log(`\nReceipt: ${path.relative(root, file)}  [${report.integrity}]`);
  console.log('='.repeat(64));
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error(`\nAcceptance run could not complete: ${error.message}`);
  if (mainLog.trim()) console.error(`\nAxiom main-process output:\n${mainLog.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  child.kill();
  await sleep(600);
  // Electron can hold profile handles briefly after exit. Cleanup is best-effort:
  // a leftover temp directory must never fail an otherwise good acceptance run.
  if (!keepProfile && !process.env.AXIOM_ACCEPTANCE_PROFILE) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); break; }
      catch { await sleep(700); }
    }
    if (fs.existsSync(profile)) console.warn(`Note: temporary profile left behind at ${profile}`);
  }
}
