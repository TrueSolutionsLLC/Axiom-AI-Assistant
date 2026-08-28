const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const axiomDataRoot = path.join(process.env.APPDATA || '', 'axiom-assistant');
app.setPath('userData', axiomDataRoot);

app.whenReady().then(async () => {
  try {
    const dataPath = path.join(axiomDataRoot, 'axiom-data.json');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (!data.encryptedOpenAIKey || !safeStorage.isEncryptionAvailable()) throw new Error('The saved OpenAI credential is unavailable.');
    const key = safeStorage.decryptString(Buffer.from(data.encryptedOpenAIKey, 'base64'));
    const { runAssistant } = require('../dist-main/main/openai.js');
    const reply = await runAssistant(key, 'openai', data.providerModels?.openai || data.model || 'gpt-5.6-luna', {
      message: 'Use live web search and tell me the weather forecast next week for ZIP code 63049 (Arnold, Missouri). Include source links.',
      history: [],
    });
    if (!reply.toolEvents.some((event) => event.name === 'web_search' && event.status === 'verified')) throw new Error('No verified web-search event was returned.');
    if (/can(?:not|'t)\s+(?:access|search)|no\s+(?:live\s+)?internet/i.test(reply.text)) throw new Error(`Axiom returned a web-access refusal: ${reply.text.slice(0, 240)}`);
    const actionReply = await runAssistant(key, 'openai', data.providerModels?.openai || data.model || 'gpt-5.6-luna', {
      message: 'What time is it right now?',
      history: [],
    });
    if (!actionReply.toolEvents.some((event) => event.name === 'get_local_time' && event.status === 'verified')) throw new Error('The general capability request was answered without executing get_local_time.');
    const now=new Date().toISOString(),memory={id:'smoke-memory',text:"The user's name is Robbie.",kind:'person',status:'active',origin:'user-explicit',confidence:1,createdAt:now,updatedAt:now,retrievalCount:0};
    const identityStore={
      devicePresence:()=>({id:'smoke-device',name:'Axiom smoke test',platform:'windows',hostname:'localhost',architecture:'x64',appVersion:'test',firstSeenAt:now,lastSeenAt:now,lastActiveAt:now}),
      syncStatus:()=>({enabled:false,configured:false,syncing:false,state:'off',folder:'',device:{id:'smoke-device',name:'Axiom smoke test',platform:'windows',hostname:'localhost',architecture:'x64',appVersion:'test',firstSeenAt:now,lastSeenAt:now,lastActiveAt:now},peers:[],voiceOwnedHere:true}),
      knownPeople:()=>[],speakerProfiles:()=>[],memories:()=>[memory],searchMemories:()=>[memory],permissionEnabled:()=>true,observeDesktopTool:()=>{},
    };
    const identityReply=await runAssistant(key,'openai',data.providerModels?.openai||data.model||'gpt-5.6-luna',{message:"Do you know who you're talking to?",history:[]},identityStore);
    if(!identityReply.toolEvents.some((event)=>event.name==='recall_memory'&&event.status==='verified'))throw new Error('The identity question did not execute durable memory recall.');
    if(!/\bRobbie\b/i.test(identityReply.text)||/don'?t know (?:your name|who)/i.test(identityReply.text))throw new Error(`Axiom failed durable identity recall: ${identityReply.text.slice(0,240)}`);
    process.stdout.write(`LIVE_WEB_SMOKE_OK\nLIVE_ACTION_SMOKE_OK\nLIVE_IDENTITY_SMOKE_OK\n${identityReply.text}\n`);
    app.quit();
  } catch (error) {
    process.stderr.write(`LIVE_WEB_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  }
});
