const { chromium } = require('playwright');
const path = require('path');

(async()=>{
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT||'9444'}`);
  const page=browser.contexts().flatMap((context)=>context.pages()).find((candidate)=>/index\.html/.test(candidate.url()))||browser.contexts()[0].pages()[0];
  const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.shell',{timeout:30000});
  await page.getByRole('button',{name:/SCREEN/}).click();await page.waitForSelector('.desktop-world');
  const first=await page.evaluate(()=>window.axiom.refreshDesktopGraph());
  const firstWindowIds=first.graph.entities.filter((item)=>item.kind==='window'&&item.status==='live').map((item)=>item.id);
  const second=await page.evaluate(()=>window.axiom.refreshDesktopGraph());
  const secondWindowIds=second.graph.entities.filter((item)=>item.kind==='window'&&item.status==='live').map((item)=>item.id);
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.shell',{timeout:30000});await page.getByRole('button',{name:/SCREEN/}).click();await page.waitForSelector('.desktop-world');
  await page.locator('.desktop-world').scrollIntoViewIfNeeded();
  await page.locator('.desktop-world').screenshot({path:path.resolve(__dirname,'../qa/axiom-desktop-world-live.png')});
  const rendered={apps:await page.locator('.app-node').count(),windows:await page.locator('.window-node').count(),observations:await page.locator('.observation-stream article').count(),metrics:await page.locator('.world-metrics article').allInnerTexts()};
  const stable=firstWindowIds.length>0&&firstWindowIds.every((id)=>secondWindowIds.includes(id));
  const passed=first.event.status==='verified'&&second.event.status==='verified'&&first.graph.metrics.applications>0&&first.graph.metrics.liveWindows>0&&stable&&rendered.apps>0&&rendered.windows>0&&errors.length===0;
  console.log(JSON.stringify({first:first.graph.metrics,second:second.graph.metrics,stable,rendered,errors,passed},null,2));
  await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1)});
