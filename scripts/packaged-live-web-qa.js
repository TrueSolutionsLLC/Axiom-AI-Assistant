const {chromium}=require('playwright');

(async()=>{
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT||'9445'}`),page=browser.contexts().flatMap((context)=>context.pages())[0];
  const result=await page.evaluate(async()=>{
    const started=performance.now(),reply=await window.axiom.sendMessage({message:'Search the live web for the current local time in Chicago, Illinois. Answer in one sentence and include the source link.',history:[]});
    return{elapsedMs:Math.round(performance.now()-started),text:reply.text,events:reply.toolEvents.map((event)=>({name:event.name,status:event.status}))};
  });
  const searched=result.events.some((event)=>event.name==='web_search'&&event.status==='verified'),refused=/\b(?:can(?:not|'t)|unable to)\s+(?:access|search|browse)|no\s+(?:live\s+)?internet\b/i.test(result.text),linked=/https?:\/\//i.test(result.text),passed=searched&&!refused&&linked;
  console.log(JSON.stringify({...result,searched,refused,linked,passed},null,2));await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1);});
