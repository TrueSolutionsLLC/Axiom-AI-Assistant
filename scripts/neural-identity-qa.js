const { chromium } = require('playwright');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9444';
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap((context)=>context.pages()).find((item)=>item.url().startsWith('axiom://app/'));
  if(!page)throw new Error('Axiom renderer not found.');
  const errors=[];
  page.on('pageerror',(error)=>{if(/wavlm|speaker worker|onnxruntime/i.test(error.message))errors.push(error.message);});
  page.on('console',(message)=>{const text=message.text();if(/wavlm speaker|speaker worker|onnxruntime/i.test(text))errors.push(`${message.type()}: ${text}`);});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.voice-identity-pill').waitFor({state:'visible',timeout:20_000});
  await page.waitForFunction(()=>{const text=document.querySelector('.voice-identity-pill')?.textContent||'';return text.includes('WAVLM READY')||text.includes('WAVLM FAULT');},null,{timeout:90_000});
  const status=await page.locator('.voice-identity-pill').textContent();
  if(!status?.includes('WAVLM READY'))throw new Error(`Current state: ${status}. Console: ${errors.join(' | ')}`);
  const model=await page.evaluate(async()=>{const response=await fetch('/models/wavlm-base-plus-sv/onnx/model_quantized.onnx',{headers:{range:'bytes=0-31'}});return{ok:response.ok,status:response.status,bytes:(await response.arrayBuffer()).byteLength};});
  if(!model.ok||model.bytes<32)throw new Error(`Bundled WavLM model failed: ${JSON.stringify(model)}`);
  if(errors.length)throw new Error(`Renderer errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({status,model,renderer:'healthy'},null,2));
  await browser.close();
})().catch((error)=>{console.error(error);process.exit(1);});
