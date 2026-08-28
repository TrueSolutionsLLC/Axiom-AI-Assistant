import type { ScheduleSpec } from '../shared/contracts';

const MINUTE=60_000;

export function normalizeSchedule(input?:Partial<ScheduleSpec>,from=new Date()):ScheduleSpec{
  const kind=input?.kind==='interval'||input?.kind==='daily'?input.kind:'manual';
  if(kind==='manual')return{kind};
  if(kind==='interval'){
    const intervalMinutes=Math.max(1,Math.min(30*24*60,Math.round(Number(input?.intervalMinutes)||60)));
    return{kind,intervalMinutes,nextRunAt:validFuture(input?.nextRunAt,from)??new Date(from.getTime()+intervalMinutes*MINUTE).toISOString()};
  }
  const dailyTime=/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input?.dailyTime||'')?input!.dailyTime!:'09:00';
  return{kind,dailyTime,nextRunAt:validFuture(input?.nextRunAt,from)??nextDaily(dailyTime,from).toISOString()};
}

export function advanceSchedule(schedule:ScheduleSpec,from=new Date()):ScheduleSpec{
  const clean=normalizeSchedule({...schedule,nextRunAt:undefined},from);
  if(clean.kind==='manual')return clean;
  if(clean.kind==='interval')return{...clean,nextRunAt:new Date(from.getTime()+(clean.intervalMinutes||60)*MINUTE).toISOString()};
  return{...clean,nextRunAt:nextDaily(clean.dailyTime||'09:00',from).toISOString()};
}

export function scheduleIsDue(schedule:ScheduleSpec,at=new Date()):boolean{
  return schedule.kind!=='manual'&&Boolean(schedule.nextRunAt)&&Date.parse(schedule.nextRunAt!)<=at.getTime();
}

export function earliestWake(values:Array<string|undefined>,fallback=new Date(Date.now()+15_000)):string{
  const times=values.map((value)=>Date.parse(value||'')).filter(Number.isFinite);
  return new Date(times.length?Math.min(...times):fallback.getTime()).toISOString();
}

function validFuture(value:string|undefined,from:Date):string|undefined{
  const time=Date.parse(value||'');return Number.isFinite(time)&&time>from.getTime()?new Date(time).toISOString():undefined;
}

function nextDaily(value:string,from:Date):Date{
  const [hour,minute]=value.split(':').map(Number),candidate=new Date(from);
  candidate.setHours(hour,minute,0,0);
  if(candidate.getTime()<=from.getTime())candidate.setDate(candidate.getDate()+1);
  return candidate;
}
