const { chromium } = require('playwright');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9444';
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap(context=>context.pages())[0];
  const text='Axiom is online and ready. I can help you move quickly through today’s work without wasting time or dragging out the conversation.';
  const result=await page.evaluate(async(sample)=>{
    const speech=await window.axiom.synthesizeSpeech(sample);
    const url=URL.createObjectURL(new Blob([speech.audio],{type:speech.mimeType}));
    try{
      const audio=new Audio(url);
      await new Promise((resolve,reject)=>{audio.onloadedmetadata=resolve;audio.onerror=()=>reject(new Error('Generated audio metadata could not be read.'));});
      return{duration:audio.duration,mimeType:speech.mimeType};
    }finally{URL.revokeObjectURL(url);}
  },text);
  const words=text.trim().split(/\s+/).length;
  const wordsPerMinute=Math.round(words/result.duration*60);
  const passed=Number.isFinite(result.duration)&&result.duration>0&&wordsPerMinute>=145;
  console.log(JSON.stringify({...result,words,wordsPerMinute,passed},null,2));
  await browser.close();
  if(!passed)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
