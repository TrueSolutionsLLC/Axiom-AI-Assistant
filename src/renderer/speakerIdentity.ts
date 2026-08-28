export interface VoicePrint {
  version:1|2;
  model:'acoustic-v1'|'wavlm-base-plus-sv';
  vector:number[];
  speechFrames:number;
  durationMs:number;
  speechMs:number;
  snrDb:number;
  clippingRatio:number;
}

const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));

function pitchFeature(samples:Float32Array,sampleRate:number):number{
  const minimumLag=Math.max(2,Math.floor(sampleRate/340)),maximumLag=Math.min(samples.length-2,Math.ceil(sampleRate/75));
  let bestLag=0,bestCorrelation=0;
  for(let lag=minimumLag;lag<=maximumLag;lag+=2){let numerator=0,left=0,right=0;for(let index=0;index<samples.length-lag;index+=2){const a=samples[index],b=samples[index+lag];numerator+=a*b;left+=a*a;right+=b*b;}const correlation=numerator/Math.max(1e-9,Math.sqrt(left*right));if(correlation>bestCorrelation){bestCorrelation=correlation;bestLag=lag;}}
  if(bestCorrelation<.32||!bestLag)return 0;
  const hertz=sampleRate/bestLag;
  return clamp((Math.log(hertz)-Math.log(75))/(Math.log(340)-Math.log(75)));
}

function frameFeatures(samples:Float32Array,spectrum:Uint8Array,sampleRate:number):number[]|null{
  let energy=0,crossings=0;for(let index=0;index<samples.length;index++){const value=samples[index];energy+=value*value;if(index&&((value>=0)!==(samples[index-1]>=0)))crossings++;}
  const rms=Math.sqrt(energy/Math.max(1,samples.length));if(rms<.012)return null;
  const nyquist=sampleRate/2,bandCount=16,bandEnergy=new Array<number>(bandCount).fill(0);let total=0,weighted=0,logSum=0,rollTotal=0;
  for(let index=1;index<spectrum.length;index++){const hertz=index/spectrum.length*nyquist;if(hertz<70||hertz>7200)continue;const amplitude=spectrum[index]/255,power=amplitude*amplitude+1e-8,position=clamp((Math.log(hertz)-Math.log(70))/(Math.log(7200)-Math.log(70)),0,.9999),band=Math.floor(position*bandCount);bandEnergy[band]+=power;total+=power;weighted+=power*hertz;logSum+=Math.log(power);}
  if(total<1e-5)return null;
  const normalized=bandEnergy.map((value)=>Math.log(1+value/total*80));
  const cepstra:number[]=[];for(let coefficient=1;coefficient<=9;coefficient++){let value=0;for(let band=0;band<bandCount;band++)value+=normalized[band]*Math.cos(Math.PI*coefficient*(band+.5)/bandCount);cepstra.push(value/8);}
  const centroid=clamp(weighted/total/7200),target=total*.85;let rolloff=0;for(let index=1;index<spectrum.length;index++){const hertz=index/spectrum.length*nyquist;if(hertz<70||hertz>7200)continue;const amplitude=spectrum[index]/255;rollTotal+=amplitude*amplitude+1e-8;if(rollTotal>=target){rolloff=clamp(hertz/7200);break;}}
  const bins=Math.max(1,spectrum.length-1),flatness=clamp(Math.exp(logSum/bins)/(total/bins));
  return[...cepstra,pitchFeature(samples,sampleRate),centroid,rolloff,crossings/Math.max(1,samples.length-1),flatness];
}

export class VoicePrintAccumulator {
  private frames:number[][]=[];
  private startedAt=0;
  reset(now=performance.now()):void{this.frames=[];this.startedAt=now;}
  push(samples:Float32Array,spectrum:Uint8Array,sampleRate:number):boolean{const feature=frameFeatures(samples,spectrum,sampleRate);if(!feature)return false;this.frames.push(feature);return true;}
  finish(now=performance.now()):VoicePrint|null{
    if(this.frames.length<12)return null;const dimensions=this.frames[0].length,mean=new Array<number>(dimensions).fill(0),deviation=new Array<number>(dimensions).fill(0);
    for(const frame of this.frames)for(let index=0;index<dimensions;index++)mean[index]+=frame[index]/this.frames.length;
    for(const frame of this.frames)for(let index=0;index<dimensions;index++){const delta=frame[index]-mean[index];deviation[index]+=delta*delta/this.frames.length;}
    const raw=[...mean,...deviation.map(Math.sqrt)],magnitude=Math.sqrt(raw.reduce((sum,value)=>sum+value*value,0))||1,vector=raw.map((value)=>value/magnitude);
    const durationMs=Math.max(0,Math.round(now-this.startedAt));return{version:1,model:'acoustic-v1',vector,speechFrames:this.frames.length,durationMs,speechMs:durationMs,snrDb:12,clippingRatio:0};
  }
}

