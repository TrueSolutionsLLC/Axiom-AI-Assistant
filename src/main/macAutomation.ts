import { spawn } from 'node:child_process';

interface CommandResult { exitCode:number|null; stdout:string; stderr:string }

function runJxa(script:string,timeout=20_000):Promise<CommandResult>{
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/osascript',['-l','JavaScript','-e',script],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('macOS Accessibility timed out.'));},timeout);
    child.stdout.on('data',(chunk)=>{stdout=(stdout+chunk.toString()).slice(-120_000);});
    child.stderr.on('data',(chunk)=>{stderr=(stderr+chunk.toString()).slice(-30_000);});
    child.on('error',(error)=>{clearTimeout(timer);reject(error);});
    child.on('close',(exitCode)=>{clearTimeout(timer);resolve({exitCode,stdout,stderr});});
  });
}

async function execute(script:string):Promise<unknown>{
  if(process.platform!=='darwin')throw new Error('macOS Accessibility is available only on macOS.');
  const result=await runJxa(script);
  if(result.exitCode!==0){
    const detail=(result.stderr||result.stdout).trim();
    if(/not authorized|assistive access|accessibility/i.test(detail))throw new Error('Axiom needs macOS Accessibility permission. Open System Settings → Privacy & Security → Accessibility, enable Axiom, then reopen it.');
    throw new Error(detail||'macOS Accessibility action failed.');
  }
  try{return JSON.parse(result.stdout.trim()||'null');}catch{return{result:result.stdout.trim()};}
}

// JXA has no global delay(); it is a StandardAdditions command and must be
// reached through an application object, exactly as controlMacMedia does for
// getVolumeSettings/setVolume. Without this every UI action below fails with
// "Can't find variable: delay".
export const macScriptPrelude=`
ObjC.import('stdlib');
const _standard=Application.currentApplication();_standard.includeStandardAdditions=true;
const delay=(seconds)=>_standard.delay(seconds);
`;

export const bootstrap=(application:string)=>`${macScriptPrelude}
const appName=${JSON.stringify(application)};
const se=Application('System Events');
const visible=se.applicationProcesses.whose({visible:true})();
let proc=visible.find(p=>String(p.name()).toLowerCase()===appName.toLowerCase());
if(!proc)proc=visible.find(p=>String(p.name()).toLowerCase().includes(appName.toLowerCase()));
if(!proc)throw new Error('Application not found: '+appName);
`;

const finder=`
function safe(fn,fallback){try{return fn();}catch(_){return fallback;}}
function info(el,depth){return{
  name:String(safe(()=>el.name(),'')),role:String(safe(()=>el.role(),'')),description:String(safe(()=>el.description(),'')),
  value:String(safe(()=>el.value(),'')),enabled:Boolean(safe(()=>el.enabled(),true)),depth,
  actions:safe(()=>el.actions().map(a=>String(a.name())),[])
};}
function children(el){return safe(()=>el.uiElements(),[]);}
function locate(root,needle,maxDepth){const wanted=needle.toLowerCase(),queue=[{el:root,depth:0}];while(queue.length){const item=queue.shift(),meta=info(item.el,item.depth);if([meta.name,meta.description,meta.value,meta.role].some(v=>v.toLowerCase()===wanted)||[meta.name,meta.description].some(v=>v.toLowerCase().includes(wanted)))return item.el;if(item.depth<maxDepth)children(item.el).slice(0,180).forEach(el=>queue.push({el,depth:item.depth+1}));}return null;}
`;

export async function listMacWindows():Promise<unknown>{
  return execute(`const se=Application('System Events');const rows=[];se.applicationProcesses.whose({visible:true})().forEach(p=>{const name=String(p.name()),pid=Number(p.unixId()),frontmost=Boolean(p.frontmost());let wins=[];try{wins=p.windows();}catch(_){}if(!wins.length)rows.push({title:name,process:name,pid,width:0,height:0,isForeground:frontmost});wins.forEach(w=>{let position=[0,0],size=[0,0],title=name;try{position=w.position();size=w.size();title=String(w.name()||name);}catch(_){}rows.push({title,process:name,pid,x:Number(position[0]||0),y:Number(position[1]||0),width:Number(size[0]||0),height:Number(size[1]||0),isForeground:frontmost});});});JSON.stringify(rows);`);
}

