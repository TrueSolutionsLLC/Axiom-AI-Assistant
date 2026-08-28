/**
 * Real, current news headlines — a different problem from general web
 * search. A live user tried "top world headlines" and "New York Post
 * headlines" through web_search and got back category/homepage links, not
 * article text: a general search index is not built for "what's the news
 * right now," and Axiom correctly refused to invent headlines it didn't
 * actually have. Google News' public RSS feed is: real per-article titles,
 * real links, real source names and timestamps, no API key, and it
 * supports both a general top-stories feed and a scoped query (including
 * `site:` restriction, which covers "check the New York Post" directly).
 */

export interface NewsHeadline { title: string; source: string; link: string; publishedAt?: string }

function stripHtml(fragment:string):string{
  return fragment.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
}

/** Google News titles a per-article item as "Headline - Source Name"; split
 * that back into the two real fields instead of leaving the source glued
 * onto the title text. */
function splitTitleSource(raw:string):{title:string;source:string}{
  const clean=stripHtml(raw);
  const at=clean.lastIndexOf(' - ');
  return at>0?{title:clean.slice(0,at).trim(),source:clean.slice(at+3).trim()}:{title:clean,source:''};
}

export async function getNewsHeadlines(query?:string,limit=8):Promise<NewsHeadline[]>{
  const clean=query?.trim();
  const url=clean
    ?`https://news.google.com/rss/search?q=${encodeURIComponent(clean)}&hl=en-US&gl=US&ceid=US:en`
    :'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
  const response=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'},signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error(`Live news feed failed (HTTP ${response.status}).`);
  const xml=await response.text();
  const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const headlines:NewsHeadline[]=items.slice(0,Math.max(1,Math.min(20,limit))).map((match)=>{
    const item=match[1];
    const rawTitle=/<title>([\s\S]*?)<\/title>/.exec(item)?.[1]||'';
    const link=stripHtml(/<link>([\s\S]*?)<\/link>/.exec(item)?.[1]||'');
    const pubDate=stripHtml(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)?.[1]||'');
    const {title,source}=splitTitleSource(rawTitle);
    return {title,source,link,publishedAt:pubDate||undefined};
  }).filter((headline)=>headline.title&&/^https?:\/\//.test(headline.link));
  if(!headlines.length)throw new Error(clean?`No live headlines found for "${clean}".`:'The live news feed returned no parseable headlines.');
  return headlines;
}
