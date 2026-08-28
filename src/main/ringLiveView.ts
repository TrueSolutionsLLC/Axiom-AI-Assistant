import crypto from 'node:crypto';
import WebSocket from 'ws';
import type { RingLiveViewEvent } from '../shared/contracts';

const SIGNAL_SOCKET_URL='wss://api.prod.signalling.ring.devices.a2z.com:443/ws';
const SESSION_CREATED_TIMEOUT_MS=10_000;
const PING_INTERVAL_MS=5_000;

interface RingSession {
  doorbotId:number;
  dialogId:string;
  offerSdp:string;
  ringSessionId?:string;
  socket:WebSocket;
  pingTimer?:NodeJS.Timeout;
  sessionCreatedTimer?:NodeJS.Timeout;
  closedByUs:boolean;
}

// Ring's live view is not a single request/response — it's a WebSocket
// session (ticket → socket → offer → answer + trickled ICE both ways →
// activate → keepalive pings) that has to live as long as the view is open.
// This is the first Ring feature needing that kind of long-lived resource,
// which is why it's its own module instead of another ConnectorClient method
// (every existing one there is a stateless single fetch).
export class RingLiveViewSessions{
  private readonly sessions=new Map<string,RingSession>();

  constructor(
    private readonly getTicket:()=>Promise<string>,
    private readonly sendEvent:(event:RingLiveViewEvent)=>void,
    private readonly log:(kind:string,detail:unknown)=>void,
  ){}

  async open(cameraId:number,offerSdp:string):Promise<string>{
    const ticket=await this.getTicket();
    const liveSessionId=crypto.randomUUID(),dialogId=crypto.randomUUID(),clientId=`ring_site-${crypto.randomUUID()}`;
    const url=`${SIGNAL_SOCKET_URL}?api_version=4.0&auth_type=ring_solutions&client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(ticket)}`;
    // The standard/browser WebSocket API has no way to set request headers,
    // and Ring's servers key off this exact User-Agent the same way every
    // other Ring call in this app does — this is the one place ConnectorClient's
    // ringJson() can't be reused, since it's a socket handshake, not a fetch.
    const socket=new WebSocket(url,{headers:{'User-Agent':'android:com.ringapp'}});
    const session:RingSession={doorbotId:cameraId,dialogId,offerSdp,socket,closedByUs:false};
    this.sessions.set(liveSessionId,session);
    session.sessionCreatedTimer=setTimeout(()=>{
      this.log('ring-liveview-session-timeout',{liveSessionId});
      this.fault(liveSessionId,'Ring never confirmed the live-view session in time.');
    },SESSION_CREATED_TIMEOUT_MS);
    socket.on('open',()=>{
      socket.send(JSON.stringify({method:'live_view',dialog_id:dialogId,body:{doorbot_id:cameraId,stream_options:{audio_enabled:true,video_enabled:true},sdp:offerSdp,type:'offer'}}));
    });
    socket.on('message',(raw)=>{
      let message:{method?:string;body?:Record<string,unknown>};
      try{message=JSON.parse(raw.toString());}catch{this.log('ring-liveview-bad-message',{liveSessionId,raw:raw.toString().slice(0,300)});return;}
      this.handleMessage(liveSessionId,message);
    });
    socket.on('error',(error)=>{
      this.log('ring-liveview-socket-error',{liveSessionId,message:error.message});
      // Ring's server sometimes sends a close frame with an invalid status
      // code (a spec violation the ws library treats as a protocol error,
      // not a clean close) — seen even for a session we ourselves just
      // asked to close. Reads `session` directly (the closure variable
      // captured above), not a fresh map lookup — by the time this fires,
      // a 'close' event may have already deleted the map entry, but the
      // session object itself (and its closedByUs flag) still exists.
      if(session.closedByUs)return;
      this.fault(liveSessionId,`Ring live-view connection error: ${error.message}`);
    });
    socket.on('close',(code,reasonBuffer)=>{
      const current=this.sessions.get(liveSessionId);
      this.cleanupTimers(liveSessionId);
      this.sessions.delete(liveSessionId);
      if(!current)return;
      if(current.closedByUs){this.sendEvent({type:'closed',liveSessionId});return;}
      const reasonText=reasonBuffer.toString()||`code ${code}`;
      this.log('ring-liveview-socket-closed',{liveSessionId,code,reason:reasonText});
      this.sendEvent({type:'fault',liveSessionId,reason:`Ring closed the live-view connection (${reasonText}).`});
    });
    return liveSessionId;
  }

