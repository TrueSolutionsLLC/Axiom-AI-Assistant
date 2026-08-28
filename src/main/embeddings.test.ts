import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// Real integration test, not a mock of the model: points app.getAppPath() at
// this repo's own root so embedText() loads the actual bundled
// all-MiniLM-L6-v2 ONNX model from src/renderer/public/models exactly the
// way the packaged app will, and runs real inference. This is the only way
// to actually verify local, offline semantic embedding works end-to-end
// rather than assume the wiring is correct.
vi.mock('electron', () => ({
  app: { getAppPath: () => path.join(__dirname, '..', '..') },
}));

import { embedText } from './embeddings';
import { cosineSimilarity } from './memoryCore';

describe('local sentence embeddings (real model, offline, no network)', () => {
  it('embeds real text into a normalized 384-dimension vector', async () => {
    const vector = await embedText('Robbie lives in St. Louis.');
    expect(vector).toBeDefined();
    expect(vector).toHaveLength(384);
    expect(vector!.every((value) => Number.isFinite(value))).toBe(true);
    const magnitude = Math.sqrt(vector!.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 1);
  });

  it('returns undefined for empty text instead of calling the model', async () => {
    expect(await embedText('   ')).toBeUndefined();
  });

  it('scores a semantically related pair higher than an unrelated pair', async () => {
    const fact = await embedText('Robbie lives in St. Louis and loves synthwave music.');
    const relatedQuestion = await embedText('Where is my hometown?');
    const unrelatedQuestion = await embedText('What is the capital of France?');
    const relatedScore = cosineSimilarity(fact!, relatedQuestion!);
    const unrelatedScore = cosineSimilarity(fact!, unrelatedQuestion!);
    expect(relatedScore).toBeGreaterThan(unrelatedScore);
  }, 15_000);
});
