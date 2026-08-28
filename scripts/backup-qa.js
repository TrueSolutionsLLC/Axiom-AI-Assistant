const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

(async()=>{
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT||'9555'}`);
  const page=browser.contexts().flatMap((context)=>context.pages()).find((candidate)=>/index\.html/.test(candidate.url()));
  if(!page)throw new Error('Axiom renderer was not found.');
  const result=await page.evaluate(()=>window.axiom.createBackup());
  const bytes=fs.statSync(result.path).size,sha256=crypto.createHash('sha256').update(fs.readFileSync(result.path)).digest('hex');
  const passed=bytes===result.bytes&&sha256===result.sha256&&/Axiom Backups/.test(result.path);
  console.log(JSON.stringify({result,verified:{bytes,sha256},passed},null,2));
  await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1);});