  private handleMessage(liveSessionId:string,message:{method?:string;body?:Record<string,unknown>}):void{
    const session=this.sessions.get(liveSessionId);if(!session)return;
    const body=message.body||{};
    switch(message.method){
      case'session_created':{
        session.ringSessionId=String(body.session_id||'');
        clearTimeout(session.sessionCreatedTimer);session.sessionCreatedTimer=undefined;
        session.pingTimer=setInterval(()=>this.send(liveSessionId,'ping',{}),PING_INTERVAL_MS);
        break;
      }
      case'sdp':{
        const answer=String(body.sdp||'');
        if(!answer){this.fault(liveSessionId,'Ring sent an empty SDP answer.');break;}
        this.sendEvent({type:'answer',liveSessionId,sdp:forceCorrectSdpAnswer(session.offerSdp,answer)});
        this.send(liveSessionId,'activate_session',{});
        break;
      }
      case'ice':{
        const candidate=String(body.ice||''),mlineindex=Number(body.mlineindex);
        if(candidate)this.sendEvent({type:'ice',liveSessionId,candidate,sdpMLineIndex:Number.isFinite(mlineindex)?mlineindex:0});
        break;
      }
      case'notification':{
        if(body.text==='camera_connected')this.send(liveSessionId,'camera_options',{stealth_mode:false});
        break;
      }
      case'close':{
        const reason=body.reason as {code?:string;text?:string}|undefined;
        this.fault(liveSessionId,`Ring ended the session${reason?.text?`: ${reason.text}`:''}.`);
        break;
      }
      case'pong':break;
      case'camera_started':break;
      default:this.log('ring-liveview-unknown-message',{liveSessionId,method:message.method});
    }
  }

  sendIce(liveSessionId:string,candidate:string,sdpMLineIndex:number):void{
    this.send(liveSessionId,'ice',{ice:candidate,mlineindex:sdpMLineIndex});
  }

  close(liveSessionId:string):void{
    const session=this.sessions.get(liveSessionId);if(!session)return;
    session.closedByUs=true;
    this.cleanupTimers(liveSessionId);
    try{session.socket.close();}catch{/* already closing/closed */}
  }

  closeAll():void{for(const liveSessionId of[...this.sessions.keys()])this.close(liveSessionId);}

  private send(liveSessionId:string,method:string,extra:Record<string,unknown>):void{
    const session=this.sessions.get(liveSessionId);if(!session||session.socket.readyState!==WebSocket.OPEN)return;
    session.socket.send(JSON.stringify({method,dialog_id:session.dialogId,body:{doorbot_id:session.doorbotId,session_id:session.ringSessionId,...extra}}));
  }

  private fault(liveSessionId:string,reason:string):void{
    const session=this.sessions.get(liveSessionId);
    this.sendEvent({type:'fault',liveSessionId,reason});
    if(session){session.closedByUs=true;this.cleanupTimers(liveSessionId);try{session.socket.close();}catch{/* already closing/closed */}this.sessions.delete(liveSessionId);}
  }

  private cleanupTimers(liveSessionId:string):void{
    const session=this.sessions.get(liveSessionId);if(!session)return;
    if(session.pingTimer)clearInterval(session.pingTimer);
    if(session.sessionCreatedTimer)clearTimeout(session.sessionCreatedTimer);
  }
}

// Ring's real server has a known spec violation: answering a `recvonly`
// offer m-line with `sendrecv` instead of `sendonly`/`inactive` (RFC 3264).
// Modern strict WebRTC stacks (including current Chromium) reject that
// answer outright, so it has to be corrected before setRemoteDescription
// ever sees it. Only touches sections where the offer was recvonly and the
// answer disagrees — every other line, including sections that already
// match, passes through untouched.
export function forceCorrectSdpAnswer(offerSdp:string,answerSdp:string):string{
  if(!offerSdp||!answerSdp)return answerSdp;
  const kinds='audio|video|application',directions='sendrecv|sendonly|recvonly|inactive';
  const pattern=new RegExp(`m=(${kinds})(?:.|\\n|\\r)*?a=(${directions})\\r?\\n`,'g');
  const offerSections:Array<{kind:string;direction:string}>=[];
  for(const match of offerSdp.matchAll(pattern))offerSections.push({kind:match[1],direction:match[2]});
  let index=0,patched=answerSdp;
  patched=patched.replace(pattern,(full,kind,direction)=>{
    const offerSection=offerSections[index];index+=1;
    if(offerSection&&offerSection.kind===kind&&offerSection.direction==='recvonly'&&direction==='sendrecv')return full.replace(/a=sendrecv(\r?\n)/,'a=sendonly$1');
    return full;
  });
  return patched;
}