export async function inspectMacApplication(application:string):Promise<unknown>{
  return execute(`${bootstrap(application)}${finder}const output=[],queue=[];safe(()=>proc.windows(),[]).forEach(w=>queue.push({el:w,depth:0}));while(queue.length&&output.length<420){const item=queue.shift(),meta=info(item.el,item.depth);if(meta.name||meta.description||meta.role)output.push(meta);if(item.depth<9)children(item.el).slice(0,150).forEach(el=>queue.push({el,depth:item.depth+1}));}JSON.stringify({application:String(proc.name()),controls:output,engine:'macOS Accessibility'});`);
}

export async function invokeMacControl(application:string,selector:string):Promise<unknown>{
  return execute(`${bootstrap(application)}${finder}proc.frontmost=true;delay(0.08);let target=null;safe(()=>proc.windows(),[]).some(w=>(target=locate(w,${JSON.stringify(selector)},10)));if(!target)throw new Error('Control not found: '+${JSON.stringify(selector)});const actions=safe(()=>target.actions(),[]),press=actions.find(a=>String(a.name())==='AXPress');if(press)press.perform();else if(typeof target.click==='function')target.click();else throw new Error('Control cannot be pressed.');delay(0.08);JSON.stringify({invoked:true,application:String(proc.name()),selector:${JSON.stringify(selector)},role:String(safe(()=>target.role(),'')),enabled:Boolean(safe(()=>target.enabled(),true))});`);
}

export async function setMacField(application:string,selector:string,value:string):Promise<unknown>{
  return execute(`${bootstrap(application)}${finder}proc.frontmost=true;delay(0.08);let target=null;safe(()=>proc.windows(),[]).some(w=>(target=locate(w,${JSON.stringify(selector)},10)));if(!target)throw new Error('Editable control not found: '+${JSON.stringify(selector)});target.value=${JSON.stringify(value)};delay(0.08);JSON.stringify({changed:String(safe(()=>target.value(),''))===${JSON.stringify(value)},application:String(proc.name()),selector:${JSON.stringify(selector)},characters:${value.length}});`);
}

export async function selectMacMenu(application:string,menu:string,item:string,subitem=''):Promise<unknown>{
  return execute(`${bootstrap(application)}${finder}proc.frontmost=true;delay(0.08);const menuName=${JSON.stringify(menu)},itemName=${JSON.stringify(item)},subitemName=${JSON.stringify(subitem)};const bar=safe(()=>proc.menuBars()[0],null);if(!bar)throw new Error('Application menu bar is unavailable.');const heading=safe(()=>bar.menuBarItems.byName(menuName),null);if(!heading||!safe(()=>heading.exists(),false))throw new Error('Menu not found: '+menuName);heading.click();delay(0.08);let target=safe(()=>heading.menus()[0].menuItems.byName(itemName),null);if(!target||!safe(()=>target.exists(),false))throw new Error('Menu item not found: '+menuName+' → '+itemName);if(subitemName){target=safe(()=>target.menus()[0].menuItems.byName(subitemName),null);if(!target||!safe(()=>target.exists(),false))throw new Error('Submenu item not found: '+subitemName);}if(!Boolean(safe(()=>target.enabled(),true)))throw new Error('Menu item is disabled.');target.click();delay(0.08);JSON.stringify({selected:true,application:String(proc.name()),path:[menuName,itemName].concat(subitemName?[subitemName]:[])});`);
}

export async function controlMacWindow(application:string,action:string):Promise<unknown>{
  return execute(`${bootstrap(application)}proc.frontmost=true;delay(0.08);const win=proc.windows()[0];if(!win)throw new Error('No window found for '+appName);const action=${JSON.stringify(action)};if(action==='minimize')win.attributes.byName('AXMinimized').value=true;else if(action==='restore')win.attributes.byName('AXMinimized').value=false;else if(action==='maximize'){const button=win.buttons.whose({description:'full screen'})()[0]||win.buttons.whose({name:'Zoom'})()[0];if(button)button.click();else{win.position=[0,25];win.size=[1440,875];}}else if(action==='close'){const button=win.buttons.whose({roleDescription:'close button'})()[0]||win.buttons.whose({description:'close button'})()[0];if(button)button.click();else win.actions.byName('AXClose').perform();}JSON.stringify({controlled:true,application:String(proc.name()),action,frontmost:Boolean(proc.frontmost())});`);
}

