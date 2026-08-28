import { BrowserWindow } from 'electron';
import { CONSEQUENTIAL_CONTROL } from './runtimeCore';

let browserWindow: BrowserWindow | null = null;

function safeUrl(value: unknown): URL {
  const url = new URL(String(value ?? '').trim());
  if (url.protocol !== 'https:' || !url.hostname) throw new Error('Axiom Browser only opens explicit HTTPS addresses.');
  return url;
}

function windowForBrowser(): BrowserWindow {
  if (browserWindow && !browserWindow.isDestroyed()) return browserWindow;
  browserWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'Axiom Browser',
    backgroundColor: '#03070c',
    show: false,
    webPreferences: {
      partition: 'persist:axiom-browser',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { void browserWindow?.loadURL(safeUrl(url).toString()); } catch { /* reject non-HTTPS popups */ }
    return { action: 'deny' };
  });
  browserWindow.webContents.on('will-navigate', (event, target) => {
    // safeUrl() only guards the initial load; a page can redirect itself, and
    // readBrowserPage would then hand the model content from a downgraded origin.
    try { safeUrl(target); } catch { event.preventDefault(); }
  });
  browserWindow.on('closed', () => { browserWindow = null; });
  return browserWindow;
}

async function settle(window: BrowserWindow, timeout = 12_000): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) return resolve();
      window.webContents.once('did-stop-loading', () => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, timeout)),
  ]);
}

export async function openBrowserPage(value: unknown): Promise<Record<string, unknown>> {
  const url = safeUrl(value); const window = windowForBrowser();
  await window.loadURL(url.toString()); await settle(window); window.show(); window.focus();
  return { opened: true, url: window.webContents.getURL(), title: window.webContents.getTitle() };
}

export async function readBrowserPage(): Promise<Record<string, unknown>> {
  const window = windowForBrowser();
  if (!window.webContents.getURL()) throw new Error('Open a page in Axiom Browser first.');
  const page = await window.webContents.executeJavaScript(`(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const controls = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]')].slice(0, 300).map((node, index) => ({
      index,
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute('type') || node.getAttribute('role') || '',
      label: clean(node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.innerText || node.getAttribute('name') || node.id).slice(0, 180),
      disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true')
    })).filter((item) => item.label);
    return { title: document.title, url: location.href, text: clean(document.body?.innerText).slice(0, 50000), controls };
  })()`, true) as Record<string, unknown>;
  return page;
}

export async function clickBrowserText(value: unknown): Promise<Record<string, unknown>> {
  const text = String(value ?? '').trim().slice(0, 240); if (!text) throw new Error('Name the link or button to click.');
  const window = windowForBrowser();
  const result = await window.webContents.executeJavaScript(`(() => {
    const wanted = ${JSON.stringify(text.toLowerCase())};
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const nodes = [...document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]')];
    const exact = nodes.find((node) => clean(node.getAttribute('aria-label') || node.innerText || node.value).toLowerCase() === wanted);
    const target = exact || nodes.find((node) => clean(node.getAttribute('aria-label') || node.innerText || node.value).toLowerCase().includes(wanted));
    if (!target) return { clicked: false };
    const label = clean(target.getAttribute('aria-label') || target.innerText || target.value).slice(0, 240);
    // Resolve only; the caller decides whether this label is safe to activate.
    return { found: true, label, matchedExactly: Boolean(exact), index: nodes.indexOf(target) };
  })()`, true) as { found?: boolean; label?: string; matchedExactly?: boolean; index?: number };
  if (!result.found) throw new Error(`No visible browser control matched “${text}”.`);
  const label = String(result.label ?? '');
  // The approval kernel scored the risk of the *requested* text. A loose match
  // must not escalate that: "Continue" resolving to "Continue to payment" would
  // execute a consequential action the user never approved.
  if (!result.matchedExactly && CONSEQUENTIAL_CONTROL.test(label) && !CONSEQUENTIAL_CONTROL.test(text)) {
    throw new Error(`“${text}” loosely matched the control “${label}”, which looks consequential. Read the page and ask again using that exact label so the approval covers the real action.`);
  }
  await window.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]')];
    const target = nodes[${Number(result.index ?? -1)}];
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' }); target.click(); return true;
  })()`, true);
  await settle(window, 5_000);
  return { clicked: true, label, matchedExactly: Boolean(result.matchedExactly), url: window.webContents.getURL(), title: window.webContents.getTitle() };
}

export async function fillBrowserField(labelValue: unknown, value: unknown): Promise<Record<string, unknown>> {
  const label = String(labelValue ?? '').trim().slice(0, 200), text = String(value ?? '').slice(0, 20_000);
  if (!label) throw new Error('Name the browser field to fill.');
  const window = windowForBrowser();
  const result = await window.webContents.executeJavaScript(`(() => {
    const wanted = ${JSON.stringify(label.toLowerCase())}, value = ${JSON.stringify(text)};
    const clean = (item) => String(item || '').replace(/\\s+/g, ' ').trim();
    const fields = [...document.querySelectorAll('input:not([type="hidden"]),textarea,[contenteditable="true"]')];
    const nameFor = (node) => {
      const byFor = node.id ? document.querySelector('label[for="' + CSS.escape(node.id) + '"]') : null;
      const wrapping = node.closest('label');
      return clean(node.getAttribute('aria-label') || node.getAttribute('placeholder') || byFor?.innerText || wrapping?.innerText || node.getAttribute('name') || node.id);
    };
    const exact = fields.find((node) => nameFor(node).toLowerCase() === wanted);
    const target = exact || fields.find((node) => nameFor(node).toLowerCase().includes(wanted));
    if (!target) return { filled: false };
    target.focus();
    if (target.isContentEditable) target.textContent = value; else target.value = value;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true, label: nameFor(target).slice(0, 200), characters: value.length };
  })()`, true) as { filled: boolean; label?: string; characters?: number };
  if (!result.filled) throw new Error(`No browser field matched “${label}”.`);
  return { ...result, url: window.webContents.getURL() };
}

export async function pressBrowserKey(value: unknown): Promise<Record<string, unknown>> {
  const key = String(value ?? '').trim();
  const allowed = new Set(['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','PageUp','PageDown','Home','End']);
  if (!allowed.has(key)) throw new Error('That browser key is not enabled.');
  const window = windowForBrowser(); window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
  await settle(window, 5_000); return { pressed: true, key, url: window.webContents.getURL() };
}

export function closeBrowserSession(): Record<string, unknown> {
  if (!browserWindow || browserWindow.isDestroyed()) return { closed: false, reason: 'No Axiom Browser session is open.' };
  browserWindow.close(); browserWindow = null; return { closed: true };
}
