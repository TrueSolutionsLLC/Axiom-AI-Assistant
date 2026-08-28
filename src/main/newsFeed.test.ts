import { describe, expect, it, vi } from 'vitest';
import { getNewsHeadlines } from './newsFeed';

const sampleRss = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[Major story breaks worldwide - Reuters]]></title>
    <link>https://news.google.com/rss/articles/abc123?oc=5</link>
    <pubDate>Mon, 24 Aug 2026 18:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Second headline of the day - Associated Press]]></title>
    <link>https://news.google.com/rss/articles/def456?oc=5</link>
    <pubDate>Mon, 24 Aug 2026 17:30:00 GMT</pubDate>
  </item>
</channel></rss>`;

describe('getNewsHeadlines — real headline text, not homepage links', () => {
  it('splits "Title - Source" into separate real fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sampleRss, { status: 200 })));
    const headlines = await getNewsHeadlines();
    expect(headlines).toEqual([
      { title: 'Major story breaks worldwide', source: 'Reuters', link: 'https://news.google.com/rss/articles/abc123?oc=5', publishedAt: 'Mon, 24 Aug 2026 18:00:00 GMT' },
      { title: 'Second headline of the day', source: 'Associated Press', link: 'https://news.google.com/rss/articles/def456?oc=5', publishedAt: 'Mon, 24 Aug 2026 17:30:00 GMT' },
    ]);
    vi.unstubAllGlobals();
  });

  it('scopes to a specific outlet with a site: query', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { capturedUrl = String(url); return new Response(sampleRss, { status: 200 }); }));
    await getNewsHeadlines('site:nypost.com');
    expect(capturedUrl).toContain('q=site%3Anypost.com');
    expect(capturedUrl).toContain('news.google.com/rss/search');
    vi.unstubAllGlobals();
  });

  it('uses the general top-stories feed when no query is given', async () => {
    let capturedUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { capturedUrl = String(url); return new Response(sampleRss, { status: 200 }); }));
    await getNewsHeadlines();
    expect(capturedUrl).toBe('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en');
    vi.unstubAllGlobals();
  });

  it('throws a specific error on a non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(getNewsHeadlines()).rejects.toThrow(/HTTP 503/);
    vi.unstubAllGlobals();
  });

  it('throws a specific error when nothing parses, naming the query', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<rss><channel></channel></rss>', { status: 200 })));
    await expect(getNewsHeadlines('a very obscure topic')).rejects.toThrow(/No live headlines found for "a very obscure topic"/);
    vi.unstubAllGlobals();
  });
});
