const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT || '9444'}`);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /index\.html/.test(candidate.url())) || browser.contexts()[0].pages()[0];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.shell', { timeout: 30_000 });
  await page.getByRole('button', { name: /SCREEN/ }).click();
  await page.getByRole('button', { name: /CAPTURE PRIMARY DISPLAY/ }).click();
  await page.waitForSelector('.vision-preview img', { timeout: 15_000 });
  const capture = await page.locator('.vision-preview img').evaluate((image) => ({ srcBytes: image.src.length, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }));
  await page.getByRole('button', { name: /ASK AXIOM ABOUT THIS SCREEN/ }).click();
  const input = page.locator('.composer input');
  await input.fill('Inspect the attached screen, include the exact phrase SCREEN VISION ONLINE, and briefly identify the main application visible.');
  const started = Date.now();
  await page.locator('.composer').evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('.identity-line p')?.textContent?.includes('SCREEN VISION ONLINE'), null, { timeout: 60_000 });
  const visibleAnswerMs = Date.now() - started;
  await page.waitForFunction(() => !(document.querySelector('.composer input'))?.disabled, null, { timeout: 60_000 });
  const discarded = await page.locator('.screen-attachment').count() === 0;
  const metrics = await page.locator('.telemetry section').nth(1).locator('.metric b').allInnerTexts();
  const passed = capture.srcBytes > 10_000 && capture.naturalWidth > 500 && capture.naturalHeight > 300 && discarded && metrics.some((value) => /\d+%/.test(value)) && errors.length === 0;
  console.log(JSON.stringify({ capture, visibleAnswerMs, discarded, metrics, errors, passed }, null, 2));
  await browser.close();
  if (!passed) process.exitCode = 1;
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
