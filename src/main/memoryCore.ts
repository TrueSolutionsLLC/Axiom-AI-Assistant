import type { MemoryItem, MemoryKind } from '../shared/contracts';

const memoryKinds:MemoryKind[]=['fact','preference','person','project','decision','instruction'];

export function normalizeMemoryRecord(item:Partial<MemoryItem>):MemoryItem|undefined{
  if(!item||typeof item.id!=='string'||typeof item.text!=='string'||!item.text.trim())return undefined;
  const createdAt=item.createdAt||new Date().toISOString();
  return{id:item.id,text:item.text.trim().slice(0,2000),kind:memoryKinds.includes(item.kind as MemoryKind)?item.kind as MemoryKind:'fact',status:item.status==='superseded'?'superseded':'active',origin:item.origin==='assistant-inferred'||item.origin==='imported'?item.origin:'user-explicit',confidence:typeof item.confidence==='number'?Math.max(0,Math.min(1,item.confidence)):1,createdAt,updatedAt:item.updatedAt||createdAt,lastUsedAt:item.lastUsedAt,retrievalCount:Number.isInteger(item.retrievalCount)&&Number(item.retrievalCount)>=0?Number(item.retrievalCount):0,supersedesId:item.supersedesId};
}

// Both vectors come from the same normalized model output, so the plain dot
// product already equals cosine similarity — no need to re-divide by norms.
export function cosineSimilarity(a:number[],b:number[]):number{
  if(!a.length||a.length!==b.length)return 0;
  let dot=0;for(let i=0;i<a.length;i++)dot+=a[i]*b[i];
  return dot;
}

// A memory with no keyword overlap at all still gets pulled in when it's
// semantically close to the query (e.g. "hometown" retrieving a memory that
// only ever says "lives in St. Louis") — calibrated against real MiniLM
// output: unrelated pairs land ~0.15-0.2, genuinely related short phrases
// ~0.3+, so 0.28 favors precision over dragging in loosely-adjacent memories.
export const SEMANTIC_INCLUSION_THRESHOLD=0.28;

export function rankMemoryRecords(memories:MemoryItem[],query:string,limit=12,queryEmbedding?:number[]):MemoryItem[]{
  const terms=[...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g)??[])];
  return memories.filter((item)=>item.status==='active').map((item)=>{
    const text=`${item.kind} ${item.text}`.toLowerCase();
    const hits=terms.reduce((score,term)=>score+(text.includes(term)?1:0),0);
    const priorityBonus=item.kind==='preference'||item.kind==='instruction'?0.3:0;
    const semantic=queryEmbedding&&item.embedding?Math.max(0,cosineSimilarity(queryEmbedding,item.embedding)):0;
    // Usage builds trust over time: a memory retrieved often stays sharp,
    // one nobody's touched in months quietly fades from ties. lastUsedAt
    // only exists once something has actually been retrieved, so a memory
    // that's never been used gets no penalty and no boost either.
    const recencyBoost=item.lastUsedAt?Math.max(0,0.15-Math.min(180,(Date.now()-Date.parse(item.lastUsedAt))/86_400_000)/180*0.15):0;
    const usageBoost=Math.min(0.2,item.retrievalCount*0.02);
    return{item,hits,semantic,score:hits*2+semantic*3+item.confidence+priorityBonus+recencyBoost+usageBoost};
  }).filter((entry)=>!terms.length&&!queryEmbedding||entry.hits>0||entry.semantic>=SEMANTIC_INCLUSION_THRESHOLD)
    .sort((a,b)=>b.score-a.score||new Date(b.item.updatedAt).getTime()-new Date(a.item.updatedAt).getTime())
    .slice(0,limit).map(({item})=>item);
}
