import { describe, expect, it } from 'vitest';
import { cleanSpokenText, takeSpeechChunks } from './speechChunks';

describe('streaming speech chunker', () => {
  it('releases complete sentences and preserves an incomplete tail', () => {
    expect(takeSpeechChunks('Visual link established. I am still build')).toEqual({
      chunks: ['Visual link established.'],
      remainder: 'I am still build',
    });
  });

  it('flushes the final partial sentence', () => {
    expect(takeSpeechChunks('Ready when you are', true)).toEqual({ chunks: ['Ready when you are'], remainder: '' });
  });

  it('bounds long speech at a natural clause', () => {
    const text = `${'A'.repeat(95)}, ${'B'.repeat(210)}`;
    const result = takeSpeechChunks(text);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].endsWith(',')).toBe(true);
    expect(result.remainder.startsWith('B')).toBe(true);
  });

  it('removes visual markdown and noisy URLs from speech', () => {
    expect(cleanSpokenText('**Done.** See https://example.com/path and `status`.')).toBe('Done. See link and status.');
  });
});
