import { describe,expect,it,vi } from 'vitest';
import path from 'node:path';
import type { MemoryItem } from '../shared/contracts';
import { normalizeMemoryRecord,rankMemoryRecords } from './memoryCore';

// Real model, not a stub vector — proves semantic retrieval actually
// surfaces a memory that shares zero keywords with the query, which the old
// pure-substring ranker could never do.
vi.mock('electron',()=>({app:{getAppPath:()=>path.join(__dirname,'..','..')}}));
import { embedText } from './embeddings';

const memory=(overrides:Partial<MemoryItem>):MemoryItem=>({id:'memory-1',text:'Robbie prefers concise status reports',kind:'preference',status:'active',origin:'user-explicit',confidence:1,createdAt:'2026-08-20T12:00:00.000Z',updatedAt:'2026-08-20T12:00:00.000Z',retrievalCount:0,...overrides});

describe('governed memory fabric',()=>{
  it('migrates legacy memory records into explicit provenance defaults',()=>{
    expect(normalizeMemoryRecord({id:'legacy',text:'  Legacy fact  ',createdAt:'2026-08-20T12:00:00.000Z'})).toMatchObject({id:'legacy',text:'Legacy fact',kind:'fact',status:'active',origin:'user-explicit',confidence:1,retrievalCount:0});
  });

  it('rejects unusable records and clamps confidence',()=>{
    expect(normalizeMemoryRecord({id:'bad',text:'   '})).toBeUndefined();
    expect(normalizeMemoryRecord({...memory({}),confidence:5})?.confidence).toBe(1);
  });

  it('retrieves active relevant memories while excluding superseded versions',()=>{
    const ranked=rankMemoryRecords([memory({id:'preference'}),memory({id:'project',kind:'project',text:'Axiom installer project'}),memory({id:'old',status:'superseded',text:'Old Axiom project decision'})],'Axiom project');
    expect(ranked.map((item)=>item.id)).toEqual(['project']);
  });

  it('surfaces a memory that shares zero keywords with the query, using a real embedding',async()=>{
    const hometown=memory({id:'hometown',kind:'fact',text:'Robbie lives in St. Louis and loves synthwave music.',embedding:await embedText('Robbie lives in St. Louis and loves synthwave music.')});
    const unrelated=memory({id:'unrelated',kind:'fact',text:'The garage door opener uses a rolling code.',embedding:await embedText('The garage door opener uses a rolling code.')});
    const queryEmbedding=await embedText('Where is my hometown?');
    const ranked=rankMemoryRecords([hometown,unrelated],'Where is my hometown?',12,queryEmbedding);
    expect(ranked.map((item)=>item.id)).toEqual(['hometown']);
  },15_000);

  it('breaks a keyword tie in favor of the memory retrieved more often and more recently',()=>{
    const now=new Date().toISOString(),stale=new Date(Date.now()-200*86_400_000).toISOString();
    const wellUsed=memory({id:'well-used',text:'Axiom deploy checklist',retrievalCount:8,lastUsedAt:now});
    const neverUsed=memory({id:'never-used',text:'Axiom deploy checklist'});
    const staleUsed=memory({id:'stale-used',text:'Axiom deploy checklist',retrievalCount:1,lastUsedAt:stale});
    const ranked=rankMemoryRecords([neverUsed,staleUsed,wellUsed],'Axiom deploy checklist');
    expect(ranked[0].id).toBe('well-used');
  });
});
