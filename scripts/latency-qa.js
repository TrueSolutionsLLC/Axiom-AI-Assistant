const { chromium } = require('playwright');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9444';
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap((context)=>context.pages()).find((candidate)=>/index\.html/.test(candidate.url()))||browser.contexts()[0].pages()[0];
  const prompt=process.env.AXIOM_QA_PROMPT||'Reply with exactly: FAST PATH ONLINE';
  const expected=process.env.AXIOM_QA_EXPECT||'FAST PATH ONLINE';
  const result=await page.evaluate(async({prompt})=>{
    const started=performance.now();
    const reply=await window.axiom.sendMessage({message:prompt,history:[]});
    return{elapsedMs:Math.round(performance.now()-started),text:reply.text,provider:reply.provider,model:reply.model,events:reply.toolEvents.map((event)=>({name:event.name,status:event.status}))};
  },{prompt});
  const passed=result.elapsedMs<15_000&&result.text.toLowerCase().includes(expected.toLowerCase());
  console.log(JSON.stringify({...result,expected,passed},null,2));
  await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1)});
