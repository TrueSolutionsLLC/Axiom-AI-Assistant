const { chromium } = require('playwright');

(async () => {
  const port = process.env.AXIOM_QA_PORT || '9444';
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  const result = await page.evaluate(async () => {
    const expected = 'Axiom voice transcription verification is online.';
    const speech = await window.axiom.synthesizeSpeech(expected);
    const started = performance.now();
    const transcription = await window.axiom.transcribeAudio({
      audio: speech.audio,
      mimeType: speech.mimeType,
    });
    return {
      expected,
      actual: transcription.text,
      latencyMs: Math.round(performance.now() - started),
      sourceBytes: speech.audio.byteLength,
      sourceMimeType: speech.mimeType,
    };
  });
  result.passed = /axiom voice transcription verification is online/i.test(result.actual);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.passed) process.exitCode = 1;
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
