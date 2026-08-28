import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnownPerson } from '../shared/contracts';
import { resolvePresenceIdentity, type FaceObservation, type PresenceIdentityDecision } from './presenceIdentity';
import { ENROLLMENT_POSES, validateEnrollmentSamples, SAMPLES_PER_POSE, POSE_TIMEOUT_MS, type EnrollmentPoseId, type EnrollmentValidation } from './faceEnrollmentGuide';

export type EnrollmentStepStatus = 'waiting' | 'capturing' | 'done' | 'skipped';
export interface EnrollmentProgress {
  poseId: EnrollmentPoseId;
  label: string;
  instruction: string;
  status: EnrollmentStepStatus;
  poseIndex: number;
  poseCount: number;
  capturedInPose: number;
  samplesNeeded: number;
}

interface FaceApiDetection { descriptor:Float32Array; detection:{score:number;box:{width:number;height:number}} }
interface FaceApi {
  nets:{tinyFaceDetector:{loadFromUri(path:string):Promise<void>};faceLandmark68Net:{loadFromUri(path:string):Promise<void>};faceRecognitionNet:{loadFromUri(path:string):Promise<void>}};
  TinyFaceDetectorOptions:new(options:Record<string,number>)=>unknown;
  detectAllFaces(video:HTMLVideoElement,options:unknown):{withFaceLandmarks():{withFaceDescriptors():Promise<FaceApiDetection[]>}};
}

declare global { interface Window { faceapi?:FaceApi; __axiomFaceApiReady?:Promise<FaceApi> } }

function distance(a:number[],b:number[]):number{let sum=0;for(let index=0;index<Math.min(a.length,b.length);index++){const delta=a[index]-b[index];sum+=delta*delta;}return Math.sqrt(sum);}
const vectorsFor=(person:KnownPerson):number[][]=>person.descriptors?.length?person.descriptors:[person.descriptor];
const delay=(milliseconds:number)=>new Promise((resolve)=>window.setTimeout(resolve,milliseconds));

