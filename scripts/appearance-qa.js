const {chromium}=require('playwright');

(async()=>{
  const port=process.env.AXIOM_QA_PORT||'9666';
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page=browser.contexts().flatMap((context)=>context.pages()).find((candidate)=>/index\.html/.test(candidate.url()))||browser.contexts()[0].pages()[0];
  const run=async(command,expectedClass,expectedAccent)=>{
    const input=page.locator('.composer input');
    await input.fill(command);await input.press('Enter');
    await page.waitForFunction(([theme,accent])=>document.querySelector('.shell')?.classList.contains(theme)&&getComputedStyle(document.querySelector('.shell')).getPropertyValue('--theme-solid').trim().toLowerCase()===accent,[expectedClass,expectedAccent],{timeout:10000});
    return page.evaluate(()=>({className:document.querySelector('.shell')?.className,accent:getComputedStyle(document.querySelector('.shell')).getPropertyValue('--theme-solid').trim(),reply:document.querySelector('.identity-line p')?.textContent?.trim()}));
  };
  const changed=await run('Make your whole interface pink, cinematic, and happy','theme-pink','#ff4fc8');
  const restored=await run('Change your whole interface to teal, adaptive, balanced, and neutral','theme-teal','#20ffd3');
  const passed=/theme-pink/.test(changed.className||'')&&/motion-cinematic/.test(changed.className||'')&&/theme-teal/.test(restored.className||'')&&/motion-adaptive/.test(restored.className||'');
  console.log(JSON.stringify({changed,restored,passed},null,2));await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1);});
