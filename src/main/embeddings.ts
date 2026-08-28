import { app } from 'electron';
import path from 'node:path';

type Extractor = (text: string, options: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: ArrayLike<number> }>;

const EMBEDDING_DIMENSIONS = 384;

let extractorPromise: Promise<Extractor | undefined> | null = null;

function loadExtractor(): Promise<Extractor | undefined> {
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = `${path.join(app.getAppPath(), 'dist-renderer', 'models')}${path.sep}`;
      const extractor = await pipeline('feature-extraction', 'all-MiniLM-L6-v2', { local_files_only: true, dtype: 'q8' });
      return extractor as unknown as Extractor;
    } catch {
      // The bundled model is missing or failed to load — memory keeps working
      // on keyword search alone; semantic ranking just never activates.
      return undefined;
    }
  })();
  return extractorPromise;
}

/** Local-only sentence embedding (all-MiniLM-L6-v2, 384-dim, normalized). Never throws — returns undefined on any failure so callers can fall back to keyword search. */
export async function embedText(text: string): Promise<number[] | undefined> {
  const clean = text.trim();
  if (!clean) return undefined;
  const extractor = await loadExtractor();
  if (!extractor) return undefined;
  try {
    const output = await extractor(clean, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data as ArrayLike<number>, Number);
    return vector.length === EMBEDDING_DIMENSIONS && vector.every(Number.isFinite) ? vector : undefined;
  } catch {
    return undefined;
  }
}
