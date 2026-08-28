const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.AXIOM_QA_PORT || '9444'}`);
  const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => /index\.html/.test(candidate.url()));
  if (!page) throw new Error('Axiom renderer was not found.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.modded-ring svg');
  const avatar = page.locator('.modded-avatar');
  const head = page.locator('.modded-head');
  await head.evaluate((element) => { element.style.transform = 'translate3d(calc(-50% - 88px),calc(-50% - 18px),0) rotateY(-15deg)'; });
  await avatar.screenshot({ path: path.resolve(__dirname, '../qa/ring-fixed-head-left.png') });
  await head.evaluate((element) => { element.style.transform = 'translate3d(calc(-50% + 88px),calc(-50% + 18px),0) rotateY(15deg)'; });
  await avatar.screenshot({ path: path.resolve(__dirname, '../qa/ring-fixed-head-right.png') });
  await head.evaluate((element) => { element.style.removeProperty('transform'); });
  const result = await page.evaluate(() => {
    const avatar = document.querySelector('.modded-avatar');
    const ring = document.querySelector('.modded-ring');
    const head = document.querySelector('.modded-head');
    if (!(avatar instanceof HTMLElement) || !(ring instanceof HTMLElement) || !(head instanceof HTMLElement)) throw new Error('Avatar layers are incomplete.');
    const ringGraphic = ring.querySelector('svg');
    if (!(ringGraphic instanceof SVGElement)) throw new Error('The stationary ring graphic is missing.');
    const before = { ring: getComputedStyle(ring).transform, ringGraphic: getComputedStyle(ringGraphic).transform, head: getComputedStyle(head).transform };
    const previous = {
      x: avatar.style.getPropertyValue('--head-x'),
      y: avatar.style.getPropertyValue('--head-y'),
      yaw: avatar.style.getPropertyValue('--head-yaw'),
    };
    avatar.style.setProperty('--head-x', '86px');
    avatar.style.setProperty('--head-y', '-24px');
    avatar.style.setProperty('--head-yaw', '17deg');
    const after = { ring: getComputedStyle(ring).transform, ringGraphic: getComputedStyle(ringGraphic).transform, head: getComputedStyle(head).transform };
    avatar.style.setProperty('--head-x', previous.x);
    avatar.style.setProperty('--head-y', previous.y);
    avatar.style.setProperty('--head-yaw', previous.yaw);
    return { before, after, ringFixed: before.ring === after.ring && before.ringGraphic === after.ringGraphic, headMoved: before.head !== after.head };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.ringFixed || !result.headMoved) process.exitCode = 1;
})().catch((error) => { console.error(error.stack || error); process.exit(1); });
