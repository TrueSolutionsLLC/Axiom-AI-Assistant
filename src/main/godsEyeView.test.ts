import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// GodsEyeViewManager only touches three real-world surfaces: fs (to check
// the project folder), child_process.spawn (to run `npm run dev`), and
// electron's WebContentsView (to embed the running page). fetch is
// global and stubbed directly per test rather than mocked at module level,
// since its behavior (ready vs not-ready) is what each test is exercising.
const spawnedCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let fakeChild: { stdout: { pipe: () => void }; stderr: { pipe: () => void }; on: (event: string, cb: (...args: unknown[]) => void) => void; kill: () => void; killed: boolean };

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawnedCalls.push({ command, args, options });
    fakeChild = { stdout: { pipe: () => {} }, stderr: { pipe: () => {} }, on: () => {}, kill: () => { fakeChild.killed = true; }, killed: false };
    return fakeChild;
  },
}));

const addedViews: Array<{ webContents: { loadURL: ReturnType<typeof vi.fn>; getURL: ReturnType<typeof vi.fn>; executeJavaScript: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn>; isLoading: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn> } }> = [];
vi.mock('electron', () => ({
  WebContentsView: class {
    // isLoading() false + once() a no-op: waitForLoad() resolves
    // immediately in tests rather than actually waiting on a real page —
    // reload() itself is still a real, asserted call.
    webContents = { loadURL: vi.fn(async () => {}), getURL: vi.fn(() => ''), executeJavaScript: vi.fn(async () => {}), close: vi.fn(), reload: vi.fn(), isLoading: vi.fn(() => false), once: vi.fn() };
    constructor() { addedViews.push(this as never); }
  },
}));

import { GodsEyeViewManager } from './godsEyeView';

const fakeWindow = () => ({
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
} as unknown as import('electron').BrowserWindow);

const projectDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gev-'));

