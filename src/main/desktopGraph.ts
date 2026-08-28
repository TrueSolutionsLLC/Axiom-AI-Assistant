import crypto from 'node:crypto';
import type { DesktopEntity, DesktopGraphSnapshot, DesktopObservation, DesktopRelation } from '../shared/contracts';

export interface DesktopGraphData {
  entities: DesktopEntity[];
  relations: DesktopRelation[];
  observations: DesktopObservation[];
}

type RawWindow = Record<string, unknown>;

const entityId = (stableKey:string):string => `dsk-${crypto.createHash('sha256').update(stableKey).digest('hex').slice(0,18)}`;
const relationId = (fromId:string,toId:string,type:DesktopRelation['type']):string => `rel-${crypto.createHash('sha256').update(`${fromId}|${type}|${toId}`).digest('hex').slice(0,18)}`;
const clean = (value:unknown,limit=240):string => String(value ?? '').replace(/\s+/g,' ').trim().slice(0,limit);
const keyPart = (value:unknown):string => clean(value).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,120) || 'unknown';
const finite = (value:unknown):number => Number.isFinite(Number(value)) ? Number(value) : 0;

export function emptyDesktopGraphData():DesktopGraphData{return{entities:[],relations:[],observations:[]};}

function observation(data:DesktopGraphData,kind:DesktopObservation['kind'],summary:string,toolName:string,at:string,entityIdValue?:string):void{
  data.observations.push({id:crypto.randomUUID(),entityId:entityIdValue,kind,summary:clean(summary,500),toolName,at});
}

function upsertRelation(data:DesktopGraphData,fromId:string,toId:string,type:DesktopRelation['type'],at:string):void{
  const id=relationId(fromId,toId,type),existing=data.relations.find((item)=>item.id===id);
  if(existing)existing.lastSeenAt=at;
  else data.relations.push({id,fromId,toId,type,firstSeenAt:at,lastSeenAt:at});
}

function upsertApplication(data:DesktopGraphData,name:string,at:string,toolName:string):DesktopEntity{
  const stableKey=`application:${keyPart(name)}`,id=entityId(stableKey),existing=data.entities.find((item)=>item.id===id);
  if(existing){existing.status='live';existing.lastSeenAt=at;existing.seenCount+=1;return existing;}
  const item:DesktopEntity={id,kind:'application',stableKey,label:clean(name,160)||'Unknown application',status:'live',application:clean(name,160),firstSeenAt:at,lastSeenAt:at,seenCount:1,attributes:{processName:clean(name,160)}};
  data.entities.push(item);observation(data,'discovered',`Discovered application ${item.label}.`,toolName,at,item.id);return item;
}

function findWindow(data:DesktopGraphData,application:string,window:RawWindow,semanticKey:string):DesktopEntity|undefined{
  const hwnd=finite(window.hwnd);
  return data.entities.find((item)=>item.kind==='window'&&item.application===application&&finite(item.attributes.hwnd)===hwnd&&hwnd>0)
    ?? data.entities.find((item)=>item.kind==='window'&&item.stableKey===semanticKey);
}

export function ingestWindowSnapshot(data:DesktopGraphData,windows:RawWindow[],at=new Date().toISOString(),toolName='list_running_windows'):DesktopGraphData{
  const seenWindows=new Set<string>(),seenApps=new Set<string>();
  for(const raw of windows.slice(0,80)){
    const title=clean(raw.title,300),application=clean(raw.processName,160)||'Unknown application';
    if(!title)continue;
    const app=upsertApplication(data,application,at,toolName);seenApps.add(app.id);
    const stableKey=`window:${keyPart(application)}:${keyPart(raw.className)}:${keyPart(title)}`;
    let entity=findWindow(data,application,raw,stableKey);
    const attributes:DesktopEntity['attributes']={hwnd:finite(raw.hwnd),processId:finite(raw.processId),title,width:finite(raw.width),height:finite(raw.height),className:clean(raw.className,180),isForeground:Boolean(raw.isForeground),ownerHwnd:finite(raw.ownerHwnd)};
    if(entity){
      const priorTitle=String(entity.attributes.title??entity.label),changed=priorTitle!==title||entity.status==='stale';
      entity.label=title;entity.status='live';entity.lastSeenAt=at;entity.seenCount+=1;entity.attributes=attributes;
      if(changed)observation(data,'changed',`Window ${priorTitle} is now ${title}.`,toolName,at,entity.id);
    }else{
      let id=entityId(stableKey);if(data.entities.some((item)=>item.id===id))id=`${id}-${finite(raw.hwnd)}`;
      entity={id,kind:'window',stableKey,label:title,status:'live',application,firstSeenAt:at,lastSeenAt:at,seenCount:1,attributes};
      data.entities.push(entity);observation(data,'discovered',`Discovered window ${title} in ${application}.`,toolName,at,entity.id);
    }
    seenWindows.add(entity.id);upsertRelation(data,app.id,entity.id,'contains',at);
  }
  for(const item of data.entities){
    if(item.kind==='window'&&item.status==='live'&&!seenWindows.has(item.id)){
      item.status='stale';observation(data,'disappeared',`Window ${item.label} is no longer visible.`,toolName,at,item.id);
    }
    if(item.kind==='application'&&!seenApps.has(item.id))item.status='stale';
  }
  trimGraph(data);return data;
}

