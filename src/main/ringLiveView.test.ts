import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import type { RingLiveViewEvent } from '../shared/contracts';
import { forceCorrectSdpAnswer, RingLiveViewSessions } from './ringLiveView';

// `ws` is the one real dependency this module needs (the standard/browser
// WebSocket API has no way to set the User-Agent header Ring's server keys
// off), so it's faked here rather than opening a real socket — this tests
// the session lifecycle and message dispatch, not the real network. The
// fake class has to live inside the vi.mock factory itself (mock factories
// are hoisted above the rest of the file, including above regular imports —
// `class X extends EventEmitter` evaluates `EventEmitter` immediately at
// class-declaration time, so it has to come from a dynamic import inside
// the (async) factory rather than a normal top-level import, or it hits
// EventEmitter's own import binding before it's initialized); createdSockets
// is how tests get a handle on the instance a given open() call constructed.
let createdSockets:FakeSocket[]=[];
interface FakeSocket{url:string;options?:{headers?:Record<string,string>};sent:Array<Record<string,unknown>>;readyState:number;open():void;close():void;receive(message:Record<string,unknown>):void;emit(event:string,...args:unknown[]):boolean;}

vi.mock('ws',async()=>{
  const{EventEmitter}=await import('node:events');
  class FakeWebSocket extends EventEmitter{
    static OPEN=1;static CONNECTING=0;static CLOSING=2;static CLOSED=3;
    readyState=FakeWebSocket.CONNECTING;
    sent:Array<Record<string,unknown>>=[];
    url:string;options?:{headers?:Record<string,string>};
    constructor(url:string,options?:{headers?:Record<string,string>}){super();this.url=url;this.options=options;createdSockets.push(this as unknown as FakeSocket);}
    send(data:string){this.sent.push(JSON.parse(data));}
    close(){if(this.readyState===FakeWebSocket.CLOSED)return;this.readyState=FakeWebSocket.CLOSED;this.emit('close',1000,Buffer.from(''));}
    open(){this.readyState=FakeWebSocket.OPEN;this.emit('open');}
    receive(message:Record<string,unknown>){this.emit('message',Buffer.from(JSON.stringify(message)));}
  }
  return{default:FakeWebSocket};
});

describe('forceCorrectSdpAnswer',()=>{
  const offer=[
    'v=0','o=- 1 1 IN IP4 0.0.0.0','s=-',
    'm=video 9 UDP/TLS/RTP/SAVPF 96','a=recvonly',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111','a=recvonly',
  ].join('\r\n')+'\r\n';

  it('patches a sendrecv answer to sendonly where the offer was recvonly',()=>{
    const answer=[
      'v=0','o=- 2 2 IN IP4 0.0.0.0','s=-',
      'm=video 9 UDP/TLS/RTP/SAVPF 96','a=sendrecv',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111','a=sendrecv',
    ].join('\r\n')+'\r\n';
    const patched=forceCorrectSdpAnswer(offer,answer);
    expect(patched).toContain('a=sendonly');
    expect(patched).not.toContain('a=sendrecv');
  });

  it('leaves an already-correct answer untouched',()=>{
    const answer=[
      'v=0','o=- 2 2 IN IP4 0.0.0.0','s=-',
      'm=video 9 UDP/TLS/RTP/SAVPF 96','a=sendonly',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111','a=inactive',
    ].join('\r\n')+'\r\n';
    expect(forceCorrectSdpAnswer(offer,answer)).toBe(answer);
  });

  it('only patches the mismatched section when just one m-line disagrees',()=>{
    const answer=[
      'v=0','o=- 2 2 IN IP4 0.0.0.0','s=-',
      'm=video 9 UDP/TLS/RTP/SAVPF 96','a=sendonly',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111','a=sendrecv',
    ].join('\r\n')+'\r\n';
    const patched=forceCorrectSdpAnswer(offer,answer);
    const lines=patched.split('\r\n');
    expect(lines.filter((line)=>line==='a=sendonly')).toHaveLength(2);
    expect(patched).not.toContain('a=sendrecv');
  });
});

