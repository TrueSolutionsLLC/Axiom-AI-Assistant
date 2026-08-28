import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BackgroundEvent, MediaArtifact } from '../shared/contracts';
import type { AppStore } from './store';

type ImageQuality='low'|'medium'|'high';
type ImageSize='1024x1024'|'1024x1536'|'1536x1024';
type VideoSize='720x1280'|'1280x720'|'1024x1792'|'1792x1024';

export class MediaService {
  constructor(private readonly store:AppStore){}
  list():MediaArtifact[]{return this.store.mediaArtifacts();}

  async generateImage(prompt:string,quality:ImageQuality='medium',size:ImageSize='1024x1024'):Promise<MediaArtifact>{
    const clean=prompt.trim().slice(0,32_000);if(!clean)throw new Error('Image prompt is empty.');const key=this.store.openAIKey();if(!key)throw new Error('OpenAI is required for image generation.');
    const now=new Date().toISOString(),artifact:MediaArtifact={id:crypto.randomUUID(),kind:'image',provider:'openai',model:'gpt-image-2',prompt:clean,status:'in_progress',createdAt:now,updatedAt:now,size,estimatedCostUsd:imageEstimate(quality,size)};this.store.saveMediaArtifact(artifact);
    try{const response=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:clean,quality,size,output_format:'png'})}),data=await response.json() as {data?:Array<{b64_json?:string}>;error?:{message?:string}};if(!response.ok||!data.data?.[0]?.b64_json)throw new Error(data.error?.message||`Image generation failed (${response.status}).`);const folder=await mediaFolder(),target=path.join(folder,`Axiom-image-${stamp()}.png`);await fs.writeFile(target,Buffer.from(data.data[0].b64_json,'base64'),{mode:0o600});return this.store.saveMediaArtifact({...artifact,status:'completed',path:target,updatedAt:new Date().toISOString(),progress:100});}
    catch(reason){const error=reason instanceof Error?reason.message:String(reason);this.store.saveMediaArtifact({...artifact,status:'failed',error,updatedAt:new Date().toISOString()});throw new Error(error);}
  }

  async queueVideo(prompt:string,seconds:4|8|12=4,size:VideoSize='1280x720',model:'sora-2'|'sora-2-pro'='sora-2'):Promise<MediaArtifact>{
    const clean=prompt.trim().slice(0,32_000);if(!clean)throw new Error('Video prompt is empty.');const key=this.store.openAIKey();if(!key)throw new Error('OpenAI is required for video generation.');const now=new Date().toISOString(),artifact:MediaArtifact={id:crypto.randomUUID(),kind:'video',provider:'openai',model,prompt:clean,status:'queued',createdAt:now,updatedAt:now,size,durationSeconds:seconds,estimatedCostUsd:(model==='sora-2-pro'?.3:.1)*seconds,progress:0};
    const response=await fetch('https://api.openai.com/v1/videos',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,prompt:clean,seconds,size})}),data=await response.json() as {id?:string;status?:MediaArtifact['status'];progress?:number;error?:{message?:string}};if(!response.ok||!data.id)throw new Error(data.error?.message||`Video generation failed (${response.status}).`);return this.store.saveMediaArtifact({...artifact,jobId:data.id,status:data.status==='in_progress'?'in_progress':'queued',progress:data.progress||0});
  }

  async pollPending():Promise<BackgroundEvent[]>{
    const events:BackgroundEvent[]=[],key=this.store.openAIKey();if(!key)return events;
    for(const artifact of this.store.mediaArtifacts().filter((item)=>item.kind==='video'&&item.jobId&&(item.status==='queued'||item.status==='in_progress')).slice(0,3)){
      try{const response=await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(artifact.jobId!)}`,{headers:{authorization:`Bearer ${key}`}}),data=await response.json() as {status?:MediaArtifact['status'];progress?:number;error?:{message?:string}};if(!response.ok)throw new Error(data.error?.message||`Video status failed (${response.status}).`);if(data.status==='failed')throw new Error(data.error?.message||'Video generation failed.');if(data.status!=='completed'){this.store.saveMediaArtifact({...artifact,status:'in_progress',progress:data.progress||artifact.progress||0,updatedAt:new Date().toISOString()});continue;}const content=await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(artifact.jobId!)}/content`,{headers:{authorization:`Bearer ${key}`}});if(!content.ok)throw new Error(`Generated video download failed (${content.status}).`);const folder=await mediaFolder(),target=path.join(folder,`Axiom-video-${stamp()}.mp4`);await fs.writeFile(target,Buffer.from(await content.arrayBuffer()),{mode:0o600});const completed=this.store.saveMediaArtifact({...artifact,status:'completed',progress:100,path:target,updatedAt:new Date().toISOString()});events.push(this.store.addBackgroundEvent('system','Video generation complete',`Your video is ready at ${completed.path}.`,true));}
      catch(reason){const error=reason instanceof Error?reason.message:String(reason),failed=this.store.saveMediaArtifact({...artifact,status:'failed',error,updatedAt:new Date().toISOString()});events.push(this.store.addBackgroundEvent('system','Video generation failed',failed.error||'Unknown error.',false));}
    }
    return events;
  }
}

export function imageEstimate(quality:ImageQuality,size:ImageSize):number{const base={low:.02,medium:.08,high:.25}[quality],multiplier=size==='1024x1024'?1:1.5;return Number((base*multiplier).toFixed(3));}
async function mediaFolder():Promise<string>{const folder=path.join(app.getPath('pictures'),'Axiom Generated');await fs.mkdir(folder,{recursive:true});return folder;}
function stamp():string{return new Date().toISOString().replace(/[:.]/g,'-');}
