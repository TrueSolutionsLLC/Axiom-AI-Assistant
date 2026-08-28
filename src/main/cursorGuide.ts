import { BrowserWindow, screen } from 'electron';

let guideWindow:BrowserWindow|null=null;
let guideTimer:NodeJS.Timeout|null=null;

const escapeHtml=(value:string)=>value.replace(/[&<>'"]/g,(character)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]||character));

export async function showCursorGuide(x:number,y:number,label='LOOK HERE',durationMs=5000):Promise<{shown:true;x:number;y:number;label:string;durationMs:number}>{
  const point={x:Math.round(Number.isFinite(x)?x:0),y:Math.round(Number.isFinite(y)?y:0)},display=screen.getDisplayNearestPoint(point),width=260,height=124;
  const boundedX=Math.max(display.bounds.x,Math.min(display.bounds.x+display.bounds.width-width,point.x-48)),boundedY=Math.max(display.bounds.y,Math.min(display.bounds.y+display.bounds.height-height,point.y-48));
  if(guideTimer){clearTimeout(guideTimer);guideTimer=null;}
  guideWindow?.destroy();
  guideWindow=new BrowserWindow({x:boundedX,y:boundedY,width,height,frame:false,transparent:true,resizable:false,movable:false,focusable:false,skipTaskbar:true,alwaysOnTop:true,hasShadow:false,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  guideWindow.setIgnoreMouseEvents(true,{forward:true});
  guideWindow.setAlwaysOnTop(true,'screen-saver');
  const safeLabel=escapeHtml(label.trim().slice(0,80)||'LOOK HERE'),html=`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.guide{position:absolute;left:10px;top:10px;width:76px;height:76px;border:2px solid #58fff0;border-radius:50%;filter:drop-shadow(0 0 8px #00ffe5);animation:pulse 1.15s ease-in-out infinite}.guide:before,.guide:after{content:"";position:absolute;background:#8afff4}.guide:before{left:36px;top:-11px;width:2px;height:96px}.guide:after{left:-11px;top:36px;width:96px;height:2px}.core{position:absolute;left:33px;top:33px;width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 0 12px 4px #00ffe5}.label{position:absolute;left:98px;top:31px;max-width:150px;padding:8px 11px;border:1px solid rgba(70,255,236,.7);background:rgba(0,17,21,.92);color:#bffff8;font-size:10px;letter-spacing:1.5px;white-space:nowrap;clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,0 100%)}@keyframes pulse{0%,100%{transform:scale(.88);opacity:.65}50%{transform:scale(1);opacity:1}}</style><div class="guide"><i class="core"></i></div><div class="label">${safeLabel}</div>`;
  await guideWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);guideWindow.showInactive();
  const safeDuration=Math.max(1200,Math.min(30_000,Math.round(durationMs||5000)));guideTimer=setTimeout(()=>hideCursorGuide(),safeDuration);guideTimer.unref();
  return{shown:true,x:point.x,y:point.y,label:safeLabel,durationMs:safeDuration};
}

export function hideCursorGuide():void{if(guideTimer){clearTimeout(guideTimer);guideTimer=null;}if(guideWindow&&!guideWindow.isDestroyed())guideWindow.destroy();guideWindow=null;}
