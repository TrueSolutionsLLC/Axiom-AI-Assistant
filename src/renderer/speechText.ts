/**
 * What Axiom actually speaks, as opposed to what's shown in the chat. The
 * visible text keeps every link (MessageText renders bare URLs as clickable
 * anchors) — but reading a raw URL out loud sounds exactly as bad as it
 * sounds, and got worse once search results routinely came back with real
 * links (headlines, sources) in the answer itself. Strips both markdown
 * links and bare URLs, keeping the readable label text where one exists.
 */
export const speechOnlyText = (text: string): string =>
  text
    .replace(/\n\nSources:\n[\s\S]*$/i, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/^[-*]\s*$/gm, '')
    .replace(/\n{2,}(?=[-*]\s)/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
