const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT||'9444'}`);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.waitForSelector('.composer input', { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.shell')?.classList.contains('mode-speaking'), null, { timeout: 20_000 }).catch(() => {});
  const prompt = 'Give me exactly twelve short, vivid sentences describing a futuristic command center. Make the first sentence exactly: The chamber is awake.';
  await page.locator('.composer input').fill(prompt);
  const started = Date.now();
  await page.locator('.composer').evaluate((form) => form.requestSubmit());

  const firstDelta = await page.waitForFunction(() => document.querySelector('.identity-line span')?.textContent?.includes('STREAM'), null, { timeout: 30_000 }).then(() => Date.now() - started);
  const voiceStarted = await page.waitForFunction(() => document.querySelector('.shell')?.classList.contains('mode-speaking'), null, { timeout: 30_000 }).then(() => Date.now() - started);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.modded-avatar')).getPropertyValue('--jaw-open')) > .1, null, { timeout: 10_000 });
  const frameState = await page.locator('.modded-avatar').evaluate((avatar) => {
    const half = avatar.querySelector('.modded-jaw-half');
    const open = avatar.querySelector('.modded-jaw-open');
    return {
      halfOpacity: getComputedStyle(half).opacity,
      openOpacity: getComputedStyle(open).opacity,
      halfLoaded: half.complete && half.naturalWidth > 0,
      openLoaded: open.complete && open.naturalWidth > 0,
      halfSize: [half.naturalWidth, half.naturalHeight],
      openSize: [open.naturalWidth, open.naturalHeight],
    };
  });
  await page.screenshot({ path: 'qa/axiom-speaking-start.png', fullPage: true });
  const mouthSamples = [];
  for (let index = 0; index < 18; index += 1) {
    mouthSamples.push(await page.locator('.modded-avatar').evaluate((avatar) => {
      const style = getComputedStyle(avatar);
      return {
        open: Number(style.getPropertyValue('--jaw-open')),
        half: Number(style.getPropertyValue('--jaw-half')),
        frame: Number(style.getPropertyValue('--jaw-open-frame')),
      };
    }));
    await page.waitForTimeout(75);
  }
  await page.screenshot({ path: 'qa/axiom-speaking.png', fullPage: true });
  const beganBeforeCompletion = await page.locator('.composer input').isDisabled();
  await page.waitForFunction(() => !(document.querySelector('.composer input'))?.disabled, null, { timeout: 60_000 });
  const responseComplete = Date.now() - started;
  const mouthRange = Math.max(...mouthSamples.map((sample) => sample.open)) - Math.min(...mouthSamples.map((sample) => sample.open));
  const passed = errors.length === 0 && voiceStarted < 10_000 && mouthRange > .08;
  console.log(JSON.stringify({ firstDeltaMs: firstDelta, firstVoiceMs: voiceStarted, responseCompleteMs: responseComplete, beganBeforeCompletion, frameState, mouthRange, mouthSamples, errors, passed }, null, 2));
  await browser.close();
  if (!passed) process.exitCode = 1;
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
