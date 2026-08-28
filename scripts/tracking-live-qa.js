const { chromium } = require('playwright');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9666';
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap(context=>context.pages())[0];
  await page.waitForSelector('.modded-head',{timeout:20000});
  const samples=[];
  for(let index=0;index<20;index+=1){
    samples.push(await page.evaluate(()=>{
      const avatar=document.querySelector('.modded-avatar');
      const head=document.querySelector('.modded-head');
      const presence=document.querySelector('.presence-row b');
      return{at:Date.now(),status:presence?.textContent?.trim(),transform:head?getComputedStyle(head).transform:'',x:avatar?getComputedStyle(avatar).getPropertyValue('--head-x').trim():'',yaw:avatar?getComputedStyle(avatar).getPropertyValue('--head-yaw').trim():'',source:avatar?.getAttribute('data-tracking-source'),confidence:avatar?.getAttribute('data-tracking-confidence')};
    }));
    await page.waitForTimeout(250);
  }
  const distinct=new Set(samples.map(sample=>`${sample.x}/${sample.yaw}`)).size;
  const locked=samples.filter(sample=>['face','body'].includes(sample.source)&&Number(sample.confidence)>=.6).length;
  const result={lockedSamples:locked,distinctTransforms:distinct,samples:samples.filter((_,index)=>index%4===0),passed:locked>=12&&distinct>=4};
  console.log(JSON.stringify(result,null,2));
  await browser.close();if(!result.passed)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exit(1)});
