import { describe, expect, it } from 'vitest';
import { anthropicToolsForTest, finalizeReplyTone, geminiToolsForTest, identityAndMemoryContextForTest, liveResearchToolNameForTest, normalizeActionReply, recentTranscriptForTest, responseTextForTest, runAssistant, soleToolNameForTest, transcriptTextForTest, userContentForTest } from './openai';
import type { ApprovalRequest } from '../shared/contracts';
import type { AppStore } from './store';

describe('Responses parser', () => {
  it('uses output_text when supplied', () => {
    expect(responseTextForTest({ output_text: '  Ready.  ' })).toBe('Ready.');
  });

  it('extracts message content from response items', () => {
    expect(responseTextForTest({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Verified result' }] }] })).toBe('Verified result');
  });

  it('appends unique visible links from web-search citations and sources', () => {
    expect(responseTextForTest({ output: [
      { type:'message', content:[{ type:'output_text', text:'The current answer.', annotations:[{type:'url_citation',url:'https://example.com/report',title:'Primary report'}] }] },
      { type:'web_search_call', action:{sources:[{url:'https://example.com/report',title:'Duplicate'},{url:'https://example.org/data',title:'Supporting data'}]} },
    ] })).toBe('The current answer.\n\nSources:\n- Primary report: https://example.com/report\n- Supporting data: https://example.org/data');
  });

  it('rejects non-web citation protocols', () => {
    expect(responseTextForTest({ output: [{ type:'message', content:[{ type:'output_text', text:'Safe.', annotations:[{type:'url_citation',url:'file:///private.txt',title:'Unsafe'}] }] }] })).toBe('Safe.');
  });
});

describe('AI provider routing', () => {
  const request = { message: 'Hello', history: [] };
  it('requires the selected Anthropic credential', async () => {
    await expect(runAssistant('', 'anthropic', 'claude-sonnet-5', request)).rejects.toThrow(/Anthropic API key/i);
  });
  it('requires the selected Gemini credential', async () => {
    await expect(runAssistant('', 'gemini', 'gemini-3.6-flash', request)).rejects.toThrow(/Gemini API key/i);
  });
});

describe('unverified visitor lockout',()=>{
  const store={publicSettings:()=>({}),devicePresence:()=>({platform:'windows',name:'d',architecture:'x64',hostname:'h'}),syncStatus:()=>({peers:[]}),knownPeople:()=>[],speakerProfiles:()=>[],memories:()=>[],searchMemories:()=>[],permissionEnabled:()=>true} as unknown as AppStore;
  const visitorAsks={message:'Search YouTube for realistic AI avatars',history:[],untrustedPresence:true};
  it('never runs a deterministic action route for an unverified visitor',async()=>{
    // Reaching the provider (and failing on the missing credential) proves no
    // tool was executed on the fast path.
    await expect(runAssistant('','anthropic','claude-sonnet-5',visitorAsks,store)).rejects.toThrow(/Anthropic API key/i);
  });
  it('still runs that route for a verified user',async()=>{
    const reply=await runAssistant('','anthropic','claude-sonnet-5',{...visitorAsks,untrustedPresence:false},store);
    expect(reply.toolEvents.map((event)=>event.name)).toEqual(['browser_open']);
  });
});

describe('the approval phrase executes the exact pending action directly',()=>{
  // Live failure: told to say "APPROVE AX-B4DD03" for a blocked window-close,
  // a user did exactly that and nothing happened — that phrase shares no
  // keywords with the original "close the app" request, so the model was
  // never even offered the tool it was meant to authorize. This bypasses
  // tool selection entirely: look the code up and run its stored action.
  const pendingApproval={id:'appr-1',code:'AX-000000',toolName:'get_local_time',status:'pending',risk:'destructive',preview:'Read local time.',recovery:'None needed.',argsDigest:'x',createdAt:'2026-08-24T00:00:00.000Z',expiresAt:'2026-08-24T00:15:00.000Z'} as ApprovalRequest;
  const store={permissionEnabled:()=>true,approvalPayload:(code:string)=>code==='AX-000000'?{...pendingApproval,args:{}}:undefined} as unknown as AppStore;

  it('executes the stored action when the exact approval phrase is said, without ever reaching the AI provider',async()=>{
    const reply=await runAssistant('','anthropic','claude-sonnet-5',{message:'APPROVE AX-000000',history:[]},store);
    expect(reply.toolEvents.map((event)=>event.name)).toEqual(['get_local_time']);
    expect(reply.text).toContain('Approved.');
  });

  it('tells the user plainly when the code has no matching pending approval, instead of silently doing nothing',async()=>{
    const reply=await runAssistant('','anthropic','claude-sonnet-5',{message:'APPROVE AX-999999',history:[]},store);
    expect(reply.toolEvents).toEqual([]);
    expect(reply.text).toMatch(/don't have a pending approval/i);
  });

  it('never lets an unverified visitor consume someone else\'s pending approval, even with the exact phrase',async()=>{
    await expect(runAssistant('','anthropic','claude-sonnet-5',{message:'APPROVE AX-000000',history:[],untrustedPresence:true},store)).rejects.toThrow(/Anthropic API key/i);
  });
});

describe('honest action replies',()=>{
  const at='2026-08-22T12:00:00.000Z';
  it('replaces false success language when execution failed',()=>expect(normalizeActionReply('Done!',[{name:'write_text_file',status:'failed',summary:'Access denied',at}],true)).toContain('BLOCKED: Access denied'));
  it('refuses to claim completion when no action receipt exists',()=>expect(normalizeActionReply('I completed that.',[],true)).toContain('no capability produced verified evidence'));
  it('preserves a grounded response after verification',()=>expect(normalizeActionReply('The file exists.',[{name:'path_exists',status:'verified',summary:'Verified path',at}],true)).toBe('The file exists.'));
});

describe('reply tone — disagreement and uncertainty from real signals, never self-reported', () => {
  const at='2026-08-24T12:00:00.000Z';
  it('extracts a CONCERN marker and strips it from the displayed text', () => {
    const result = finalizeReplyTone('CONCERN: This would delete a file you still need. Proceeding since you confirmed.', []);
    expect(result.tone).toBe('concern');
    expect(result.text).toBe('This would delete a file you still need. Proceeding since you confirmed.');
    expect(result.text).not.toContain('CONCERN');
  });

  it('flags uncertain only when hedging language lands with zero verified evidence behind it', () => {
    const hedged = finalizeReplyTone("I'm not sure that's accurate.", []);
    expect(hedged.tone).toBe('uncertain');
    // The same hedge with a verified receipt behind it is not flagged —
    // hedging language alone is not the signal, unverified hedging is.
    const backed = finalizeReplyTone("I'm not sure, but I checked and confirmed it.", [{name:'read_text_file',status:'verified',summary:'Verified',at}]);
    expect(backed.tone).toBeUndefined();
  });

  it('leaves a plain, confident, or verified reply untouched', () => {
    expect(finalizeReplyTone('The file exists.', [{name:'path_exists',status:'verified',summary:'Verified',at}]).tone).toBeUndefined();
    expect(finalizeReplyTone('Done.', []).tone).toBeUndefined();
  });
});

describe('live-research tool forcing — exact name, not a generic hint', () => {
  // A live production failure showed the model sometimes ignores a generic
  // "you must call a tool" instruction (tool_choice 'required'/'any') and
  // just answers in plain text — confirmed via the app's own runtime task
  // ledger showing zero tool execution despite 'required' being set. Every
  // provider path now forces the exact live-research tool by name instead,
  // which is a harder API-level constraint. This only works if providerTools
  // always offers exactly one candidate to force.
  it('finds the one live-research tool among a mixed tool list', () => {
    const tools = [
      { type: 'function', name: 'get_local_time', description: '', parameters: {} },
      { type: 'function', name: 'get_news_headlines', description: '', parameters: {} },
      { type: 'function', name: 'write_text_file', description: '', parameters: {} },
    ];
    expect(liveResearchToolNameForTest(tools)).toBe('get_news_headlines');
  });

  it('finds web_search when that is the one offered instead', () => {
    const tools = [{ type: 'function', name: 'web_search', description: '', parameters: {} }];
    expect(liveResearchToolNameForTest(tools)).toBe('web_search');
  });

  it('returns undefined when no live-research tool is present', () => {
    const tools = [{ type: 'function', name: 'get_local_time', description: '', parameters: {} }];
    expect(liveResearchToolNameForTest(tools)).toBeUndefined();
  });

  // Generalized after a second live failure: "create a new folder" offered 5
  // plausible file tools (a separate keyword-overlap bug, fixed in
  // tools.ts) and hit the identical "model ignores generic required"
  // symptom. Forcing by name whenever exactly one tool is on the table
  // fixes it for any mandatory request, not just search.
  it('forces the sole tool by name when exactly one tool is offered, regardless of category', () => {
    expect(soleToolNameForTest([{ type: 'function', name: 'create_directory', description: '', parameters: {} }])).toBe('create_directory');
  });

  it('does not force when zero or multiple tools are offered — ambiguous, cannot pick one', () => {
    expect(soleToolNameForTest([])).toBeUndefined();
    expect(soleToolNameForTest([
      { type: 'function', name: 'create_directory', description: '', parameters: {} },
      { type: 'function', name: 'write_text_file', description: '', parameters: {} },
    ])).toBeUndefined();
  });
});

describe('web search is a real function tool, not a provider-hosted black box', () => {
  // Replaced entirely after a live production failure: a provider's hosted
  // web_search tool could report success while returning nothing usable,
  // and there was no way to see inside it to find out why. web_search is
  // now a normal Axiom function tool (src/main/tools.ts, backed by
  // src/main/webSearch.ts's real HTTP call), so it flows through the exact
  // same tool-call mapping and verification as every other tool — no
  // provider-specific "was the hosted search really used" tracking needed.
  const tools = [{ type: 'function', name: 'web_search', description: 'Search the live web.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }, { type: 'function', name: 'get_local_time', description: 'Read time', parameters: { type: 'object' } }];

  it('passes web_search through to Anthropic as a plain function tool', () => {
    expect(anthropicToolsForTest(tools)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'web_search' }),
      expect.objectContaining({ name: 'get_local_time' }),
    ]));
    expect(anthropicToolsForTest(tools).some((tool: Record<string, unknown>) => tool.type === 'web_search_20250305')).toBe(false);
  });

  it('passes web_search through to Gemini as a plain function declaration', () => {
    expect(geminiToolsForTest(tools)).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionDeclarations: expect.arrayContaining([expect.objectContaining({ name: 'web_search' }), expect.objectContaining({ name: 'get_local_time' })]) }),
    ]));
    expect(geminiToolsForTest(tools).some((tool: Record<string, unknown>) => 'googleSearch' in tool)).toBe(false);
  });
});

