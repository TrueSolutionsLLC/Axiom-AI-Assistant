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

// A weather query ("weather 63049", "forecast for St. Louis") never has an
// h3-linked result at all — Google answers it entirely inside an inline
// widget instead, so the h3 walk above legitimately finds nothing even on a
// completely successful, unblocked page load. That widget's ids (wob_wc /
// wob_tm / wob_dc / wob_loc / wob_hm / wob_ws / wob_pp — "wob" = "weather on
// [g]oogle") have been stable for years independent of the rest of the
// page's class-name churn, the same reasoning EXTRACT_SCRIPT already uses
// for h3. Extracted here rather than guessed as a fix, since this sandbox
// cannot load google.com directly to confirm live — flagged as such below.
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
  let weather = null;
  const widget = document.querySelector('#wob_wc');
  if (widget) {
    const temp = clean(document.querySelector('#wob_tm')?.textContent);
    const desc = clean(document.querySelector('#wob_dc')?.textContent);
    if (temp || desc) weather = {
      temp, desc,
      loc: clean(document.querySelector('#wob_loc')?.textContent),
      humidity: clean(document.querySelector('#wob_hm')?.textContent),
      wind: clean(document.querySelector('#wob_ws')?.textContent),
      precip: clean(document.querySelector('#wob_pp')?.textContent),
    };
  }
  // Captured on every pass (cheap, already-loaded DOM) rather than only on
  // failure, so a total-failure error can name the real page Google showed
  // instead of guessing at "consent or verification" — the exact question
  // this bug was reported with no way to answer before.
  return { items, weather, page: { title: document.title, bodyPreview: clean(document.body ? document.body.innerText : '').slice(0, 400) } };
})()`;

interface WeatherSnapshot { temp: string; desc: string; loc: string; humidity: string; wind: string; precip: string }
interface PageSnapshot { title: string; bodyPreview: string }
interface Extraction { items: WebSearchResult[]; weather: WeatherSnapshot | null; page: PageSnapshot }

const weatherAsResult = (weather: WeatherSnapshot | null, url: string): WebSearchResult[] => {
  if (!weather) return [];
  const headline = [weather.temp, weather.desc].filter(Boolean).join(', ');
  const detail = [weather.precip && `Precipitation ${weather.precip}`, weather.humidity && `Humidity ${weather.humidity}`, weather.wind && `Wind ${weather.wind}`].filter(Boolean).join(' · ');
  return [{ title: `Weather${weather.loc ? ` for ${weather.loc}` : ''} — Google`, url, snippet: [headline, detail].filter(Boolean).join(' — ') }];
};

// A blocked/CAPTCHA page and a genuinely empty page both fail the same way
// (zero h3 results, zero weather widget) — the message previously couldn't
// tell them apart. Google's own automation-detection page has used this
// exact phrasing for years.
const automationBlockPattern = /unusual traffic|automated queries|solve this puzzle|verify you're not a robot|recaptcha/i;

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
  let extraction = await window.webContents.executeJavaScript(EXTRACT_SCRIPT, true) as Extraction;
  let results = [...weatherAsResult(extraction.weather, window.webContents.getURL()), ...extraction.items];
  if (!results.length && await dismissConsentIfPresent(window)) {
    await new Promise((resolve) => setTimeout(resolve, 900));
    extraction = await window.webContents.executeJavaScript(EXTRACT_SCRIPT, true) as Extraction;
    results = [...weatherAsResult(extraction.weather, window.webContents.getURL()), ...extraction.items];
  }
  const trimmed = results.slice(0, Math.max(1, Math.min(10, limit)));
  if (!trimmed.length) {
    if (automationBlockPattern.test(extraction.page.title) || automationBlockPattern.test(extraction.page.bodyPreview)) {
      throw new Error("Google flagged this as automated traffic and showed a verification page instead of results (this can happen from a shared or VPN network address) — a plain retry usually will not help until that clears.");
    }
    throw new Error(`Live Google search returned no parseable results. Google's page was titled "${extraction.page.title || 'unknown'}" — it may have shown a consent, verification, or answer-only page instead of standard results, or changed its layout.`);
  }
  return trimmed;
}

export function closeSearchSession(): void {
  if (searchWindow && !searchWindow.isDestroyed()) searchWindow.close();
  searchWindow = null;
}
