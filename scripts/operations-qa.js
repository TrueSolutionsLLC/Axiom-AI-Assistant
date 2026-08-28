const {chromium}=require('playwright');

(async()=>{
  const browser=await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT||'9444'}`),page=browser.contexts().flatMap((context)=>context.pages())[0],errors=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  const result=await page.evaluate(async()=>{
    const token=`QA-${Date.now()}`;
    const todo=await window.axiom.addTodo(`${token} mission item`),open=(await window.axiom.listTodos()).some((item)=>item.id===todo.id&&item.status==='open');
    const completed=(await window.axiom.setTodoStatus(todo.id,'completed')).some((item)=>item.id===todo.id&&item.status==='completed');
    await window.axiom.removeTodo(todo.id);
    const agent=await window.axiom.saveAgent({name:`${token} Scout`,role:'QA specialist',instructions:'Return the word verified.',schedule:{kind:'interval',intervalMinutes:90}});
    let scheduler=await window.axiom.getSchedulerSnapshot();const agentScheduled=scheduler.agents.some((item)=>item.id===agent.id&&item.schedule.kind==='interval'&&Boolean(item.schedule.nextRunAt));
    scheduler=await window.axiom.setAgentEnabled(agent.id,false);const agentPaused=scheduler.agents.some((item)=>item.id===agent.id&&!item.enabled);
    await window.axiom.removeAgent(agent.id);
    const monitor=await window.axiom.addMonitor({title:`${token} Watch`,instruction:'Trigger only if the exact QA token is visible.',source:'screen',intervalSeconds:300,durationMinutes:5});
    scheduler=await window.axiom.stopMonitor(monitor.id);const monitorStopped=scheduler.monitors.some((item)=>item.id===monitor.id&&item.status==='stopped');
    const guide=await window.axiom.showCursorGuide(400,300,'QA TARGET',1400);
    return{open,completed,removed:!(await window.axiom.listTodos()).some((item)=>item.id===todo.id),agentScheduled,agentPaused,agentRemoved:!(await window.axiom.getSchedulerSnapshot()).agents.some((item)=>item.id===agent.id),monitorStopped,schedulerRunning:scheduler.running,connectors:(await window.axiom.listConnectors()).map((item)=>item.id),media:Array.isArray(await window.axiom.listMediaArtifacts()),guide:guide.shown&&guide.label==='QA TARGET'};
  });
  const assertions={...result,connectors:Array.isArray(result.connectors)&&result.connectors.length===4,media:result.media,noErrors:errors.length===0},passed=Object.values(assertions).every(Boolean);
  console.log(JSON.stringify({result,errors,assertions,passed},null,2));await browser.close();if(!passed)process.exitCode=1;
})().catch((error)=>{console.error(error.stack||error);process.exit(1);});
