const { chromium } = require('playwright');

(async()=>{
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT||'9444'}`);
  const app=browser.contexts().flatMap((context)=>context.pages()).find((page)=>/index\.html/.test(page.url()));
  if(!app)throw new Error('Axiom application page was not found.');
  await app.waitForSelector('.composer input',{timeout:30000});
  if(await app.locator('.settings-card').isVisible())await app.locator('.settings-card>header>button').click();
  const command='Search YouTube for realistic AI avatar motion';
  await app.locator('.composer input').fill(command);
  await app.locator('.composer').press('Enter');
  await app.waitForFunction(()=>document.body.innerText.includes('Opened YouTube search results for “realistic AI avatar motion”.'),undefined,{timeout:30000});
  let youtube;
  for(let attempt=0;attempt<30&&!youtube;attempt+=1){
    youtube=browser.contexts().flatMap((context)=>context.pages()).find((page)=>{try{const url=new URL(page.url());return url.hostname.endsWith('youtube.com')&&url.pathname==='/results'&&url.searchParams.get('search_query')==='realistic AI avatar motion';}catch{return false;}});
    if(!youtube)await new Promise((resolve)=>setTimeout(resolve,250));
  }
  const state=await app.evaluate(()=>({
    response:document.querySelector('.identity-line p')?.textContent?.trim()||'',
    error:document.querySelector('.error-strip')?.textContent?.trim()||'',
  }));
  const passed=Boolean(youtube)&&!state.error&&state.response.includes('Opened YouTube search results');
  console.log(JSON.stringify({command,browserUrl:youtube?.url()||'',state,passed},null,2));
  await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1)});
