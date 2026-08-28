const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9444';
  const target=path.resolve(__dirname,'../tmp/tracking-qa/synthetic-face.png');
  const dataUrl=`data:image/png;base64,${fs.readFileSync(target).toString('base64')}`;
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap(context=>context.pages())[0];
  await page.addInitScript((source)=>{
    const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async(constraints)=>{
      if(!constraints||!constraints.video)return native(constraints);
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
      const context=canvas.getContext('2d');const image=new Image();image.src=source;await image.decode();
      const started=performance.now();
      const paint=()=>{const elapsed=(performance.now()-started)/1000;context.fillStyle='#777';context.fillRect(0,0,640,480);const size=360,x=140+Math.sin(elapsed*.85)*105,y=58+Math.sin(elapsed*.47)*12;context.drawImage(image,x,y,size,size);requestAnimationFrame(paint);};paint();
      return canvas.captureStream(30);
    }});
  },dataUrl);
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.modded-avatar',{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('.modded-avatar')?.getAttribute('data-tracking-source')==='face',{timeout:30000});
  const samples=[];for(let index=0;index<28;index+=1){samples.push(await page.evaluate(()=>{const avatar=document.querySelector('.modded-avatar'),style=getComputedStyle(avatar);return{source:avatar?.getAttribute('data-tracking-source'),confidence:Number(avatar?.getAttribute('data-tracking-confidence')),fps:Number(avatar?.getAttribute('data-tracking-fps')),motion:Number(avatar?.getAttribute('data-tracking-motion')),x:parseFloat(style.getPropertyValue('--head-x')),yaw:parseFloat(style.getPropertyValue('--head-yaw')),gazeX:parseFloat(style.getPropertyValue('--gaze-x'))};}));await page.waitForTimeout(180);}
  const xs=samples.map(sample=>sample.x).filter(Number.isFinite),yaws=samples.map(sample=>sample.yaw).filter(Number.isFinite),gaze=samples.map(sample=>sample.gazeX).filter(Number.isFinite);const range=(values)=>Math.max(...values)-Math.min(...values);
  const confidence=samples.map(sample=>sample.confidence).sort((a,b)=>a-b),fps=samples.map(sample=>sample.fps).sort((a,b)=>a-b);
  const result={faceLocks:samples.filter(sample=>sample.source==='face').length,medianConfidence:confidence[Math.floor(samples.length/2)],medianFps:fps[Math.floor(samples.length/2)],headTravelPx:Math.round(range(xs)),yawTravelDeg:Number(range(yaws).toFixed(1)),eyeTravelPx:Number(range(gaze).toFixed(1)),peakMotion:Number(Math.max(...samples.map(sample=>sample.motion)).toFixed(2))};
  result.passed=result.faceLocks===samples.length&&result.medianConfidence>.9&&result.medianFps>=15&&result.headTravelPx>=35&&result.yawTravelDeg>=5&&result.eyeTravelPx>=3;
  console.log(JSON.stringify(result,null,2));await browser.close();if(!result.passed)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exit(1)});
