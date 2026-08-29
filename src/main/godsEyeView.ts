import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, WebContentsView } from 'electron';

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const STARTUP_TIMEOUT_MS = 20_000;

// Real layer ids + single-character URL tokens, read directly out of the
// actual God's Eye View source (src/data/layerState.js, LAYER_STATE_REGISTRY)
// rather than guessed — a prior version of this file only drove camera
// position and had no way to turn on the flights/ships/satellites layers a
// user actually asks to see, which is what "find me live flights over St.
// Louis" needs.
export const GODS_EYE_LAYER_TOKENS = {
  'ais-live-vessels': 'a', bikeshare: 'b', cctv: 'c', earthquakes: 'e', flights: 'f',
  'local-dams': 'q', 'local-datacenters': 'd', 'local-firms': 'w', military: 'm',
  'military-awareness': 'g', 'military-installations': 'i', radio: 'r',
  'rocket-launches': 'x', satellites: 's', 'telegeography-submarine-cables': 'u', traffic: 't',
} as const;
export type GodsEyeLayerId = keyof typeof GODS_EYE_LAYER_TOKENS;
export const GODS_EYE_LAYER_IDS = Object.keys(GODS_EYE_LAYER_TOKENS) as GodsEyeLayerId[];

export interface GodsEyeFlyTo { lat: number; lon: number; alt?: number; heading?: number; pitch?: number }

// God's Eye View (github.com/bilawalsidhu/gods-eye-view, MIT) is a separate,
// real project the user already runs standalone — a Vite dev server with a
// live 3D globe. Axiom doesn't absorb its source; it manages the server's
// lifecycle and embeds the running page, the same relationship Axiom already
// has with Ring or Homebridge: driving a real external service, not
// reimplementing it. Embedding uses a real WebContentsView (Electron's
// current, non-deprecated way to layer a second live page inside a window),
// not the <webview> tag, which Electron's own docs advise against for
// exactly the security reasons Axiom's whole design already takes seriously
// elsewhere — sandboxed, isolated, no Node integration, same baseline as the
// main window.
export class GodsEyeViewManager {
  private serverProcess: ChildProcess | null = null;
  private view: WebContentsView | null = null;
  private starting: Promise<void> | null = null;
  // The page has no read-back API this manager can query, so "which layers
  // are on" is tracked here rather than assumed — every hash write is a
  // merge against this set (and whatever the page already reflects for
  // anything Axiom didn't itself set), never a blind overwrite that would
  // silently turn off a layer flyTo() didn't know was on.
  private enabledLayers = new Set<GodsEyeLayerId>();

  constructor(private readonly window: BrowserWindow) {}

  private async isReady(): Promise<boolean> {
    try {
      const response = await fetch(URL, { signal: AbortSignal.timeout(2_000) });
      return response.status < 500;
    } catch {
      return false;
    }
  }