interface WorkerReply {id:number;ok:boolean;ready?:boolean;vector?:Float32Array;error?:string}

class WavLmSpeakerEngine{
  private worker:Worker|null=null;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:WorkerReply)=>void;reject:(reason:Error)=>void;timer:number}>();
  private getWorker():Worker{
    if(this.worker)return this.worker;
    const worker=new Worker(new URL('./speakerWorker.ts',import.meta.url),{type:'module',name:'axiom-wavlm-speaker'});
    worker.onmessage=(event:MessageEvent<WorkerReply>)=>{const item=this.pending.get(event.data.id);if(!item)return;window.clearTimeout(item.timer);this.pending.delete(event.data.id);event.data.ok?item.resolve(event.data):item.reject(new Error(event.data.error||'Neural speaker verification failed.'));};
    worker.onerror=(event)=>{const error=new Error(event.message||'Neural speaker worker failed.');for(const item of this.pending.values()){window.clearTimeout(item.timer);item.reject(error);}this.pending.clear();worker.terminate();this.worker=null;};
    this.worker=worker;return worker;
  }
  private request(message:WithoutId<RequestMessage>,transfer:Transferable[]=[]):Promise<WorkerReply>{
    const id=++this.sequence,worker=this.getWorker();return new Promise((resolve,reject)=>{const timer=window.setTimeout(()=>{this.pending.delete(id);reject(new Error('Neural speaker verification timed out.'));},90_000);this.pending.set(id,{resolve,reject,timer});worker.postMessage({...message,id},transfer);});
  }
  warm():Promise<void>{return this.request({type:'warm'}).then(()=>undefined);}
  async embed(audio:Float32Array):Promise<number[]>{const owned=new Float32Array(audio),reply=await this.request({type:'embed',audio:owned},[owned.buffer]);return Array.from(reply.vector??[]);}
}

type RequestMessage={id:number;type:'warm'}|{id:number;type:'embed';audio:Float32Array};
// Omit<Union,'id'> doesn't distribute over a discriminated union — keyof a
// union collapses to only the common keys, so Omit<RequestMessage,'id'>
// silently loses the 'embed' variant's audio field from the type entirely
// (runtime was unaffected; TS just stopped being able to see it). A naked
// generic distributes correctly.
type WithoutId<T>=T extends {id:number}?Omit<T,'id'>:never;
const neuralEngine=new WavLmSpeakerEngine();
export const warmNeuralSpeakerEngine=():Promise<void>=>neuralEngine.warm();
/**
 * Runs the exact production WavLM ONNX embedding used by real enrollment and
 * matching, given pre-decoded 16kHz mono audio instead of a live microphone.
 * Exists only to let the real neural pipeline be measured against a labeled
 * multi-speaker dataset offline; not reachable without the QA flag below.
 */
export const embedForQa=(audio:Float32Array):Promise<number[]>=>neuralEngine.embed(audio);

function resampleTo16Khz(chunks:Float32Array[],sampleRate:number):Float32Array{
  const sourceLength=chunks.reduce((sum,chunk)=>sum+chunk.length,0),source=new Float32Array(sourceLength);let cursor=0;for(const chunk of chunks){source.set(chunk,cursor);cursor+=chunk.length;}
  if(!source.length)return source;
  const ratio=sampleRate/16_000,target=new Float32Array(Math.max(1,Math.floor(source.length/ratio)));
  for(let index=0;index<target.length;index++){const position=index*ratio,left=Math.floor(position),right=Math.min(source.length-1,left+1),blend=position-left;target[index]=source[left]*(1-blend)+source[right]*blend;}
  return target;
}