function targetEntity(data:DesktopGraphData,target:string):DesktopEntity|undefined{
  const q=target.toLowerCase(),hwnd=/^hwnd:(\d+)$/i.exec(target)?.[1];
  return data.entities.find((item)=>hwnd&&String(item.attributes.hwnd)===hwnd)
    ?? data.entities.filter((item)=>item.status==='live').find((item)=>`${item.label} ${item.application??''} ${item.attributes.processName??''}`.toLowerCase().includes(q))
    ?? data.entities.find((item)=>`${item.label} ${item.application??''}`.toLowerCase().includes(q));
}

function ingestControls(data:DesktopGraphData,parent:DesktopEntity|undefined,application:string,controls:string,at:string,toolName:string):void{
  if(!parent||!controls)return;
  const lines=controls.split(/\r?\n/).slice(0,500),seen=new Set<string>();let added=0;
  for(const line of lines){
    const match=/^\s*([A-Za-z0-9_.:-]{3,120})\s+((?:Button|Edit|Text|CheckBox|RadioButton|ComboBox|ListItem|MenuItem|TabItem|TreeItem|Hyperlink|Slider|Spinner)\b.{0,220})$/.exec(line);
    if(!match||/^(found|use|window|control|selector)$/i.test(match[1]))continue;
    const selector=match[1],label=clean(match[2],180);if(!label||seen.has(selector)||added>=120)continue;seen.add(selector);added+=1;
    const stableKey=`control:${parent.stableKey}:${keyPart(selector)}`,id=entityId(stableKey),existing=data.entities.find((item)=>item.id===id);
    if(existing){existing.label=label;existing.status='live';existing.lastSeenAt=at;existing.seenCount+=1;existing.attributes={...existing.attributes,selector};}
    else{data.entities.push({id,kind:'control',stableKey,label,status:'live',application,firstSeenAt:at,lastSeenAt:at,seenCount:1,attributes:{selector}});observation(data,'discovered',`Mapped control ${label}.`,toolName,at,id);}
    upsertRelation(data,parent.id,id,'contains',at);
  }
}

export function ingestDesktopToolResult(data:DesktopGraphData,toolName:string,args:Record<string,unknown>,output:string,at=new Date().toISOString()):DesktopGraphData{
  let parsed:Record<string,unknown>;try{parsed=JSON.parse(output) as Record<string,unknown>;}catch{return data;}
  if(toolName==='list_running_windows'&&Array.isArray(parsed.windows))return ingestWindowSnapshot(data,parsed.windows as RawWindow[],at,toolName);
  const application=clean(parsed.application??args.application,180),parent=targetEntity(data,application);
  if(toolName==='inspect_application_ui'){
    if(parent){parent.lastSeenAt=at;parent.seenCount+=1;observation(data,'observed',`Inspected the accessible controls in ${parent.label}.`,toolName,at,parent.id);}
    ingestControls(data,parent,application,String(parsed.controls??'').slice(0,40_000),at,toolName);
  }else if(['invoke_application_control','set_application_field','control_application_window'].includes(toolName)){
    observation(data,'acted-on',`${toolName.replaceAll('_',' ')}${application?` in ${application}`:''}.`,toolName,at,parent?.id);
  }else if(toolName==='open_application'){
    const name=clean(parsed.application??parsed.name??args.application??args.name,160);if(name)upsertApplication(data,name,at,toolName);
  }
  trimGraph(data);return data;
}

function trimGraph(data:DesktopGraphData):void{
  data.observations=data.observations.slice(-1000);
  if(data.entities.length>500){const retained=[...data.entities].sort((a,b)=>(a.status===b.status?b.lastSeenAt.localeCompare(a.lastSeenAt):a.status==='live'?-1:1)).slice(0,500),ids=new Set(retained.map((item)=>item.id));data.entities=retained;data.relations=data.relations.filter((item)=>ids.has(item.fromId)&&ids.has(item.toId));}
  data.relations=data.relations.slice(-1200);
}

export function snapshotDesktopGraph(data:DesktopGraphData):DesktopGraphSnapshot{
  const entities=data.entities.map((item)=>({...item,attributes:{...item.attributes}})).sort((a,b)=>(a.status===b.status?b.lastSeenAt.localeCompare(a.lastSeenAt):a.status==='live'?-1:1));
  return{generatedAt:new Date().toISOString(),entities,relations:data.relations.map((item)=>({...item})),observations:[...data.observations].reverse().map((item)=>({...item})),metrics:{applications:entities.filter((item)=>item.kind==='application').length,liveWindows:entities.filter((item)=>item.kind==='window'&&item.status==='live').length,knownControls:entities.filter((item)=>item.kind==='control').length,staleObjects:entities.filter((item)=>item.status==='stale').length,observations:data.observations.length}};
}

export function queryDesktopGraph(data:DesktopGraphData,query:string,limit=20):DesktopEntity[]{
  const terms=clean(query,500).toLowerCase().split(/\s+/).filter(Boolean);
  return data.entities.map((item)=>{const haystack=`${item.label} ${item.application??''} ${item.kind} ${Object.values(item.attributes).join(' ')}`.toLowerCase();const score=(item.status==='live'?4:0)+(item.kind==='window'?2:0)+terms.reduce((sum,term)=>sum+(haystack.includes(term)?5:0),0);return{item,score};}).filter(({score})=>score>0&&(!terms.length||score>(4))).sort((a,b)=>b.score-a.score||b.item.lastSeenAt.localeCompare(a.item.lastSeenAt)).slice(0,Math.max(1,Math.min(50,limit))).map(({item})=>({...item,attributes:{...item.attributes}}));
}