describe('RingLiveViewSessions',()=>{
  beforeEach(()=>{vi.useFakeTimers();createdSockets=[];});
  afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

  const setup=()=>{
    const events:RingLiveViewEvent[]=[],logs:Array<{kind:string;detail:unknown}>=[];
    const sessions=new RingLiveViewSessions(
      async()=>'signal-ticket-1',
      (event)=>events.push(event),
      (kind,detail)=>logs.push({kind,detail}),
    );
    return{sessions,events,logs};
  };

  it('sends the live_view offer once the socket opens, with the User-Agent header Ring requires',async()=>{
    const{sessions}=setup();
    const liveSessionId=await sessions.open(111,'v=0 offer-sdp');
    const socket=createdSockets[0];
    expect(socket.options?.headers?.['User-Agent']).toBe('android:com.ringapp');
    expect(socket.url).toContain('token=signal-ticket-1');
    socket.open();
    expect(socket.sent).toEqual([{method:'live_view',dialog_id:expect.any(String),body:{doorbot_id:111,stream_options:{audio_enabled:true,video_enabled:true},sdp:'v=0 offer-sdp',type:'offer'}}]);
    expect(liveSessionId).toBeTruthy();
  });

  it('starts a 5s ping loop only once session_created arrives, and stops it on close',async()=>{
    const{sessions}=setup();
    const liveSessionId=await sessions.open(111,'v=0 offer-sdp');
    const socket=createdSockets[0];
    socket.open();
    expect(socket.sent.filter((message)=>message.method==='ping')).toHaveLength(0);
    socket.receive({method:'session_created',body:{session_id:'ring-session-1'}});
    vi.advanceTimersByTime(12_000);
    expect(socket.sent.filter((message)=>message.method==='ping')).toHaveLength(2);
    sessions.close(liveSessionId);
    vi.advanceTimersByTime(20_000);
    expect(socket.sent.filter((message)=>message.method==='ping')).toHaveLength(2);
  });

  it('patches and forwards the SDP answer, then sends activate_session',async()=>{
    const{sessions,events}=setup();
    const liveSessionId=await sessions.open(111,'m=video 9 x\r\na=recvonly\r\n');
    const socket=createdSockets[0];
    socket.open();
    socket.receive({method:'session_created',body:{session_id:'ring-session-1'}});
    socket.receive({method:'sdp',body:{sdp:'m=video 9 x\r\na=sendrecv\r\n'}});
    const answerEvent=events.find((event)=>event.type==='answer');
    expect(answerEvent).toMatchObject({liveSessionId,sdp:'m=video 9 x\r\na=sendonly\r\n'});
    expect(socket.sent.some((message)=>message.method==='activate_session')).toBe(true);
  });

  it('forwards trickled ICE candidates from Ring',async()=>{
    const{sessions,events}=setup();
    const liveSessionId=await sessions.open(111,'v=0 offer-sdp');
    const socket=createdSockets[0];
    socket.open();
    socket.receive({method:'ice',body:{ice:'candidate:1 1 UDP 1 1.2.3.4 5000 typ host',mlineindex:0}});
    expect(events).toContainEqual({type:'ice',liveSessionId,candidate:'candidate:1 1 UDP 1 1.2.3.4 5000 typ host',sdpMLineIndex:0});
  });

  it('replies to a camera_connected notification with camera_options',async()=>{
    const{sessions}=setup();
    await sessions.open(111,'v=0 offer-sdp');
    const socket=createdSockets[0];
    socket.open();
    socket.receive({method:'notification',body:{text:'camera_connected'}});
    expect(socket.sent).toContainEqual({method:'camera_options',dialog_id:expect.any(String),body:{doorbot_id:111,session_id:undefined,stealth_mode:false}});
  });

  it('closeAll empties every session and stops their timers',async()=>{
    const{sessions}=setup();
    const idA=await sessions.open(111,'a'),idB=await sessions.open(222,'b');
    sessions.closeAll();
    expect(idA).not.toBe(idB);
    expect(()=>sessions.sendIce(idA,'candidate',0)).not.toThrow();
  });

  it('sendIce on a missing/closed session no-ops instead of throwing',()=>{
    const{sessions}=setup();
    expect(()=>sessions.sendIce('does-not-exist','candidate',0)).not.toThrow();
  });

  // A real live test showed Ring's server sending a malformed close frame
  // ("invalid status code 65535") even for a session Axiom itself asked to
  // close — the ws library reports that as a socket error, not a clean
  // close. That must not surface as a fault the user sees after they
  // already closed the view.
  it('does not push a fault for a socket error on a session we already asked to close',async()=>{
    const{sessions,events}=setup();
    const liveSessionId=await sessions.open(111,'v=0 offer-sdp');
    const socket=createdSockets[0];
    socket.open();
    sessions.close(liveSessionId);
    socket.emit('error',new Error('Invalid WebSocket frame: invalid status code 65535'));
    expect(events.some((event)=>event.type==='fault')).toBe(false);
  });

  it('gives up and pushes a fault if session_created never arrives within 10s',async()=>{
    const{sessions,events}=setup();
    await sessions.open(111,'v=0 offer-sdp');
    const socket=createdSockets[0];
    socket.open();
    vi.advanceTimersByTime(10_000);
    expect(events).toContainEqual(expect.objectContaining({type:'fault'}));
    expect(socket.readyState).toBe(3);
  });

  it('pushes a fault event, not a closed event, when Ring drops the socket unexpectedly',async()=>{
    const{sessions,events}=setup();
    const liveSessionId=await sessions.open(111,'v=0 offer-sdp');
    const socket=createdSockets[0];
    socket.open();
    socket.emit('close',1006,Buffer.from('abnormal closure'));
    expect(events).toContainEqual({type:'fault',liveSessionId,reason:expect.stringContaining('abnormal closure')});
  });
});
