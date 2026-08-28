import type { AgentItem, AssistantReply, AssistantRequest, BackgroundEvent, MonitorItem, SchedulerSnapshot, ScreenCapture } from '../shared/contracts';
import type { AppStore } from './store';
import { earliestWake } from './schedulerCore';

interface BackgroundDependencies {
  run(input:AssistantRequest):Promise<AssistantReply>;
  captureScreen():Promise<ScreenCapture>;
  captureCamera(reason:string):Promise<ScreenCapture>;
  emit(event:BackgroundEvent):void;
  notify(title:string,text:string):void;
  pollMedia?():Promise<BackgroundEvent[]>;
}

export class BackgroundRuntime {
  private timer?:NodeJS.Timeout;
  private ticking=false;
  private readonly runningAgents=new Set<string>();
  constructor(private readonly store:AppStore,private readonly deps:BackgroundDependencies){}

  start():void{if(this.timer)return;this.timer=setInterval(()=>void this.tick(),10_000);this.timer.unref?.();setTimeout(()=>void this.tick(),1500);}
  stop():void{if(this.timer)clearInterval(this.timer);this.timer=undefined;}

  snapshot():SchedulerSnapshot{
    const agents=this.store.agents(),monitors=this.store.monitors(),commitments=this.store.commitments();
    return{running:Boolean(this.timer),checkedAt:new Date().toISOString(),agents,agentRuns:this.store.agentRuns(),monitors,events:this.store.backgroundEvents(),nextWakeAt:earliestWake([...agents.filter((item)=>item.enabled).map((item)=>item.schedule.nextRunAt),...monitors.filter((item)=>item.status==='active').map((item)=>item.nextRunAt),...commitments.filter((item)=>item.status==='open').map((item)=>item.dueAt)])};
  }

  async runAgentNow(id:string):Promise<void>{const agent=this.store.findAgent(id);if(!agent)throw new Error('Agent not found.');if(!agent.enabled)throw new Error('Enable this agent before running it.');await this.executeAgent(agent);}

  async tick(at=new Date()):Promise<void>{
    if(this.ticking)return;this.ticking=true;
    try{
      for(const commitment of this.store.dueCommitments(at)){
        const event=this.store.addBackgroundEvent('reminder','Reminder',commitment.title,true,commitment.sourceTaskId);this.store.markCommitmentNotified(commitment.id,event.createdAt);this.deliver(event);
      }
      for(const agent of this.store.dueAgents(at))void this.executeAgent(agent);
      for(const monitor of this.store.dueMonitors(at))void this.executeMonitor(monitor);
      if(this.store.automaticBackupDue(at)){
        try{const backup=this.store.createBackup();this.store.markAutomaticBackup(backup.createdAt);this.deliver(this.store.addBackgroundEvent('backup','Verified automatic backup',`Saved ${backup.bytes.toLocaleString()} bytes to ${backup.path}. Integrity ${backup.sha256.slice(0,12)}…`,false));}
        catch(reason){this.deliver(this.store.addBackgroundEvent('system','Automatic backup failed',reason instanceof Error?reason.message:String(reason),false));}
      }
      if(this.deps.pollMedia)for(const event of await this.deps.pollMedia())this.deliver(event);
    }finally{this.ticking=false;}
  }

  private async executeAgent(agent:AgentItem):Promise<void>{
    if(this.runningAgents.has(agent.id))return;this.runningAgents.add(agent.id);let runId='';
    try{
      const run=this.store.beginAgentRun(agent.id);runId=run.id;
      const reply=await this.deps.run({message:`You are the autonomous specialist agent “${agent.name}” (${agent.role}). Execute this assignment now: ${agent.instructions}\n\nWork only within Axiom's available tools and permission policy. Verify any action you take. Return a concise result for the user.`,history:[]});
      this.store.appendAudit(reply.toolEvents,run.taskId);const pending=reply.toolEvents.find((event)=>event.status==='blocked'&&event.approvalId),failed=reply.toolEvents.some((event)=>event.status==='failed');
      const status=failed?'failed':'completed',summary=pending?`${reply.text}\nApproval is required before a blocked action can continue.`:reply.text;
      this.store.finishAgentRun(run.id,status,summary);this.deliver(this.store.addBackgroundEvent('agent',`${agent.name} ${status}`,summary,true,run.taskId));
    }catch(reason){const detail=reason instanceof Error?reason.message:String(reason);if(runId)this.store.finishAgentRun(runId,'failed',detail);this.deliver(this.store.addBackgroundEvent('agent',`${agent.name} failed`,detail,false));}
    finally{this.runningAgents.delete(agent.id);}
  }

  private async executeMonitor(monitor:MonitorItem):Promise<void>{
    try{
      const capture=monitor.source==='screen'?await this.deps.captureScreen():await this.deps.captureCamera(`Background monitor “${monitor.title}” needs one camera frame.`);
      const reply=await this.deps.run({message:`Analyze this single ${monitor.source} frame for a user-approved monitor. Condition: ${monitor.instruction}\nReply exactly with TRIGGER: followed by the observation if the condition is clearly true. Otherwise reply CLEAR: followed by one short observation. Do not use tools and do not infer anything not visibly supported.`,history:[],imageDataUrl:capture.dataUrl});
      const triggered=/^\s*TRIGGER\s*:/i.test(reply.text),observation=reply.text.replace(/^\s*(?:TRIGGER|CLEAR)\s*:\s*/i,'').trim()||'No supported observation.';
      this.store.settleMonitor(monitor.id,triggered?'triggered':'active',observation);
      if(triggered)this.deliver(this.store.addBackgroundEvent('monitor',monitor.title,observation,true));
    }catch(reason){const detail=reason instanceof Error?reason.message:String(reason);this.store.settleMonitor(monitor.id,'failed',detail);this.deliver(this.store.addBackgroundEvent('monitor',`${monitor.title} failed`,detail,false));}
  }

  private deliver(event:BackgroundEvent):void{this.deps.emit(event);this.deps.notify(event.title,event.text);}
}
