import { BrowserWindow } from 'electron';

/**
 * Real Google search results — read out of a real, rendered page, not
 * scraped as raw HTML. Google's plain HTML response requires JavaScript to
 * render results at all (confirmed directly: a bare fetch returns an empty
 * shell that redirects to `/httpservice/retry/enablejs`), so a DuckDuckGo-
 * or Bing-style raw-HTML scrape cannot work here. Axiom is an Electron app,
 * which means it already has a full Chromium renderer available — this
 * loads the search page in a hidden, sandboxed BrowserWindow, lets its own
 * JavaScript actually run, then reads the real rendered result elements out
 * of the DOM afterward, the same way a person's browser would show them.
 *
 * Google's internal class names change without notice and are not a stable
 * contract, so extraction deliberately does not hard-code them: it walks
 * from every real `<h3>` heading (Google's title element has been an h3 for
 * years, independent of the surrounding class churn) up to its enclosing
 * link and result container instead.
 */

let searchWindow: BrowserWindow | null = null;

function windowForSearch(): BrowserWindow {
  if (searchWindow && !searchWindow.isDestroyed()) return searchWindow;
  searchWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    webPreferences: {
      partition: 'persist:axiom-search',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  searchWindow.on('closed', () => { searchWindow = null; });
  return searchWindow;
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

const EXTRACT_SCRIPT = `(() => {
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const seen = new Set();
  const items = [];
  for (const heading of document.querySelectorAll('h3')) {
    const link = heading.closest('a[href^="http"]') || heading.parentElement?.closest('a[href^="http"]');
    if (!link) continue;
    const url = link.href;
    if (seen.has(url) || /google\\.com\\/(search|policies|preferences)/.test(url) || /accounts\\.google\\.com/.test(url)) continue;
    const title = clean(heading.innerText);
    if (!title) continue;
    seen.add(url);
    const container = heading.closest('div[data-hveid]') || heading.closest('div.g') || heading.parentElement?.parentElement?.parentElement || heading.parentElement;
    let snippet = '';
    if (container) {
      const text = clean(container.innerText);
      snippet = (text.startsWith(title) ? text.slice(title.length) : text).trim().slice(0, 300);
    }
    items.push({ title, url, snippet });
  }
  return items;
})()`;

/** A first-run or cookie-cleared session shows a consent interstitial
 * instead of results; there is no h3 heading on that page. Best-effort:
 * click a plausible "accept" control once and re-check, since the
 * persistent partition should remember consent after that. */
async function dismissConsentIfPresent(window: BrowserWindow): Promise<boolean> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const candidates = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')];
    const target = candidates.find((node) => /^(accept all|i agree|agree|accept)$/i.test(clean(node.innerText || node.value)));
    if (!target) return false;
    target.click();
    return true;
  })()`, true) as boolean;
  if (clicked) await settle(window, 8_000);
  return clicked;
}

export interface WebSearchResult { title: string; url: string; snippet: string }

export async function searchGoogle(query: string, limit = 5): Promise<WebSearchResult[]> {
  const clean = query.trim();
  if (!clean) throw new Error('A search query is required.');
  const window = windowForSearch();
  try {
    await window.loadURL(`https://www.google.com/search?q=${encodeURIComponent(clean)}&num=10&hl=en`);
  } catch (error) {
    // A live failure showed loadURL rejecting with ERR_ABORTED (-3) even
    // though the window landed on a real, usable results page right after —
    // a known Chromium/Electron quirk when a page issues its own fast
    // client-side redirect before the original navigation commits. Only
    // treat this as fatal if the window genuinely has nothing loaded.
    const landedUrl = window.webContents.getURL();
    if (!landedUrl || landedUrl === 'about:blank') throw error;
  }
  await settle(window);
  // Google's own script renders results a tick after the network considers
  // the page "settled" — did-stop-loading fires before the DOM is populated.
  await new Promise((resolve) => setTimeout(resolve, 900));
  let results = await window.webContents.executeJavaScript(EXTRACT_SCRIPT, true) as WebSearchResult[];
  if (!results.length && await dismissConsentIfPresent(window)) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    results = await window.webContents.executeJavaScript(EXTRACT_SCRIPT, true) as WebSearchResult[];
  }
  const trimmed = results.slice(0, Math.max(1, Math.min(10, limit)));
  if (!trimmed.length) throw new Error('Live Google search returned no parseable results. Google may have shown a consent or verification page instead of results, or changed its page layout.');
  return trimmed;
}

export function closeSearchSession(): void {
  if (searchWindow && !searchWindow.isDestroyed()) searchWindow.close();
  searchWindow = null;
}
