const { chromium } = require('playwright');

(async()=>{
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT||'9555'}`);
  const app=browser.contexts().flatMap((context)=>context.pages()).find((candidate)=>/index\.html/.test(candidate.url()));
  if(!app)throw new Error('Axiom renderer was not found.');
  const opened=await app.evaluate(()=>window.axiom.sendMessage({message:'Use the browser_open tool to open https://example.com. This is a browser capability verification.',history:[]}));
  const reply=await app.evaluate((history)=>window.axiom.sendMessage({message:'Now use browser_read on the open page and report its exact heading.',history}),[{role:'user',text:'Open https://example.com.'},{role:'assistant',text:opened.text}]);
  await new Promise((resolve)=>setTimeout(resolve,1000));
  const pages=browser.contexts().flatMap((context)=>context.pages());
  const controlled=pages.find((candidate)=>/^https:\/\/example\.com\/?/.test(candidate.url()));
  const passed=Boolean(controlled)&&opened.toolEvents.some((event)=>event.name==='browser_open'&&event.status==='verified')&&reply.toolEvents.some((event)=>event.name==='browser_read'&&event.status==='verified')&&/Example Domain/i.test(reply.text);
  console.log(JSON.stringify({opened,reply,controlledUrl:controlled?.url()||'',passed},null,2));
  if(controlled)await controlled.close();await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1);});
