import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = join(process.cwd(), 'src', 'renderer', 'public', 'models', 'wavlm-base-plus-sv');
const files = [
  ['config.json', 'https://huggingface.co/Xenova/wavlm-base-plus-sv/resolve/main/config.json', 100],
  ['preprocessor_config.json', 'https://huggingface.co/Xenova/wavlm-base-plus-sv/resolve/main/preprocessor_config.json', 100],
  ['onnx/model_quantized.onnx', 'https://huggingface.co/Xenova/wavlm-base-plus-sv/resolve/main/onnx/model_quantized.onnx', 90_000_000],
];

for (const [relative, url, minimumBytes] of files) {
  const target = join(root, relative);
  if (existsSync(target) && statSync(target).size >= minimumBytes) {
    console.log(`ready ${relative} (${statSync(target).size} bytes)`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  console.log(`downloading ${relative}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${relative}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { mode: 0o644 }));
  const bytes = statSync(target).size;
  if (bytes < minimumBytes) throw new Error(`${relative}: incomplete download (${bytes} bytes)`);
  console.log(`ready ${relative} (${bytes} bytes)`);
}
