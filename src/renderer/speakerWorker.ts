/// <reference lib="webworker" />

import { AutoModel, AutoProcessor, env } from '@huggingface/transformers';

type Request = { id:number; type:'warm' } | { id:number; type:'embed'; audio:Float32Array };

const modelId = 'wavlm-base-plus-sv';
let engine:Promise<{ processor:Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>; model:Awaited<ReturnType<typeof AutoModel.from_pretrained>> }>|null=null;

function loadEngine(){
  if(engine)return engine;
  env.allowRemoteModels=false;
  env.allowLocalModels=true;
  env.localModelPath=`${self.location.origin}/models/`;
  env.useBrowserCache=false;
  const onnx=env.backends.onnx as typeof env.backends.onnx & {wasm?:{wasmPaths?:string;numThreads?:number;proxy?:boolean}};
  onnx.wasm={...(onnx.wasm??{}),wasmPaths:`${self.location.origin}/ort/`,numThreads:1,proxy:false};
  engine=Promise.all([
    AutoProcessor.from_pretrained(modelId,{local_files_only:true}),
    AutoModel.from_pretrained(modelId,{local_files_only:true,dtype:'q8'}),
  ]).then(([processor,model])=>({processor,model}));
  return engine;
}

self.onmessage=async(event:MessageEvent<Request>)=>{
  const request=event.data;
  try{
    const {processor,model}=await loadEngine();
    if(request.type==='warm'){
      self.postMessage({id:request.id,ok:true,ready:true});
      return;
    }
    if(request.audio.length<8_000)throw new Error('Neural voice capture needs at least half a second of clear speech.');
    const inputs=await processor(request.audio);
    const output=await model(inputs) as unknown as {embeddings?:{data?:Float32Array|number[]};logits?:{data?:Float32Array|number[]}};
    const values=Array.from(output.embeddings?.data??output.logits?.data??[],Number);
    if(values.length!==512||values.some((value)=>!Number.isFinite(value)))throw new Error('WavLM returned an invalid speaker embedding.');
    const magnitude=Math.sqrt(values.reduce((sum,value)=>sum+value*value,0))||1;
    const vector=new Float32Array(values.map((value)=>value/magnitude));
    self.postMessage({id:request.id,ok:true,vector},[vector.buffer]);
  }catch(reason){
    self.postMessage({id:request.id,ok:false,error:reason instanceof Error?reason.message:String(reason)});
  }
};

export {};
