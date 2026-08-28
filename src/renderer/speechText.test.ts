import { describe, expect, it } from 'vitest';
import { speechOnlyText } from './speechText';

describe('speechOnlyText — strip links before Axiom speaks, keep them in the visible text', () => {
  it('replaces a markdown link with just its label', () => {
    expect(speechOnlyText('Check [Reuters World](https://www.reuters.com/world/) for more.')).toBe('Check Reuters World for more.');
  });

  it('removes a bare URL entirely, with no label to fall back on', () => {
    expect(speechOnlyText('See https://www.bbc.com/news for details.')).toBe('See for details.');
  });

  it('drops a bullet line that becomes empty once its bare URL is removed', () => {
    const text = '- Reuters World\n- https://example.com/only-a-link\n- BBC News';
    expect(speechOnlyText(text)).toBe('- Reuters World\n- BBC News');
  });

  it('strips a trailing Sources: block', () => {
    expect(speechOnlyText('The answer.\n\nSources:\n- Title: https://example.com')).toBe('The answer.');
  });

  it('handles the real live-report case: a markdown-linked headline list', () => {
    const text = [
      '## World breaking-news briefing',
      '',
      '- **Reuters World:** international breaking news',
      '  [Reuters World](https://www.reuters.com/world/)',
      '- **AP World News:** global top stories',
      '  [AP World News](https://apnews.com/world-news)',
    ].join('\n');
    const spoken = speechOnlyText(text);
    expect(spoken).not.toContain('http');
    expect(spoken).toContain('Reuters World');
    expect(spoken).toContain('AP World News');
  });

  it('leaves plain text with no links untouched', () => {
    expect(speechOnlyText('The weather today is sunny and 81 degrees.')).toBe('The weather today is sunny and 81 degrees.');
  });
});
