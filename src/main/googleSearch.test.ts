import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real DOM extraction only runs inside a real Chromium renderer and
// cannot be exercised in a Node test — that part genuinely needs a live app
// run. What IS testable and matters here: the query guard, the
// empty-results-then-retry-consent flow, the specific thrown errors, and
// the result limit — the control flow around the untestable DOM read.
let executeJavaScriptMock: ReturnType<typeof vi.fn>;
let loadURLMock: ReturnType<typeof vi.fn>;
let landedUrl = 'https://www.google.com/search?q=test';

vi.mock('electron', () => {
  class MockWebContents {
    loading = false;
    isLoading() { return this.loading; }
    once() { /* did-stop-loading never needed: loading starts false */ }
    executeJavaScript(...args: unknown[]) { return (executeJavaScriptMock as (...a: unknown[]) => unknown)(...args); }
    getURL() { return landedUrl; }
  }
  class MockBrowserWindow {
    webContents = new MockWebContents();
    private destroyed = false;
    loadURL(...args: unknown[]) { return (loadURLMock as (...a: unknown[]) => unknown)(...args); }
    isDestroyed() { return this.destroyed; }
    on() { /* no-op */ }
    close() { this.destroyed = true; }
  }
  return { BrowserWindow: MockBrowserWindow };
});

import { closeSearchSession, searchGoogle } from './googleSearch';

describe('searchGoogle — control flow around the untestable live DOM read', () => {
  beforeEach(() => {
    executeJavaScriptMock = vi.fn();
    loadURLMock = vi.fn(async () => {});
    landedUrl = 'https://www.google.com/search?q=test';
    closeSearchSession();
  });

  it('tolerates loadURL rejecting with ERR_ABORTED when the window landed on a real page anyway — the exact live failure', async () => {
    loadURLMock.mockRejectedValueOnce(new Error("ERR_ABORTED (-3) loading 'https://www.google.com/search?q=weather'"));
    executeJavaScriptMock.mockResolvedValueOnce({ items: [{ title: 'Weather result', url: 'https://weather.example/', snippet: 'forecast' }], weather: null, page: { title: '', bodyPreview: '' } });
    const results = await searchGoogle('weather');
    expect(results).toEqual([{ title: 'Weather result', url: 'https://weather.example/', snippet: 'forecast' }]);
  }, 10_000);

  it('still fails when loadURL rejects and the window landed nowhere real', async () => {
    loadURLMock.mockRejectedValueOnce(new Error('ERR_ABORTED (-3)'));
    landedUrl = '';
    await expect(searchGoogle('test query')).rejects.toThrow(/ERR_ABORTED/);
    expect(executeJavaScriptMock).not.toHaveBeenCalled();
  }, 10_000);

  it('rejects an empty query before loading any page', async () => {
    await expect(searchGoogle('   ')).rejects.toThrow(/query is required/i);
    expect(loadURLMock).not.toHaveBeenCalled();
  });

  it('returns results directly when the first extraction succeeds', async () => {
    executeJavaScriptMock.mockResolvedValueOnce({ items: [
      { title: 'A', url: 'https://a.example/', snippet: 'first' },
      { title: 'B', url: 'https://b.example/', snippet: 'second' },
    ], weather: null, page: { title: '', bodyPreview: '' } });
    const results = await searchGoogle('test query');
    expect(results).toEqual([
      { title: 'A', url: 'https://a.example/', snippet: 'first' },
      { title: 'B', url: 'https://b.example/', snippet: 'second' },
    ]);
    expect(loadURLMock).toHaveBeenCalledWith(expect.stringContaining('google.com/search?q=test'));
  }, 10_000);

  it('respects the limit parameter', async () => {
    executeJavaScriptMock.mockResolvedValueOnce({ items: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://x.example/${i}`, snippet: '' })), weather: null, page: { title: '', bodyPreview: '' } });
    const results = await searchGoogle('test query', 3);
    expect(results).toHaveLength(3);
  }, 10_000);

  it('retries once via a consent dismiss when the first pass finds nothing, then succeeds', async () => {
    executeJavaScriptMock
      .mockResolvedValueOnce({ items: [], weather: null, page: { title: 'Before you continue', bodyPreview: '' } }) // first extraction: empty (consent page)
      .mockResolvedValueOnce(true) // consent-dismiss click: found and clicked
      .mockResolvedValueOnce({ items: [{ title: 'Real result', url: 'https://real.example/', snippet: 'after consent' }], weather: null, page: { title: 'test query - Google Search', bodyPreview: '' } }); // second extraction
    const results = await searchGoogle('test query');
    expect(results).toEqual([{ title: 'Real result', url: 'https://real.example/', snippet: 'after consent' }]);
    expect(executeJavaScriptMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('throws a specific error naming the real page title when nothing is found and no consent button exists either', async () => {
    executeJavaScriptMock
      .mockResolvedValueOnce({ items: [], weather: null, page: { title: 'test query - Google Search', bodyPreview: 'About 0 results' } }) // first extraction: empty
      .mockResolvedValueOnce(false); // no consent button found — no retry extraction happens
    await expect(searchGoogle('test query')).rejects.toThrow(/no parseable results.*test query - Google Search/i);
    expect(executeJavaScriptMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('surfaces Google\'s own automation-detection page by name instead of a generic "no results" message', async () => {
    executeJavaScriptMock
      .mockResolvedValueOnce({ items: [], weather: null, page: { title: 'About this page', bodyPreview: 'Our systems have detected unusual traffic from your computer network. Please complete the recaptcha below.' } })
      .mockResolvedValueOnce(false);
    await expect(searchGoogle('test query')).rejects.toThrow(/automated traffic/i);
    expect(executeJavaScriptMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  // "weather 63049" / "forecast for X" never produce an h3-linked result at
  // all — Google answers those entirely inside its inline weather widget, so
  // the h3 walk finding nothing there is expected, not a failure.
  it('returns a real result from the weather widget even when there are zero h3-linked results', async () => {
    executeJavaScriptMock.mockResolvedValueOnce({
      items: [],
      weather: { temp: '72°F', desc: 'Sunny', loc: 'Washington, MO', humidity: '45%', wind: '8 mph', precip: '2%' },
      page: { title: 'weather 63049 - Google Search', bodyPreview: '' },
    });
    const results = await searchGoogle('weather 63049');
    expect(results).toHaveLength(1);
    expect(results[0].title).toContain('Washington, MO');
    expect(results[0].snippet).toContain('72°F');
    expect(results[0].snippet).toContain('Sunny');
  }, 10_000);

  it('places the weather result first, ahead of any ordinary h3 results also present', async () => {
    executeJavaScriptMock.mockResolvedValueOnce({
      items: [{ title: 'Weather.com forecast', url: 'https://weather.com/', snippet: 'ten day forecast' }],
      weather: { temp: '55°F', desc: 'Cloudy', loc: 'St. Louis, MO', humidity: '', wind: '', precip: '' },
      page: { title: '', bodyPreview: '' },
    });
    const results = await searchGoogle('weather');
    expect(results[0].title).toContain('Weather for St. Louis, MO');
    expect(results[1].title).toBe('Weather.com forecast');
  }, 10_000);
});