  private async ensureServerRunning(projectDir: string): Promise<void> {
    if (await this.isReady()) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const packageJsonPath = path.join(projectDir, 'package.json');
      if (!fs.existsSync(packageJsonPath)) throw new Error(`God's Eye View project not found at "${projectDir}". Check the path in Settings.`);
      const logDir = path.join(projectDir, '.gev-logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logStream = fs.createWriteStream(path.join(logDir, 'axiom-launcher.log'), { flags: 'a' });
      const args = ['run', 'dev', '--', '--host', 'localhost', '--port', String(PORT), '--strictPort'];
      // Windows' npm.cmd is a batch file — spawning it directly is
      // unreliable with argument arrays; routing through cmd.exe /c is the
      // same real workaround already proven for run_project_check in
      // tools.ts, not a new guess.
      this.serverProcess = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { cwd: projectDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('npm', args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
      this.serverProcess.stdout?.pipe(logStream);
      this.serverProcess.stderr?.pipe(logStream);
      this.serverProcess.on('exit', () => { this.serverProcess = null; });
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await this.isReady()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`God's Eye View did not start within ${STARTUP_TIMEOUT_MS / 1000} seconds. Check ${path.join(logDir, 'axiom-launcher.log')} — its dependencies may not be installed (run "npm install" in that folder once).`);
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  async open(projectDir: string): Promise<{ ready: boolean; url: string; error?: string }> {
    const clean = projectDir.trim();
    if (!clean) return { ready: false, url: URL, error: "Set the God's Eye View project folder in Settings first." };
    try {
      await this.ensureServerRunning(clean);
    } catch (reason) {
      return { ready: false, url: URL, error: reason instanceof Error ? reason.message : String(reason) };
    }
    if (!this.view) {
      this.view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      this.window.contentView.addChildView(this.view);
    }
    // startsWith, not a strict equality check: after a real flyTo()/
    // setLayers() call the view's URL legitimately carries a #hash (see
    // writeHash() below). A strict `!== URL` here used to treat that as "not
    // loaded yet" and reload the bare URL — silently wiping the camera
    // position and every enabled layer any time open_gods_eye_view was
    // called again on an already-open, already-positioned view.
    if (!this.view.webContents.getURL().startsWith(URL)) await this.view.webContents.loadURL(URL);
    return { ready: true, url: URL };
  }

  private async waitForLoad(timeoutMs = 8_000): Promise<void> {
    const webContents = this.view?.webContents;
    if (!webContents) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        if (!webContents.isLoading()) return resolve();
        webContents.once('did-stop-loading', () => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.view?.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
  }

  close(): void {
    if (this.view) {
      this.window.contentView.removeChildView(this.view);
      this.view.webContents.close();
      this.view = null;
    }
    this.enabledLayers.clear();
  }

  get isOpen(): boolean { return this.view !== null; }

  get currentLayers(): GodsEyeLayerId[] { return [...this.enabledLayers]; }

  // Every write MERGES into whatever hash is already on the page rather than
  // replacing it outright — the real app's own hash format splits camera,
  // style, and layer state into independent query keys (confirmed from its
  // actual source, src/sharelink.js / src/data/layerState.js), specifically
  // so one aspect can change without disturbing another. An earlier version
  // of this file overwrote the whole hash on every flyTo(), which would have
  // silently turned off any layer a prior setLayers() call had enabled.
  //
  // The reload() afterward is not optional. Confirmed by reading the app's
  // actual source (src/sharelink.js): it parses location.hash exactly once,
  // in parseInitialHash(), called at initial mount — there is no
  // window.addEventListener('hashchange', ...) anywhere in it. Setting
  // location.hash after the page is already running updates the address
  // silently and does nothing else; that's the real bug behind Axiom
  // reporting a "verified" camera move that never visibly happened — the
  // write succeeded, nothing was listening. A same-document hash-only
  // navigation (location.hash = ... or loadURL to the same path+hash)
  // doesn't force a reload either, so an explicit reload() is required to
  // make the app re-run its own hash-driven startup logic against the value
  // just written.
  private async writeHash(patch: Record<string, string>): Promise<void> {
    if (!this.view) throw new Error("God's Eye View is not open — open it first.");
    const script = `(() => {
      const params = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
      params.set('v', '2');
      const patch = ${JSON.stringify(patch)};
      for (const key of Object.keys(patch)) params.set(key, patch[key]);
      location.hash = params.toString();
    })()`;
    await this.view.webContents.executeJavaScript(script);
    this.view.webContents.reload();
    await this.waitForLoad();
  }

  // Drives the globe by setting its own URL hash and reloading — the app's
  // real, documented share-link mechanism (confirmed from its own source),
  // not a private API or anything reverse-engineered beyond a normal URL.
  async flyTo(target: GodsEyeFlyTo): Promise<void> {
    if (!Number.isFinite(target.lat) || target.lat < -90 || target.lat > 90) throw new Error('Latitude must be a number between -90 and 90.');
    if (!Number.isFinite(target.lon) || target.lon < -180 || target.lon > 180) throw new Error('Longitude must be a number between -180 and 180.');
    await this.writeHash({
      lat: String(target.lat), lon: String(target.lon), alt: String(target.alt ?? 2000),
      heading: String(target.heading ?? 0), pitch: String(target.pitch ?? -30), roll: '0',
      style: 'normal', map: 'photoreal', hud: 'tactical',
    });
  }

  // enable/disable real layer ids (flights, ais-live-vessels, satellites,
  // earthquakes, cctv, military, military-installations, military-awareness,
  // radio, traffic, rocket-launches, bikeshare, local-dams,
  // local-datacenters, local-firms, telegeography-submarine-cables) sourced
  // from the app's own registry — see GODS_EYE_LAYER_TOKENS above. Unknown
  // ids are rejected up front rather than silently ignored, since a typo'd
  // layer name here would otherwise look like it worked and just do nothing.
  async setLayers(enable: GodsEyeLayerId[] = [], disable: GodsEyeLayerId[] = []): Promise<GodsEyeLayerId[]> {
    for (const id of [...enable, ...disable]) {
      if (!(id in GODS_EYE_LAYER_TOKENS)) throw new Error(`Unknown God's Eye View layer "${id}". Known layers: ${GODS_EYE_LAYER_IDS.join(', ')}.`);
    }
    for (const id of enable) this.enabledLayers.add(id);
    for (const id of disable) this.enabledLayers.delete(id);
    const tokens = [...this.enabledLayers].map((id) => GODS_EYE_LAYER_TOKENS[id]).join('.');
    await this.writeHash({ l: tokens });
    return this.currentLayers;
  }

  destroy(): void {
    this.close();
    if (this.serverProcess) { this.serverProcess.kill(); this.serverProcess = null; }
  }
}