export function usePersonRecognition(getVideo:()=>HTMLVideoElement|null,active:boolean){
  const [people,setPeople]=useState<KnownPerson[]>([]),[observation,setObservation]=useState<FaceObservation|null>(null),[observations,setObservations]=useState<FaceObservation[]>([]),[state,setState]=useState<'idle'|'loading'|'ready'|'error'>('idle');
  const loadRef=useRef<Promise<FaceApi>|null>(null),detecting=useRef(false),lastSeenReport=useRef(new Map<string,number>());
  const ensure=useCallback(async()=>{
    if(window.__axiomFaceApiReady)return window.__axiomFaceApiReady;
    if(!loadRef.current){const runtime=window.faceapi?Promise.resolve(window.faceapi):new Promise<FaceApi>((resolve,reject)=>{const script=document.createElement('script');script.src='/face-api.min.js';script.onload=()=>window.faceapi?resolve(window.faceapi):reject(new Error('Face recognition runtime did not initialize.'));script.onerror=()=>reject(new Error('Local face recognition runtime could not load.'));document.head.appendChild(script);});loadRef.current=runtime.then(async(api)=>{const root='/face-models';await Promise.all([api.nets.tinyFaceDetector.loadFromUri(root),api.nets.faceLandmark68Net.loadFromUri(root),api.nets.faceRecognitionNet.loadFromUri(root)]);return api;});window.__axiomFaceApiReady=loadRef.current;}
    return loadRef.current;
  },[]);
  const recognizeAll=useCallback(async():Promise<FaceObservation[]>=>{
    const video=getVideo();if(!active||!video||video.readyState<HTMLMediaElement.HAVE_CURRENT_DATA)return[];
    for(let wait=0;detecting.current&&wait<8;wait++)await delay(45);
    if(detecting.current)return[];
    detecting.current=true;try{
      setState((value)=>value==='ready'?'ready':'loading');
      const api=await ensure(),results=await api.detectAllFaces(video,new api.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:.34})).withFaceLandmarks().withFaceDescriptors();
      if(!results.length){setObservation(null);setObservations([]);setState('ready');return[];}
      const now=new Date().toISOString(),next=results.sort((a,b)=>b.detection.box.width*b.detection.box.height-a.detection.box.width*a.detection.box.height).map((result)=>{
        const descriptor=Array.from(result.descriptor),matches=people.flatMap((person)=>vectorsFor(person).map((known)=>({person,distance:distance(descriptor,known)}))).sort((a,b)=>a.distance-b.distance),match=matches[0]?.distance<.54?matches[0]:undefined;
        if(match&&Date.now()-(lastSeenReport.current.get(match.person.id)||0)>60_000){lastSeenReport.current.set(match.person.id,Date.now());void window.axiom.markKnownPersonSeen(match.person.id).catch(()=>{});}
        return{name:match?.person.name||'Unknown person',confidence:match?Math.max(0,1-match.distance/.54):result.detection.score,descriptor,unknown:!match,observedAt:now};
      });
      setObservations(next);setObservation(next.find((item)=>!item.unknown)??next[0]??null);setState('ready');return next;
    }catch{setState('error');return[];}finally{detecting.current=false;}
  },[active,ensure,getVideo,people]);
  const recognize=useCallback(async()=>{const found=await recognizeAll();return found.find((item)=>!item.unknown)??found[0]??null;},[recognizeAll]);
  const classifyPresence=useCallback(async(samples=6,intervalMs=300):Promise<PresenceIdentityDecision>=>{
    const frames:FaceObservation[][]=[];
    for(let sample=0;sample<samples;sample++){frames.push(await recognizeAll());if(sample<samples-1)await delay(intervalMs);}
    return resolvePresenceIdentity(frames);
  },[recognizeAll]);
  /**
   * Guided multi-angle enrollment (see faceEnrollmentGuide.ts): walks the user
   * through center/left/right/up/down poses using live yaw/pitch from the same
   * tracker liveness already relies on, instead of grabbing several near-
   * identical frontal frames in under two seconds.
   */
  /**
   * Runs the guided capture but does NOT save anything — the caller reviews
   * the result (which poses were actually captured) and decides whether to
   * commitEnrollment or discard and retry. Nothing is written to disk from a
   * capture the user never confirmed.
   */
  const captureEnrollment=useCallback(async(getPose:()=>{yaw:number;pitch:number},onProgress?:(progress:EnrollmentProgress)=>void,isCanceled?:()=>boolean):Promise<{groups:Partial<Record<EnrollmentPoseId,number[][]>>;validation:EnrollmentValidation}>=>{
    const groups:Partial<Record<EnrollmentPoseId,number[][]>>={};
    for(let poseIndex=0;poseIndex<ENROLLMENT_POSES.length;poseIndex+=1){
      if(isCanceled?.())break;
      const target=ENROLLMENT_POSES[poseIndex],samples:number[][]=[];
      const report=(status:EnrollmentStepStatus)=>onProgress?.({poseId:target.id,label:target.label,instruction:target.instruction,status,poseIndex,poseCount:ENROLLMENT_POSES.length,capturedInPose:samples.length,samplesNeeded:SAMPLES_PER_POSE});
      report('waiting');
      const deadline=Date.now()+POSE_TIMEOUT_MS;
      while(samples.length<SAMPLES_PER_POSE&&Date.now()<deadline){
        if(isCanceled?.())break;
        const{yaw,pitch}=getPose();
        if(!target.matches(yaw,pitch)){await delay(120);continue;}
        const faces=await recognizeAll();
        if(faces.length>1)throw new Error('More than one face is visible. Only one person should remain in frame during enrollment.');
        if(faces[0]?.descriptor.length===128){samples.push(faces[0].descriptor);report('capturing');}
        await delay(180);
      }
      groups[target.id]=samples;
      report(samples.length?'done':'skipped');
    }
    return{groups,validation:validateEnrollmentSamples(groups)};
  },[recognizeAll]);

  /** Writes a previously captured (and user-confirmed) enrollment to disk. */
  const commitEnrollment=useCallback(async(name:string,groups:Partial<Record<EnrollmentPoseId,number[][]>>)=>{
    const allSamples=Object.values(groups).flat() as number[][];
    let saved:KnownPerson|undefined;for(const descriptor of allSamples)saved=await window.axiom.saveKnownPerson(name,descriptor);
    const roster=await window.axiom.listKnownPeople();setPeople(roster);
    const centroid=Array.from({length:128},(_,index)=>allSamples.reduce((sum,sample)=>sum+sample[index],0)/allSamples.length);
    setObservation({name:saved!.name,descriptor:centroid,unknown:false,confidence:1,observedAt:new Date().toISOString()});
    return saved!;
  },[]);
  const forget=useCallback(async(id:string)=>setPeople(await window.axiom.forgetKnownPerson(id)),[]);
  useEffect(()=>{void window.axiom.listKnownPeople().then(setPeople);},[]);
  useEffect(()=>{if(!active)return;void recognizeAll();const timer=window.setInterval(()=>void recognizeAll(),1900);return()=>window.clearInterval(timer);},[active,recognizeAll]);
  return{people,observation,observations,state,recognize,recognizeAll,classifyPresence,captureEnrollment,commitEnrollment,forget};
}
