import type { SpeechAlignment, SpeechProvider } from '../shared/contracts';
import type { CompanionEmotion } from '../shared/contracts';

interface OpenAIError { error?: { message?: string }; detail?: { message?: string }; text?: string }
interface TranscriptionToken { token?:string; logprob?:number }

export interface SpeechConfiguration {
  provider: SpeechProvider;
  openAIKey: string;
  elevenLabsKey: string;
  elevenLabsVoiceId: string;
  elevenLabsModel: string;
  stability: number;
  similarity: number;
  style: number;
  speed: number;
  emotion:CompanionEmotion;
}

export interface SpeechSynthesisResult {
  audio: Uint8Array;
  mimeType: string;
  provider: Exclude<SpeechProvider, 'system'>;
  fallbackFrom?: SpeechProvider;
  fallbackReason?: string;
  alignment?:SpeechAlignment;
}

export function transcriptionConfidence(tokens: TranscriptionToken[] | undefined): number {
  const values=(tokens??[]).map((item)=>item.logprob).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
  if(!values.length)return 1;
  const average=values.reduce((sum,value)=>sum+value,0)/values.length;
  return Math.exp(Math.max(-20,Math.min(0,average)));
}

export function acceptTranscription(text:string,tokens:TranscriptionToken[]|undefined):boolean{
  const clean=text.trim();if(!clean||!/[A-Za-z0-9]/.test(clean))return false;
  return transcriptionConfidence(tokens)>=.48;
}

async function errorMessage(response: Response): Promise<string> {
  try { const data = await response.json() as OpenAIError; return data.error?.message || data.detail?.message || `Audio API failed (${response.status})`; }
  catch { return `Audio API failed (${response.status})`; }
}

export async function transcribeAudio(key: string, bytes: Uint8Array, mimeType: string): Promise<string> {
  if (!key) throw new Error('Add an OpenAI API key in Settings.');
  if (!bytes.byteLength) throw new Error('No microphone audio was captured.');
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Voice recording is too large.');
  const extension = mimeType.includes('webm') ? 'webm' : mimeType.includes('ogg') ? 'ogg' : 'wav';
  const form = new FormData();
  form.append('model', 'gpt-4o-transcribe');
  form.append('response_format', 'json');
  form.append('include[]', 'logprobs');
  form.append('chunking_strategy', 'auto');
  form.append('temperature', '0');
  form.append('language', 'en');
  form.append('prompt', 'Natural English conversation with a Windows AI assistant named Axiom.');
  const audioBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), `axiom-voice.${extension}`);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal:AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(await errorMessage(response));
  const result = await response.json() as { text?: string; logprobs?:TranscriptionToken[] };
  if (!acceptTranscription(result.text??'',result.logprobs)) return '';
  return result.text!.trim();
}

function providerReady(config: SpeechConfiguration, provider: Exclude<SpeechProvider, 'system'>): boolean {
  return provider === 'openai' ? Boolean(config.openAIKey) : Boolean(config.elevenLabsKey && config.elevenLabsVoiceId);
}

export async function synthesizeSpeechWithFallback(config: SpeechConfiguration, text: string): Promise<SpeechSynthesisResult> {
  if (config.provider === 'system') throw new Error('Use operating-system speech.');
  const alternate: Exclude<SpeechProvider, 'system'> = config.provider === 'openai' ? 'elevenlabs' : 'openai';
  const candidates = [config.provider, alternate].filter((provider, index, all) =>
    all.indexOf(provider) === index && providerReady(config, provider),
  );
  if (!candidates.length) throw new Error('No cloud speech provider is configured. Use operating-system speech.');

  const failures: string[] = [];
  for (const provider of candidates) {
    try {
      const result = await synthesizeSpeech({ ...config, provider }, text);
      return { ...result, provider, fallbackFrom: provider === config.provider ? undefined : config.provider, fallbackReason:provider === config.provider?undefined:failures.join(' | ') };
    } catch (reason) {
      failures.push(`${provider}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }
  throw new Error(`Cloud speech failed. ${failures.join(' | ')}`);
}

export async function synthesizeSpeech(config: SpeechConfiguration, text: string): Promise<{ audio: Uint8Array; mimeType: string; alignment?:SpeechAlignment }> {
  const clean = text.replace(/[*_#`]/g, '').trim().slice(0, 4000);
  if (!clean) throw new Error('There is no response to speak.');
  if (config.provider === 'system') throw new Error('Use operating-system speech.');

  if (config.provider === 'elevenlabs') {
    if (!config.elevenLabsKey) throw new Error('Add an ElevenLabs API key in Settings.');
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(config.elevenLabsVoiceId)) throw new Error('Choose a valid ElevenLabs voice in Settings.');
    const baseEndpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenLabsVoiceId)}`;
    const requestBody=JSON.stringify({
      text: clean,
      model_id: config.elevenLabsModel || 'eleven_flash_v2_5',
      voice_settings: { stability: config.stability, similarity_boost: config.similarity, style: config.style, use_speaker_boost: true, speed: config.speed },
    });
    let response = await fetch(`${baseEndpoint}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': config.elevenLabsKey, accept: 'application/json' },
      body: requestBody,
      signal:AbortSignal.timeout(35_000),
    });
    if([404,405,422].includes(response.status))response=await fetch(`${baseEndpoint}?output_format=mp3_44100_128`,{method:'POST',headers:{'content-type':'application/json','xi-api-key':config.elevenLabsKey,accept:'audio/mpeg'},body:requestBody,signal:AbortSignal.timeout(35_000)});
    if (!response.ok) throw new Error(await errorMessage(response));
    const payload=new Uint8Array(await response.arrayBuffer());let data:{audio_base64?:string;alignment?:{characters?:string[];character_start_times_seconds?:number[];character_end_times_seconds?:number[]};normalized_alignment?:{characters?:string[];character_start_times_seconds?:number[];character_end_times_seconds?:number[]}};
    try{data=JSON.parse(new TextDecoder().decode(payload)) as typeof data;}catch{return{audio:payload,mimeType:'audio/mpeg'};}
    if(!data.audio_base64)throw new Error('ElevenLabs returned no speech audio.');
    const source=data.normalized_alignment||data.alignment;
    const count=Math.min(source?.characters?.length??0,source?.character_start_times_seconds?.length??0,source?.character_end_times_seconds?.length??0);
    const alignment=count?{characters:source!.characters!.slice(0,count),characterStartTimesSeconds:source!.character_start_times_seconds!.slice(0,count).map(Number),characterEndTimesSeconds:source!.character_end_times_seconds!.slice(0,count).map(Number)}:undefined;
    return { audio:new Uint8Array(Buffer.from(data.audio_base64,'base64')), mimeType:'audio/mpeg',alignment };
  }

  if (!config.openAIKey) throw new Error('Add an OpenAI API key in Settings.');
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openAIKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'onyx',
      input: clean,
      instructions: `Speak as a calm, confident futuristic companion. Use a brisk, conversational pace with crisp phrasing and minimal dramatic pauses. Sound natural, warm, concise, and present in the room. The current emotional delivery is ${config.emotion}; express it subtly without becoming theatrical.`,
      response_format: 'wav',
      speed: config.speed,
    }),
    signal:AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return { audio: new Uint8Array(await response.arrayBuffer()), mimeType: 'audio/wav' };
}
