const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const packageVersion = require('../package.json').version;

(async()=>{
  const port = process.env.AXIOM_QA_PORT || '9444';
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap(c=>c.pages()).find(p=>/index\.html/.test(p.url())) || browser.contexts()[0].pages()[0];
  const errors=[],failedRequests=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('requestfailed',request=>failedRequests.push(`${request.url()} · ${request.failure()?.errorText||'failed'}`));page.on('console',m=>{if(m.type()==='error'&&!m.text().startsWith('INFO: Created TensorFlow Lite'))errors.push(m.text())});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForTimeout(1500);
  const boot=await page.evaluate(()=>({html:document.body.innerHTML.slice(0,500),text:document.body.innerText.slice(0,500),hasApi:!!window.axiom}));
  if(!boot.html.includes('class="shell'))console.log(JSON.stringify({boot,errors},null,2));
  await page.waitForSelector('.shell',{timeout:30000});
  const appInfo=await page.evaluate(()=>window.axiom.getAppInfo());
  const out=path.resolve(__dirname,'../qa'); fs.mkdirSync(out,{recursive:true});
  if(await page.locator('.settings-card').isVisible())await page.screenshot({path:path.join(out,'axiom-setup.png')});
  const key=page.locator('.settings-card input[type=password]').first();
  if(await key.isVisible() && process.env.AXIOM_QA_FILL_KEY){
    await key.fill(process.env.AXIOM_QA_FILL_KEY);
    await page.locator('.settings-card .primary').click();
  }
  if(process.env.AXIOM_QA_FILL_KEY && await page.locator('.settings-card').count()){
    await page.waitForSelector('.settings-card',{state:'detached',timeout:10000});
  }
  if(!process.env.AXIOM_QA_FILL_KEY&&await page.locator('.settings-card').isVisible())await page.locator('.settings-card>header>button').click();
  await page.waitForTimeout(900);
  const expectedModules={TOOLS:'Working capabilities',SCREEN:'Vision and desktop world model',FILES:'Secure file workspace',WEB:'Live intelligence',AUTOMATE:'Computer command matrix',BUILD:'Axiom Build Lab',MEMORY:'Governed memory',CORE:'Axiom Runtime + Hardware Core',STARRED:'Mission control'};
  const modules=[];let runtimeConsole={metrics:0,permissionKernel:false,guarded:false,diagnostics:false,vitals:0,hardwareCards:0,operationalProbes:0};let memoryConsole={metrics:0,kinds:0,fabric:false};let desktopWorld={metrics:0,scan:false,topology:false};let missionConsole={metrics:0,cards:0,scheduler:false};let intelConsole={feeds:0,search:false,truth:false};let smartHomeConsole={visible:false,setup:false};
  for(const [label,expectedTitle] of Object.entries(expectedModules)){
    await page.locator('.rail-routes button').filter({has:page.getByText(label,{exact:true})}).click();
    await page.waitForSelector('.module-panel');
    const title=await page.locator('.module-panel h1').innerText();
    modules.push({label,title,expectedTitle,matched:title===expectedTitle});
    if(label==='CORE'){runtimeConsole={metrics:await page.locator('.runtime-metrics article').count(),permissionKernel:await page.locator('.approval-queue').isVisible(),guarded:await page.getByText('CONSEQUENTIAL ACTIONS ARE INTERLOCKED',{exact:true}).isVisible(),diagnostics:await page.locator('.diagnostics-console').isVisible(),vitals:await page.locator('.diag-overview article').count(),hardwareCards:await page.locator('.diag-card').count(),operationalProbes:await page.locator('.operational-probes .probe-grid article').count()};await page.screenshot({path:path.join(out,'axiom-runtime-core.png'),fullPage:true});}
    if(label==='MEMORY'){memoryConsole={metrics:await page.locator('.memory-metrics article').count(),kinds:await page.locator('.memory-entry select option').count(),fabric:await page.locator('.memory-fabric').isVisible()};await page.screenshot({path:path.join(out,'axiom-memory-fabric.png')});}
    if(label==='SCREEN'){desktopWorld={metrics:await page.locator('.world-metrics article').count(),scan:await page.getByRole('button',{name:'SCAN DESKTOP'}).isVisible(),topology:await page.locator('.world-topology').isVisible()};await page.screenshot({path:path.join(out,'axiom-desktop-world.png'),fullPage:true});}
    if(label==='STARRED'){missionConsole={metrics:await page.locator('.mission-status article').count(),cards:await page.locator('.mission-card').count(),scheduler:await page.getByText('TO-DO MATRIX',{exact:true}).isVisible()};await page.screenshot({path:path.join(out,'axiom-mission-control.png'),fullPage:true});}
    if(label==='WEB'){intelConsole={feeds:await page.locator('.intel-feeds button').count(),search:await page.getByRole('button',{name:'SEARCH LIVE'}).isVisible(),truth:await page.getByText('Every briefing forces a current search. Axiom will not fill a missing signal with stale model memory.',{exact:true}).isVisible()};await page.screenshot({path:path.join(out,'axiom-global-intelligence.png'),fullPage:true});}
    if(label==='AUTOMATE'){smartHomeConsole={visible:await page.locator('.smart-home-panel').isVisible(),setup:await page.getByText(/CONNECT YOUR HOME|SMART HOME ONLINE/).isVisible()};await page.screenshot({path:path.join(out,'axiom-smart-home-command-plane.png'),fullPage:true});}
  }
  await page.getByRole('button',{name:/CHAT/}).click();
  await page.getByRole('button',{name:/HISTORY/}).click();
  await page.waitForSelector('.conversation-log');
  const history={visible:await page.locator('.conversation-log').isVisible(),messages:await page.locator('.conversation-scroll article').count()};
  await page.locator('.conversation-log>header>button').click();
  await page.screenshot({path:path.join(out,'axiom-home.png')});
  const operationalTruth={
    visible:await page.locator('.operational-truth').isVisible(),
    routes:await page.locator('.operational-truth .truth-routes>div').count(),
    latency:await page.locator('.operational-truth .truth-latency>span').count(),
    refresh:await page.getByRole('button',{name:'Refresh capability probes'}).isVisible(),
  };
  const vitalVisual={
    visible:await page.locator('.vital-reactor').isVisible(),
    rings:await page.locator('.vital-reactor .reactor-ring').count(),
    traces:await page.locator('.vital-reactor .trace').count(),
    sensors:await page.locator('.vital-reactor .reactor-sensors>div').count(),
    opensDiagnostics:false,
  };
  await page.locator('.vital-reactor').click();
  await page.waitForSelector('.diagnostics-console');
  vitalVisual.opensDiagnostics=await page.locator('.diagnostics-console').isVisible();
  await page.getByRole('button',{name:/CHAT/}).click();
  await page.getByRole('button',{name:'Open settings'}).click();
  await page.waitForSelector('.settings-card');
  await page.screenshot({path:path.join(out,'axiom-settings-providers.png')});
  const settingsConsole={
    visible:await page.locator('.settings-card').isVisible(),
    providers:await page.locator('.provider-tabs').first().getByRole('button').allTextContents(),
    passwordFields:await page.locator('.settings-card input[type=password]').count(),
    hasModel:await page.locator('input[list="model-options"]').isVisible(),
    hasWorkspace:await page.getByText('Coding workspace',{exact:true}).isVisible(),
    startupMicrophone:await page.getByRole('checkbox',{name:/HANDS-FREE CONVERSATION/}).isChecked(),
    identitySync:await page.getByText('AXIOM IDENTITY SYNC',{exact:true}).isVisible(),
    syncState:await page.locator('.sync-state').isVisible(),
    connectors:await page.locator('.connector-card').count(),
    dailyBackups:await page.getByRole('checkbox',{name:/DAILY VERIFIED BACKUPS/}).isChecked(),
  };
  await page.getByText('AXIOM IDENTITY SYNC',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(out,'axiom-settings-sync.png')});
  await page.locator('.voice-tabs').getByRole('button',{name:'ELEVENLABS'}).click();
  await page.screenshot({path:path.join(out,'axiom-settings-elevenlabs.png')});
  settingsConsole.elevenLabs={
    visible:await page.locator('.voice-console').isVisible(),
    sliders:await page.locator('.voice-sliders input[type=range]').count(),
    deliverySpeed:await page.locator('.voice-delivery input[type=range]').isVisible(),
    voiceSelector:await page.locator('.voice-console select').first().isVisible(),
    preview:await page.getByRole('button',{name:'PREVIEW VOICE'}).isVisible(),
  };
  await page.locator('.settings-card>header>button').click();
  const result=await page.evaluate(()=>{
    const voiceButton=document.querySelector('.voice-button')?.getBoundingClientRect();
    const composerInput=document.querySelector('.composer input')?.getBoundingClientRect();
    const identityPill=document.querySelector('.voice-identity-pill')?.getBoundingClientRect();
    const identityLine=document.querySelector('.identity-line')?.getBoundingClientRect();
    const composer=document.querySelector('.composer')?.getBoundingClientRect();
    return ({
    size:{w:innerWidth,h:innerHeight},
    canvas:{w:document.querySelector('canvas')?.width,h:document.querySelector('canvas')?.height},
    nav:document.querySelectorAll('.rail button').length,
    telemetry:document.querySelectorAll('.telemetry section').length,
    status:document.querySelector('.top-state')?.textContent?.trim(),
    composer:!!document.querySelector('.composer input'),
    composerGap:voiceButton&&composerInput?composerInput.left-voiceButton.right:null,
    verticalGaps:{pillToIdentity:identityPill&&identityLine?identityLine.top-identityPill.bottom:null,identityToComposer:identityLine&&composer?composer.top-identityLine.bottom:null},
    overflow:{x:document.documentElement.scrollWidth>innerWidth,y:document.documentElement.scrollHeight>innerHeight},
    legacyReferenceLayer:!!document.querySelector('.reference-master')
  });});
  const assertions={version:appInfo.version===packageVersion,canvas:Boolean(result.canvas.w&&result.canvas.h),nav:result.nav===11,modules:modules.length===9&&modules.every(module=>module.matched),runtime:runtimeConsole.metrics===5&&runtimeConsole.permissionKernel&&runtimeConsole.guarded&&runtimeConsole.diagnostics&&runtimeConsole.vitals===6&&runtimeConsole.hardwareCards===5&&runtimeConsole.operationalProbes>=10,memory:memoryConsole.metrics===4&&memoryConsole.kinds===6&&memoryConsole.fabric,desktopWorld:desktopWorld.metrics===5&&desktopWorld.scan&&desktopWorld.topology,mission:missionConsole.metrics===4&&missionConsole.cards===4&&missionConsole.scheduler,intel:intelConsole.feeds===4&&intelConsole.search&&intelConsole.truth,smartHome:smartHomeConsole.visible&&smartHomeConsole.setup,history:history.visible,vitalVisual:vitalVisual.visible&&vitalVisual.rings===3&&vitalVisual.traces===4&&vitalVisual.sensors===4&&vitalVisual.opensDiagnostics,operationalTruth:operationalTruth.visible&&operationalTruth.routes===4&&operationalTruth.latency===4&&operationalTruth.refresh,settings:settingsConsole.visible&&settingsConsole.providers.length===3&&settingsConsole.passwordFields>=8&&settingsConsole.hasModel&&settingsConsole.hasWorkspace&&settingsConsole.startupMicrophone&&settingsConsole.identitySync&&settingsConsole.syncState&&settingsConsole.connectors===5&&settingsConsole.dailyBackups&&settingsConsole.elevenLabs.visible&&settingsConsole.elevenLabs.sliders===3&&settingsConsole.elevenLabs.deliverySpeed&&settingsConsole.elevenLabs.voiceSelector&&settingsConsole.elevenLabs.preview,telemetry:result.telemetry>=5,composer:result.composer&&Number(result.composerGap)>=8,conversationStack:Number(result.verticalGaps.pillToIdentity)>=8&&Number(result.verticalGaps.identityToComposer)>=8,noLegacyLayer:!result.legacyReferenceLayer,noOverflow:!result.overflow.x&&!result.overflow.y,noErrors:errors.length===0};
  console.log(JSON.stringify({appInfo,result,modules,runtimeConsole,memoryConsole,desktopWorld,missionConsole,intelConsole,history,vitalVisual,operationalTruth,settingsConsole,errors,failedRequests,assertions,passed:Object.values(assertions).every(Boolean)},null,2));
  await browser.close(); if(!Object.values(assertions).every(Boolean))process.exitCode=1;
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