export async function composeMacMail(to:string,subject:string,body:string):Promise<unknown>{
  return execute(`const mail=Application('Mail');const message=mail.OutgoingMessage({subject:${JSON.stringify(subject)},content:${JSON.stringify(`${body}\n`)},visible:true});mail.outgoingMessages.push(message);message.toRecipients.push(mail.ToRecipient({address:${JSON.stringify(to)}}));mail.activate();JSON.stringify({drafted:true,to:${JSON.stringify(to)},subject:${JSON.stringify(subject)},characters:${body.length},sent:false});`);
}

export async function createMacNote(title:string,body:string,folderName='Notes'):Promise<unknown>{
  const html=`<h1>${title.replace(/[&<>"]/g,(value)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[value]||value))}</h1><p>${body.replace(/[&<>"]/g,(value)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[value]||value)).replace(/\n/g,'<br>')}</p>`;
  return execute(`const notes=Application('Notes'),accounts=notes.accounts();if(!accounts.length)throw new Error('No Notes account is available.');const account=accounts[0],wanted=${JSON.stringify(folderName)};let folder=account.folders().find(item=>String(item.name()).toLowerCase()===wanted.toLowerCase());if(!folder)folder=account.folders()[0];if(!folder)throw new Error('No writable Notes folder is available.');const note=notes.Note({name:${JSON.stringify(title)},body:${JSON.stringify(html)}});folder.notes.push(note);notes.activate();JSON.stringify({created:true,title:${JSON.stringify(title)},folder:String(folder.name())});`);
}

export async function createMacReminder(name:string,dueAt:string,notes=''):Promise<unknown>{
  return execute(`const reminders=Application('Reminders'),lists=reminders.lists();if(!lists.length)throw new Error('No Reminders list is available.');const due=new Date(${JSON.stringify(new Date(dueAt).toISOString())}),item=reminders.Reminder({name:${JSON.stringify(name)},body:${JSON.stringify(notes)},dueDate:due});lists[0].reminders.push(item);reminders.activate();JSON.stringify({created:true,name:${JSON.stringify(name)},dueAt:due.toISOString(),list:String(lists[0].name())});`);
}

export async function createMacCalendarEvent(summary:string,start:string,end:string,notes='',calendarName=''):Promise<unknown>{
  return execute(`const calendar=Application('Calendar'),calendars=calendar.calendars(),wanted=${JSON.stringify(calendarName)};if(!calendars.length)throw new Error('No Calendar is available.');let target=wanted?calendars.find(item=>String(item.name()).toLowerCase()===wanted.toLowerCase()):calendars.find(item=>Boolean(item.writable&&item.writable()));if(!target)target=calendars[0];const startDate=new Date(${JSON.stringify(new Date(start).toISOString())}),endDate=new Date(${JSON.stringify(new Date(end).toISOString())});target.events.push(calendar.Event({summary:${JSON.stringify(summary)},startDate,endDate,description:${JSON.stringify(notes)}}));calendar.activate();JSON.stringify({created:true,summary:${JSON.stringify(summary)},start:startDate.toISOString(),end:endDate.toISOString(),calendar:String(target.name())});`);
}

export async function controlMacMedia(action:string):Promise<unknown>{
  if(action==='play_pause'||action==='next_track'||action==='previous_track')return execute(`const music=Application('Music');music.activate();const action=${JSON.stringify(action)};if(action==='play_pause')music.playpause();else if(action==='next_track')music.nextTrack();else music.previousTrack();JSON.stringify({controlled:true,action,application:'Music'});`);
  return execute(`const host=Application.currentApplication();host.includeStandardAdditions=true;const before=host.getVolumeSettings(),action=${JSON.stringify(action)};if(action==='mute')host.setVolume(null,{outputMuted:!before.outputMuted});else host.setVolume(null,{outputVolume:Math.max(0,Math.min(100,before.outputVolume+(action==='volume_up'?8:-8)))});const after=host.getVolumeSettings();JSON.stringify({controlled:true,action,outputVolume:after.outputVolume,outputMuted:after.outputMuted});`);
}
