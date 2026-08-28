const { chromium } = require('playwright');
const path = require('path');

(async()=>{
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT||'9444'}`);
  const page=browser.contexts().flatMap((context)=>context.pages()).find((candidate)=>/index\.html/.test(candidate.url()))||browser.contexts()[0].pages()[0];
  const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.shell',{timeout:30000});
  const greeting='Hello, Robbie. What would you like me to help you with?';
  await page.waitForFunction((text)=>document.querySelector('.identity-line p')?.textContent?.trim()===text,greeting,{timeout:10000});
  await page.waitForSelector('.voice-button.recording',{timeout:30000});
  const state=await page.evaluate(()=>({legacyLayer:!!document.querySelector('.reference-master'),greeting:document.querySelector('.identity-line p')?.textContent?.trim(),recording:document.querySelector('.voice-button')?.classList.contains('recording'),error:document.querySelector('.error-strip')?.textContent?.trim()||'',overflowX:document.documentElement.scrollWidth>innerWidth,overflowY:document.documentElement.scrollHeight>innerHeight}));
  await page.screenshot({path:path.resolve(__dirname,'../qa/axiom-clean-startup.png')});
  const persistence=await page.evaluate(async()=>{const current=await window.axiom.getSettings();const disabled=await window.axiom.saveSettings({model:current.model,startMicrophoneOn:false});const restored=await window.axiom.saveSettings({model:current.model,startMicrophoneOn:true});return{disabled:disabled.startMicrophoneOn,restored:restored.startMicrophoneOn};});
  const settings=page.getByRole('button',{name:'Open settings'});await settings.click();await page.waitForSelector('.settings-card');const preference=await page.locator('.microphone-startup input').isChecked();await page.locator('.settings-card>header>button').click();
  const passed=!state.legacyLayer&&state.recording&&!state.error&&preference&&!persistence.disabled&&persistence.restored&&!state.overflowX&&!state.overflowY&&errors.length===0;
  console.log(JSON.stringify({state,preference,persistence,errors,passed},null,2));
  await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1)});
