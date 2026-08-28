const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9666');
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith('file:')) || pages[0];

  if (!page) throw new Error('Axiom renderer was not available.');
  await page.waitForSelector('.modded-wave', { state: 'attached' });
  await page.waitForSelector('.modded-ring', { state: 'attached' });

  const snapshot = () => page.evaluate(() => {
    const wave = document.querySelector('.modded-wave');
    const ring = document.querySelector('.modded-ring');
    if (!(wave instanceof HTMLCanvasElement) || !(ring instanceof HTMLElement)) {
      throw new Error('Waveform or ring element is missing.');
    }
    return {
      wave: wave.toDataURL('image/png'),
      ringTransform: getComputedStyle(ring).transform,
    };
  });

  const first = await snapshot();
  await page.waitForTimeout(320);
  const second = await snapshot();
  const result = {
    waveformAnimated: first.wave !== second.wave,
    ringStationary: first.ringTransform === second.ringTransform,
    ringTransform: second.ringTransform,
  };

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.waveformAnimated || !result.ringStationary) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