describe('GodsEyeViewManager', () => {
  beforeEach(() => { spawnedCalls.length = 0; addedViews.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('refuses to open with no project folder configured, without touching fs or fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const manager = new GodsEyeViewManager(fakeWindow());
    const result = await manager.open('   ');
    expect(result).toMatchObject({ ready: false });
    expect(result.error).toMatch(/Settings/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a clear error when the configured folder isn't a real project (no package.json)", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-gev-empty-'));
    const result = await manager.open(dir);
    expect(result.ready).toBe(false);
    expect(result.error).toContain(dir);
    expect(spawnedCalls).toHaveLength(0);
  });

  it('skips starting the server when it is already running, and embeds the view directly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const result = await manager.open(dir);
    expect(result).toEqual({ ready: true, url: 'http://localhost:4173/' });
    expect(spawnedCalls).toHaveLength(0);
    expect(addedViews).toHaveLength(1);
    expect(addedViews[0].webContents.loadURL).toHaveBeenCalledWith('http://localhost:4173/');
  });

  it('reuses the same embedded view on a second open() instead of creating another', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await manager.open(dir);
    expect(addedViews).toHaveLength(1);
  });

  it('spawns the dev server when not yet ready, and starts it only once for concurrent opens', async () => {
    vi.useFakeTimers();
    let readyAfter = 2, calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; if (calls < readyAfter) throw new Error('not up yet'); return { status: 200 }; }));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const opening = Promise.all([manager.open(dir), manager.open(dir)]);
    await vi.advanceTimersByTimeAsync(2_000);
    const [first, second] = await opening;
    expect(first).toEqual({ ready: true, url: 'http://localhost:4173/' });
    expect(second).toEqual({ ready: true, url: 'http://localhost:4173/' });
    // One real server process for both concurrent open() calls — the second
    // caller awaits the same in-flight start rather than spawning again.
    expect(spawnedCalls).toHaveLength(1);
  });

  it('flyTo refuses to move a camera that was never opened', async () => {
    const manager = new GodsEyeViewManager(fakeWindow());
    await expect(manager.flyTo({ lat: 10, lon: 20 })).rejects.toThrow(/not open/);
  });

  it('flyTo rejects out-of-range coordinates before touching the view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await expect(manager.flyTo({ lat: 200, lon: 20 })).rejects.toThrow(/Latitude/);
    await expect(manager.flyTo({ lat: 10, lon: -400 })).rejects.toThrow(/Longitude/);
    expect(addedViews[0].webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('flyTo drives the already-open view by patching the real observed URL hash fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await manager.flyTo({ lat: 35.6, lon: 139.7, alt: 5000, heading: 90, pitch: -10 });
    const script = addedViews[0].webContents.executeJavaScript.mock.calls[0][0] as string;
    expect(script).toContain('"lat":"35.6"');
    expect(script).toContain('"lon":"139.7"');
    expect(script).toContain('"alt":"5000"');
    expect(script).toContain('"heading":"90"');
    expect(script).toContain('"pitch":"-10"');
  });

  // The real live bug this was built to fix: Robbie's Axiom logged a
  // "verified" flyTo, but the visible camera never moved. Root cause,
  // confirmed by reading the real app's own source (src/sharelink.js): it
  // parses location.hash exactly once at initial mount and has no
  // hashchange listener at all, so writing the hash on an already-running
  // page is silently inert. reload() is the only mechanism confirmed to
  // make it re-apply.
  it('flyTo forces a real reload after writing the hash, since the app only reads its hash once at initial mount', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await manager.flyTo({ lat: 38.627, lon: -90.1994 });
    expect(addedViews[0].webContents.reload).toHaveBeenCalledTimes(1);
    // The hash write must happen BEFORE the reload, or the reload would
    // just reapply whatever was already there.
    const hashCallOrder = addedViews[0].webContents.executeJavaScript.mock.invocationCallOrder[0];
    const reloadCallOrder = addedViews[0].webContents.reload.mock.invocationCallOrder[0];
    expect(hashCallOrder).toBeLessThan(reloadCallOrder);
  });

  it('setLayers also forces a reload after writing the hash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await manager.setLayers(['flights']);
    expect(addedViews[0].webContents.reload).toHaveBeenCalledTimes(1);
  });

  // A second real bug found while fixing the first: open_gods_eye_view
  // re-opening an already-open, already-positioned view used to compare the
  // view's current URL against the bare URL with strict equality — since a
  // real flyTo()/setLayers() call leaves a #hash on the URL, that check
  // always failed and silently reloaded the view back to its bare default,
  // wiping the camera position and every enabled layer.
  it('reopening an already-positioned view does not reset its hash back to the bare default URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await manager.flyTo({ lat: 38.627, lon: -90.1994 });
    addedViews[0].webContents.getURL.mockReturnValue('http://localhost:4173/#v=2&lat=38.627&lon=-90.1994');
    addedViews[0].webContents.loadURL.mockClear();
    await manager.open(dir);
    expect(addedViews[0].webContents.loadURL).not.toHaveBeenCalled();
  });

  // The real bug this was built to fix: flyTo() used to overwrite the whole
  // hash, which would have silently turned off any layer a prior
  // setLayers() call had enabled — now every write merges into whatever's
  // already there via URLSearchParams, so camera and layer state never
  // clobber each other.
  it('setLayers turns on a real layer by its correct single-character token, merging rather than overwriting the hash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    const result = await manager.setLayers(['flights']);
    expect(result).toEqual(['flights']);
    expect(manager.currentLayers).toEqual(['flights']);
    const script = addedViews[0].webContents.executeJavaScript.mock.calls[0][0] as string;
    expect(script).toContain('"l":"f"');
    expect(script).toContain("location.hash.slice(1)");
  });

  it('setLayers accumulates multiple enabled layers and can disable one without clearing the rest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await manager.setLayers(['flights']);
    await manager.setLayers(['satellites']);
    expect(manager.currentLayers.sort()).toEqual(['flights', 'satellites']);
    await manager.setLayers([], ['flights']);
    expect(manager.currentLayers).toEqual(['satellites']);
  });

  it('setLayers rejects an unknown layer id up front rather than silently doing nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await expect(manager.setLayers(['drones' as never])).rejects.toThrow(/Unknown/);
    expect(manager.currentLayers).toEqual([]);
  });

  it('close() resets tracked layer state, so reopening does not silently claim stale layers are still on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    await manager.setLayers(['flights']);
    manager.close();
    expect(manager.currentLayers).toEqual([]);
  });

  it('close() removes the view from the window and clears isOpen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const window = fakeWindow();
    const manager = new GodsEyeViewManager(window);
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    await manager.open(dir);
    expect(manager.isOpen).toBe(true);
    manager.close();
    expect(manager.isOpen).toBe(false);
    expect((window.contentView.removeChildView as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('destroy() closes the view and kills the server process', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('not up'); }));
    vi.useFakeTimers();
    const manager = new GodsEyeViewManager(fakeWindow());
    const dir = projectDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const opening = manager.open(dir);
    await vi.advanceTimersByTimeAsync(20_500);
    await opening;
    expect(spawnedCalls).toHaveLength(1);
    manager.destroy();
    expect(fakeChild.killed).toBe(true);
  });
});
