const MIN_CHUNK = 12;
const TARGET_CHUNK = 118;
const MAX_CHUNK = 176;

export function cleanSpokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[*_#`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function takeSpeechChunks(input: string, flush = false): { chunks: string[]; remainder: string } {
  let remainder = input.replace(/^\s+/, '');
  const chunks: string[] = [];

  while (remainder.length) {
    let boundary = -1;
    const sentence = /[.!?](?:["')\]]*)(?=\s|$)/g;
    for (const match of remainder.matchAll(sentence)) {
      const end = (match.index ?? 0) + match[0].length;
      if (end >= MIN_CHUNK) { boundary = end; break; }
    }

    if (boundary < 0 && remainder.length >= MAX_CHUNK) {
      const window = remainder.slice(MIN_CHUNK, TARGET_CHUNK);
      const clause = Math.max(window.lastIndexOf(','), window.lastIndexOf(';'), window.lastIndexOf(':'));
      const whitespace = window.lastIndexOf(' ');
      boundary = MIN_CHUNK + (clause > 60 ? clause + 1 : whitespace > 0 ? whitespace : TARGET_CHUNK - MIN_CHUNK);
    }

    if (boundary < 0) break;
    const chunk = cleanSpokenText(remainder.slice(0, boundary));
    if (chunk) chunks.push(chunk);
    remainder = remainder.slice(boundary).replace(/^\s+/, '');
    if (!flush && chunks.length) break;
  }

  if (flush) {
    const finalChunk = cleanSpokenText(remainder);
    if (finalChunk) chunks.push(finalChunk);
    remainder = '';
  }

  return { chunks, remainder };
}
