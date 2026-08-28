const { chromium }=require('playwright');
const fs=require('fs'),path=require('path');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9445';
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap((context)=>context.pages()).find((candidate)=>candidate.url().includes('index.html'))||browser.contexts()[0].pages()[0];
  const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
  await page.waitForSelector('.shell',{timeout:30000});
  if(await page.locator('.settings-card').isVisible())await page.locator('.settings-card>header>button').click();
  if(!await page.locator('.live-camera-window').count()){
    if(!await page.locator('.composer input').count())await page.getByRole('button',{name:/CHAT/}).click();
    await page.locator('.composer input').fill('Pull up the camera feed');
    await page.locator('.composer input').press('Enter');
  }
  await page.waitForSelector('.live-camera-window',{timeout:12000});
  await page.waitForFunction(()=>document.querySelector('.live-camera-window video')?.readyState>=2,null,{timeout:12000});
  const result=await page.evaluate(()=>({version:document.querySelector('.rail-footer b')?.textContent?.trim(),feedVisible:Boolean(document.querySelector('.live-camera-window')),videoReady:document.querySelector('.live-camera-window video')?.readyState>=2,status:document.querySelector('.live-camera-window header span')?.textContent?.trim(),errors:document.querySelector('.error-strip')?.textContent?.trim()}));
  const out=path.resolve(__dirname,'../qa');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'axiom-2.4.5-packaged-live-camera.png')});
  console.log(JSON.stringify({...result,pageErrors:errors,passed:result.feedVisible&&result.videoReady&&errors.length===0},null,2));
  await browser.close();
  if(!result.feedVisible||!result.videoReady||errors.length)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1);});
