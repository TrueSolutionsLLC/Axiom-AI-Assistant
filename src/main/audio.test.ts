import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptTranscription, synthesizeSpeech, synthesizeSpeechWithFallback, transcriptionConfidence } from './audio';

const base = { provider: 'elevenlabs' as const, openAIKey: '', elevenLabsKey: 'secret', elevenLabsVoiceId: 'JBFqnCBsd6RMkjVDRZzb', elevenLabsModel: 'eleven_multilingual_v2', stability: .5, similarity: .78, style: .18, speed: .98, emotion:'neutral' as const };

afterEach(() => vi.unstubAllGlobals());

describe('speech provider routing', () => {
  it('sends the selected voice and tuning values to ElevenLabs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await synthesizeSpeech(base, 'Hello Axiom');
    expect(result.mimeType).toBe('audio/mpeg');
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/text-to-speech/${base.elevenLabsVoiceId}`);
    expect((request.headers as Record<string, string>)['xi-api-key']).toBe('secret');
    expect(JSON.parse(String(request.body))).toMatchObject({ model_id: 'eleven_multilingual_v2', voice_settings: { similarity_boost: .78, speed: .98 } });
  });

  it('falls through to local operating-system speech when system output is selected', async () => {
    await expect(synthesizeSpeech({ ...base, provider: 'system' }, 'Hello')).rejects.toThrow(/operating-system speech/i);
  });

  it('uses OpenAI when ElevenLabs is selected but has no saved key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([4, 5, 6]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await synthesizeSpeechWithFallback({ ...base, elevenLabsKey: '', openAIKey: 'openai-secret' }, 'Hello again');
    expect(result.provider).toBe('openai');
    expect(result.fallbackFrom).toBe('elevenlabs');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/audio/speech');
  });

  it('recovers through OpenAI when ElevenLabs synthesis fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { message: 'quota exceeded' } }), { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([7, 8, 9]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await synthesizeSpeechWithFallback({ ...base, openAIKey: 'openai-secret' }, 'Fallback test');
    expect(result.provider).toBe('openai');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('transcription confidence',()=>{
  it('accepts confident speech and rejects low-confidence noise guesses',()=>{
    expect(transcriptionConfidence([{token:'hello',logprob:-.08},{token:' there',logprob:-.12}])).toBeGreaterThan(.8);
    expect(acceptTranscription('Hello there',[{token:'hello',logprob:-.08},{token:' there',logprob:-.12}])).toBe(true);
    expect(acceptTranscription('context:',[{token:'context',logprob:-1.4},{token:':',logprob:-1.1}])).toBe(false);
  });
  it('rejects empty and non-speech transcripts',()=>{expect(acceptTranscription('',[])).toBe(false);expect(acceptTranscription('…',[])).toBe(false);});
});
