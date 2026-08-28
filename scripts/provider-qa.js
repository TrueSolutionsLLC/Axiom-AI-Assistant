const { chromium } = require('playwright');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9444';
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap(context=>context.pages())[0];
  const result=await page.evaluate(async()=>{
    const app=await window.axiom.getAppInfo();
    const settings=await window.axiom.getSettings();
    const connection=await window.axiom.testProvider(settings.provider);
    return{version:app.version,provider:settings.provider,model:settings.model,hasSelectedKey:settings.hasSelectedAIKey,connection};
  });
  result.passed=result.hasSelectedKey&&result.connection.ok;
  console.log(JSON.stringify(result,null,2));
  await browser.close();
  if(!result.passed)process.exitCode=1;
})().catch(error=>{console.error(error.stack||error);process.exit(1)});