describe('durable identity context',()=>{
  const personMemory={id:'memory-1',text:"The user's name is Robbie.",kind:'person' as const,status:'active' as const,origin:'user-explicit' as const,confidence:1,createdAt:'2026-08-21T10:00:00.000Z',updatedAt:'2026-08-21T10:00:00.000Z',retrievalCount:0};
  const store={knownPeople:()=>[{id:'person-1',name:'Robbie',descriptor:Array(128).fill(0),primary:true,createdAt:'2026-08-21T10:00:00.000Z'}],speakerProfiles:()=>[],memories:()=>[personMemory],searchMemories:()=>[personMemory],relevantSelfCorrections:()=>[]} as unknown as AppStore;

  it('distinguishes remembered identity from current face verification',async()=>{
    const remembered=await identityAndMemoryContextForTest(store,{message:"Do you know who you're talking to?",history:[]});
    expect(remembered).toContain("The user's name is Robbie");
    expect(remembered).toContain('No current-turn biometric verification');
    const verified=await identityAndMemoryContextForTest(store,{message:'Who am I?',history:[],identity:{face:{name:'Robbie',confidence:.94,observedAt:new Date().toISOString()}}});
    expect(verified).toContain('FACE VERIFIED: Robbie (94% confidence)');
  });

  it('surfaces a relevant self-correction into the prompt context',async()=>{
    const lesson={id:'sc-1',pattern:'web search keyword gap',mistake:'Tool availability was gated too narrowly.',fix:'Broadened the trigger phrasing.',createdAt:'2026-08-24T00:00:00.000Z'};
    const withLesson={...store,relevantSelfCorrections:()=>[lesson]} as unknown as AppStore;
    const context=await identityAndMemoryContextForTest(withLesson,{message:'can you verify this',history:[]});
    expect(context).toContain('has made this specific kind of mistake before');
    expect(context).toContain('Broadened the trigger phrasing.');
  });

  it('removes the legacy empty-camera label from conversation history',()=>expect(transcriptTextForTest("How do you know it's me?\n\nCamera context: Describe only what is actually visible; if an action is uncertain, say so.")).toBe("How do you know it's me?"));

  it('bounds short-term conversation context without weakening durable memory',()=>{
    const history=Array.from({length:12},(_,index)=>({role:(index%2?'assistant':'user') as 'assistant'|'user',text:`message-${index} ${'x'.repeat(1800)}`}));
    const transcript=recentTranscriptForTest({message:'continue',history});
    expect(transcript).not.toContain('message-3');
    expect(transcript).toContain('message-4');
    expect(transcript).toContain('message-11');
    expect(transcript.length).toBeLessThanOrEqual(8*1208);
  });
});

describe('screen vision input', () => {
  it('attaches a bounded image to the user message', () => {
    expect(userContentForTest('Inspect this.', 'data:image/png;base64,AAAA')).toEqual([
      { type: 'input_text', text: 'Inspect this.' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'low' },
    ]);
  });

  it('rejects non-image attachment data', () => {
    expect(() => userContentForTest('Inspect this.', 'data:text/html;base64,AAAA')).toThrow(/invalid or too large/i);
  });
});
