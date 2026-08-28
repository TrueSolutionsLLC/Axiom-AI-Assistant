import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { checkForUpdate, compareVersions, downloadVerifiedUpdate } from './updater';

describe('version comparison', () => {
  it('orders major, minor, and patch correctly', () => {
    expect(compareVersions('3.1.0', '3.0.5')).toBeGreaterThan(0);
    expect(compareVersions('3.0.5', '3.1.0')).toBeLessThan(0);
    expect(compareVersions('3.0.5', '3.0.5')).toBe(0);
    expect(compareVersions('3.0.10', '3.0.9')).toBeGreaterThan(0);
    expect(compareVersions('4.0.0', '3.9.9')).toBeGreaterThan(0);
  });
  it('rejects a malformed version rather than guessing', () => {
    expect(() => compareVersions('3.0', '3.0.0')).toThrow();
    expect(() => compareVersions('v3.0.0', '3.0.0')).toThrow();
  });
});

// A minimal local HTTP server stands in for the update feed and CDN, so these
// tests exercise the real fetch/stream/verify path without any network access.
function serve(routes: Record<string, { status?: number; type?: string; body: Buffer | string }>) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url || ''];
    if (!route) { res.writeHead(404); res.end(); return; }
    res.writeHead(route.status ?? 200, { 'content-type': route.type ?? 'application/octet-stream' });
    res.end(route.body);
  });
  return new Promise<{ url: (p: string) => string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: (p) => `http://127.0.0.1:${port}${p}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('checkForUpdate', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  it('reports an available update from a valid manifest', async () => {
    const manifest = { schema: 1, channel: 'stable', latestVersion: '3.1.0', minimumSupportedVersion: '3.0.0', publishedAt: new Date().toISOString(), artifacts: { win: { url: 'https://cdn.example/Axiom-Setup-3.1.0.exe', sha256: 'a'.repeat(64), bytes: 1000 } } };
    const server = await serve({ '/manifest.json': { body: JSON.stringify(manifest) } });
    close = server.close;
    const result = await checkForUpdate(server.url('/manifest.json'), '3.0.5', 'win');
    expect(result.updateAvailable).toBe(true);
    expect(result.mustUpdate).toBe(false);
    expect(result.artifact?.url).toContain('3.1.0');
  });

  it('flags mustUpdate when the running version is below the minimum supported', async () => {
    const manifest = { schema: 1, channel: 'stable', latestVersion: '3.1.0', minimumSupportedVersion: '3.0.5', publishedAt: new Date().toISOString(), artifacts: {} };
    const server = await serve({ '/manifest.json': { body: JSON.stringify(manifest) } });
    close = server.close;
    const result = await checkForUpdate(server.url('/manifest.json'), '3.0.0', 'win');
    expect(result.mustUpdate).toBe(true);
  });

  it('refuses a manifest whose artifact URL is neither HTTPS nor loopback', async () => {
    const manifest = { schema: 1, channel: 'stable', latestVersion: '3.1.0', minimumSupportedVersion: '3.0.0', publishedAt: new Date().toISOString(), artifacts: { win: { url: 'http://cdn.example/insecure.exe', sha256: 'a'.repeat(64), bytes: 10 } } };
    const server = await serve({ '/manifest.json': { body: JSON.stringify(manifest) } });
    close = server.close;
    await expect(checkForUpdate(server.url('/manifest.json'), '3.0.0', 'win')).rejects.toThrow(/HTTPS/i);
  });

  it('refuses a malformed manifest instead of guessing its shape', async () => {
    const server = await serve({ '/manifest.json': { body: JSON.stringify({ schema: 1, latestVersion: 'not-a-version' }) } });
    close = server.close;
    await expect(checkForUpdate(server.url('/manifest.json'), '3.0.0', 'win')).rejects.toThrow(/invalid latestVersion/i);
  });

  it('refuses a feed URL that is not HTTPS before making any request', async () => {
    await expect(checkForUpdate('http://feed.example/manifest.json', '3.0.0', 'win')).rejects.toThrow(/HTTPS/i);
  });
});

describe('downloadVerifiedUpdate', () => {
  let close: (() => Promise<void>) | undefined;
  let dir = '';
  afterEach(async () => { await close?.(); close = undefined; if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('accepts a download whose hash matches the manifest', async () => {
    const payload = Buffer.from('a real installer payload, standing in for an exe/dmg');
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
    const server = await serve({ '/Axiom-Setup-3.1.0.exe': { body: payload } });
    close = server.close;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-update-'));
    const file = await downloadVerifiedUpdate({ url: server.url('/Axiom-Setup-3.1.0.exe'), sha256, bytes: payload.length }, dir);
    expect(fs.readFileSync(file)).toEqual(payload);
  });

  it('deletes and refuses a download whose bytes were tampered with in transit', async () => {
    const real = Buffer.from('the real installer');
    const tampered = Buffer.from('a different, tampered installer payload');
    const sha256 = crypto.createHash('sha256').update(real).digest('hex');
    const server = await serve({ '/Axiom-Setup-3.1.0.exe': { body: tampered } });
    close = server.close;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-update-'));
    await expect(downloadVerifiedUpdate({ url: server.url('/Axiom-Setup-3.1.0.exe'), sha256, bytes: tampered.length }, dir)).rejects.toThrow(/integrity verification/i);
    // The half-written file must not be left where anything could run it.
    expect(fs.readdirSync(dir).filter((name) => !name.endsWith('.download'))).toHaveLength(0);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('rejects a response whose length does not match the declared size, even if the hash of the truncated bytes happens to differ', async () => {
    const payload = Buffer.from('short');
    const server = await serve({ '/Axiom-Setup-3.1.0.exe': { body: payload } });
    close = server.close;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-update-'));
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
    await expect(downloadVerifiedUpdate({ url: server.url('/Axiom-Setup-3.1.0.exe'), sha256, bytes: payload.length + 500 }, dir)).rejects.toThrow(/manifest declared/i);
  });
});