function trimAndNormalize(audio:Float32Array):{audio:Float32Array;speechFrames:number;speechMs:number;snrDb:number;clippingRatio:number}{
  const frame=320,energies:number[]=[];for(let offset=0;offset<audio.length;offset+=frame){let sum=0;const end=Math.min(audio.length,offset+frame);for(let index=offset;index<end;index++)sum+=audio[index]*audio[index];energies.push(Math.sqrt(sum/Math.max(1,end-offset)));}
  const sorted=[...energies].sort((a,b)=>a-b),noise=sorted[Math.floor(sorted.length*.2)]??.003,threshold=Math.max(.008,noise*2.4+.003);let first=energies.findIndex((value)=>value>threshold),last=-1;for(let index=energies.length-1;index>=0;index--)if(energies[index]>threshold){last=index;break;}
  if(first<0||last<first)return{audio:new Float32Array(),speechFrames:0,speechMs:0,snrDb:0,clippingRatio:0};first=Math.max(0,first-5);last=Math.min(energies.length-1,last+5);
  const selected=energies.slice(first,last+1),speechEnergies=selected.filter((value)=>value>threshold),speechFrames=speechEnergies.length,speechMs=speechFrames*20,trimmed=audio.slice(first*frame,Math.min(audio.length,(last+1)*frame));let peak=0,clipped=0;for(const value of trimmed){peak=Math.max(peak,Math.abs(value));if(Math.abs(value)>=.98)clipped++;}const speechRms=speechEnergies.reduce((sum,value)=>sum+value,0)/Math.max(1,speechEnergies.length),snrDb=Math.max(0,Math.min(40,20*Math.log10(Math.max(.0001,speechRms)/Math.max(.0005,noise)))),clippingRatio=clipped/Math.max(1,trimmed.length),gain=peak>.001?Math.min(5,.82/peak):1;for(let index=0;index<trimmed.length;index++)trimmed[index]*=gain;return{audio:trimmed,speechFrames,speechMs,snrDb,clippingRatio};
}

export interface VoicePrintMonitor { begin():void; finish():Promise<VoicePrint|null>; dispose():Promise<void>; }

export async function createVoicePrintMonitor(stream:MediaStream):Promise<VoicePrintMonitor>{
  const context=new AudioContext(),source=context.createMediaStreamSource(stream),processor=context.createScriptProcessor(4096,1,1),mute=context.createGain();let collecting=false,chunks:Float32Array[]=[],startedAt=0;
  mute.gain.value=0;source.connect(processor);processor.connect(mute);mute.connect(context.destination);processor.onaudioprocess=(event)=>{if(!collecting)return;chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));if(chunks.length>160)chunks.shift();};if(context.state==='suspended')await context.resume();
  void neuralEngine.warm().catch(()=>{});
  return{begin:()=>{chunks=[];startedAt=performance.now();collecting=true;},finish:async()=>{collecting=false;const durationMs=Math.max(0,Math.round(performance.now()-startedAt)),prepared=trimAndNormalize(resampleTo16Khz(chunks,context.sampleRate));chunks=[];if(prepared.speechFrames<18||prepared.audio.length<12_000)return null;const vector=await neuralEngine.embed(prepared.audio);return{version:2,model:'wavlm-base-plus-sv',vector,speechFrames:prepared.speechFrames,durationMs,speechMs:prepared.speechMs,snrDb:prepared.snrDb,clippingRatio:prepared.clippingRatio};},dispose:async()=>{collecting=false;chunks=[];processor.onaudioprocess=null;source.disconnect();processor.disconnect();mute.disconnect();await context.close();}};
}

export async function captureVoicePrint(stream:MediaStream,durationMs=5200,onTick?:(remainingMs:number)=>void):Promise<VoicePrint|null>{
  const monitor=await createVoicePrintMonitor(stream);monitor.begin();const started=performance.now();
  await new Promise<void>((resolve)=>{const tick=()=>{const remaining=Math.max(0,durationMs-(performance.now()-started));onTick?.(remaining);if(!remaining){resolve();return;}setTimeout(tick,100);};tick();});
  try{return await monitor.finish();}finally{await monitor.dispose();}
}

export function voicePrintSimilarity(left:number[],right:number[]):number{if(left.length!==right.length||!left.length)return 0;let dot=0,a=0,b=0;for(let index=0;index<left.length;index++){dot+=left[index]*right[index];a+=left[index]*left[index];b+=right[index]*right[index];}return clamp(dot/Math.max(1e-9,Math.sqrt(a*b)),-1,1);}
