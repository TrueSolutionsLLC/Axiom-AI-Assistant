const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9666';
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap((context)=>context.pages()).find((candidate)=>/index\.html/.test(candidate.url()))||browser.contexts()[0].pages()[0];
  if(!page)throw new Error('Axiom renderer is unavailable.');
  const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
  await page.evaluate(()=>sessionStorage.setItem('axiom-mouth-qa','1'));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('.modded-avatar',{timeout:30000});
  if(await page.locator('.settings-card').isVisible())await page.locator('.settings-card>header>button').click();
  await page.waitForFunction(()=>{window.dispatchEvent(new CustomEvent('axiom:mouth-qa-frame',{detail:{mode:'speaking',energy:.76,mouth:{viseme:'wide',open:.6,wide:.8,round:.08},durationMs:500}}));return Number(getComputedStyle(document.querySelector('.modded-avatar')).getPropertyValue('--jaw-open'))>.2;},null,{timeout:5000,polling:50});
  const samples=[];
  // Sustain non-closed articulation for twelve seconds. Every third frame
  // injects the exact LISTENING collision caused by speaker echo/VAD.
  for(let index=0;index<120;index++){
    const open=.31+Math.abs(Math.sin(index*.47))*.57;
    const visemes=['wide','spread','round','narrow'];
    const mouth={viseme:visemes[index%visemes.length],open,wide:.3+Math.abs(Math.sin(index*.31))*.58,round:index%4===2?.86:.08};
    const mode=index%3===0?'listening':'speaking';
    await page.evaluate((detail)=>window.dispatchEvent(new CustomEvent('axiom:mouth-qa-frame',{detail:{...detail,energy:.76,durationMs:500}})),{mode,mouth});
    await page.waitForTimeout(100);
    samples.push(await page.locator('.modded-avatar').evaluate((avatar)=>{const style=getComputedStyle(avatar);return{open:Number(style.getPropertyValue('--jaw-open')),jawDrop:Number.parseFloat(style.getPropertyValue('--jaw-drop'))||0};}));
  }
  await page.evaluate(()=>sessionStorage.removeItem('axiom-mouth-qa'));
  const minimumOpen=Math.min(...samples.map((sample)=>sample.open));
  const minimumDrop=Math.min(...samples.map((sample)=>sample.jawDrop));
  const frozenFrames=samples.filter((sample)=>sample.open<.2||sample.jawDrop<1.2).length;
  const report={createdAt:new Date().toISOString(),durationSeconds:12,samples:samples.length,minimumOpen,minimumDrop,frozenFrames,errors,passed:frozenFrames===0&&errors.length===0};
  const target=path.resolve(__dirname,'../qa/speaking/axiom-mouth-continuity.json');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,report:target},null,2));
  await browser.close();if(!report.passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1);});
