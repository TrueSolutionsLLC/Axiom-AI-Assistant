const { chromium } = require('playwright');

(async () => {
  const port = process.env.AXIOM_QA_PORT || '9777';
  const phase = process.argv.includes('--restore') ? 'restore' : 'hide';
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error('No packaged Axiom renderer is available.');
  if (phase === 'hide') {
    let targetClosed = false;
    try {
      await page.evaluate(() => window.close());
      await page.waitForTimeout(800);
    } catch (error) {
      if (!/Target page, context or browser has been closed/i.test(String(error))) throw error;
      targetClosed = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const result = { phase, targetClosed, remainingRendererTargets: Array.isArray(targets) ? targets.length : -1, passed: Array.isArray(targets) };
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    if (!result.passed) process.exitCode = 1;
    return;
  } else {
    await page.waitForFunction(() => document.visibilityState === 'visible', undefined, { timeout: 10_000 });
  }
  const result = await page.evaluate(() => ({
    visibility: document.visibilityState,
    title: document.title,
    status: document.querySelector('.identity-line span')?.textContent?.trim() || '',
  }));
  const passed = phase === 'hide' ? result.visibility === 'hidden' : result.visibility === 'visible';
  console.log(JSON.stringify({ phase, ...result, passed }, null, 2));
  await browser.close();
  if (!passed) process.exitCode = 1;
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
