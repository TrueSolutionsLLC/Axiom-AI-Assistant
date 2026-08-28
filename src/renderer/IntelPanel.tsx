import { FormEvent, useState } from 'react';
import type { ChatMessage, ToolEvent } from '../shared/contracts';

const feeds=[
  {code:'WRLD',title:'WORLD BRIEF',detail:'Top consequential headlines from current sources',command:'Give me a concise live briefing of today’s most consequential world headlines. Search the web, compare reputable sources, and include direct links.'},
  {code:'WX',title:'WEATHER + ALERTS',detail:'Forecast, hazards, and useful timing for my saved location',command:'Search the live weather and official alerts for my saved home location. If my location is not in memory, ask me for it once.'},
  {code:'MKT',title:'MARKET PULSE',detail:'Major indexes, rates, commodities, and unusual moves',command:'Give me a live market pulse: major US indexes, Treasury yields, oil, gold, and the most important unusual move. Include current source links.'},
  {code:'TECH',title:'FRONTIER SIGNAL',detail:'AI, computing, science, and security developments',command:'Search for today’s most important AI, computing, science, and cybersecurity developments. Separate confirmed events from speculation and include source links.'},
];

export function IntelPanel({messages,events,onCommand,busy}:{messages:ChatMessage[];events:ToolEvent[];onCommand:(command:string)=>void;busy:boolean}){
  const [query,setQuery]=useState('');
  const latest=[...messages].reverse().find((message)=>message.role==='assistant'),lastSearch=events.find((event)=>event.name==='web_search');
  const submit=(event:FormEvent)=>{event.preventDefault();if(!query.trim()||busy)return;onCommand(`Search the live web for this and give me a sourced answer: ${query.trim()}`);};
  return <div className="intel-deck"><header><div><span>LI–01 / LIVE RESEARCH CORE</span><b>GLOBAL INTELLIGENCE DECK</b><p>Every briefing forces a current search. Axiom will not fill a missing signal with stale model memory.</p></div><aside className={lastSearch?'live':''}><i/><b>{lastSearch?'SOURCE LINK VERIFIED':'AWAITING QUERY'}</b><span>{lastSearch?new Date(lastSearch.at).toLocaleTimeString():'NO LIVE SEARCH THIS SESSION'}</span></aside></header><div className="intel-feeds">{feeds.map((feed)=><button key={feed.code} onClick={()=>onCommand(feed.command)} disabled={busy}><span>{feed.code}</span><div><b>{feed.title}</b><small>{feed.detail}</small></div><em>↗</em></button>)}</div><form onSubmit={submit}><i>⌕</i><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Ask for any current event, forecast, price, place, person, or fact…"/><button disabled={!query.trim()||busy}>{busy?'CORE BUSY':'SEARCH LIVE'}</button></form><section className="intel-last"><header><span>LAST INTELLIGENCE OUTPUT</span><em>{latest?new Date(latest.createdAt).toLocaleString():'EMPTY'}</em></header><p>{latest?.text||'Run a live signal above. Results and citations will return through the conversation channel.'}</p></section></div>;
}
