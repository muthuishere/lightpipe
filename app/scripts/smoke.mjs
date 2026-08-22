import { chromium } from 'playwright-core';
// Browser-level smoke test of the whole app against the mock core.
//   1. npm run dev                        (in another shell)
//   2. npx playwright install chromium    (once)
//   3. CHROME=<path to a chromium binary> npm run smoke
// Every case is a full round trip inside one tab: sender canvas -> simulated
// camera -> decode worker -> OPFS -> saved file. No hardware involved.
const EXE = process.env.CHROME;
if (!EXE) {
  console.error('set CHROME to a Chromium/Chrome binary path');
  process.exit(1);
}
const URL_ = 'http://localhost:5173/';

async function open() {
  const b = await chromium.launch({ executablePath: EXE });
  const p = await (await b.newContext()).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.goto(URL_, { waitUntil: 'networkidle' });
  await p.getByRole('tab', { name: 'Loopback demo' }).click();
  return { b, p, errs };
}

async function receive(p, preset) {
  await p.locator('select').filter({ has: p.locator('option[value=loopback]') }).selectOption('loopback');
  await p.locator('select').filter({ has: p.locator('option[value=potato]') }).selectOption(preset);
  await p.getByRole('button', { name: 'Start receiving' }).click();
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < 90000) {
    await p.waitForTimeout(1200);
    last = await p.locator('.app').innerText();
    const saveBtn = await p.locator('button', { hasText: /^Save / }).count();
    if (saveBtn > 0) break;
    if (last.includes('Nothing is decoding')) break;
  }
  return { last, secs: (Date.now() - t0) / 1000 };
}

const grab = (t, k) => (t.match(new RegExp(k + '\\n([^\\n]+)')) || [])[1];

async function fileCase(preset, kb) {
  const { b, p, errs } = await open();
  const buf = Buffer.alloc(kb * 1024);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761 >>> 13) & 0xff;
  await p.locator('input[type=file]').setInputFiles({ name: 'demo.bin', mimeType: 'application/octet-stream', buffer: buf });
  await p.getByRole('button', { name: 'Start sending' }).click();
  await p.waitForTimeout(400);
  const { last, secs } = await receive(p, preset);
  const ok = last.includes('COMPLETE ✓');
  console.log(`[file/${preset}] ${kb}KB complete=${ok} ${secs.toFixed(1)}s frames=${grab(last,'FRAMES SEEN')} erasures=${grab(last,'ERASURES')} dup=${grab(last,'DUPLICATES')} fps=${grab(last,'DECODE FPS')} goodput=${grab(last,'GOODPUT')}`);
  const panels = await p.locator('.panel').allInnerTexts();
  const done = panels[panels.length - 1].split('\n').filter(Boolean);
  console.log('   done:', done[1], '|', done[3], '|', done[4], '|', done[done.length - 1]);
  if (errs.length) console.log('   errors:', errs.slice(0, 3));
  await b.close();
}

async function textCase(body, label) {
  const { b, p, errs } = await open();
  await p.getByRole('button', { name: 'Text / note' }).click();
  await p.locator('textarea').fill(body);
  await p.getByRole('button', { name: 'Use this note' }).click();
  await p.getByRole('button', { name: 'Start sending' }).click();
  await p.waitForTimeout(700);
  const senderTxt = await p.locator('.app').innerText();
  const still = senderTxt.includes('One frame. Nothing is animating');
  const pass = grab(senderTxt, 'ONE PASS');
  const { last, secs } = await receive(p, 'potato');
  const ok = last.includes('COMPLETE ✓');
  const rendered = await p.locator('.rendered').count();
  const h1 = rendered ? await p.locator('.rendered h1').first().textContent().catch(() => null) : null;
  const codeblk = rendered ? await p.locator('.rendered pre code').first().textContent().catch(() => null) : null;
  console.log(`[text/${label}] ${body.length}B still=${still} onePass=${pass} complete=${ok} ${secs.toFixed(1)}s rendered=${rendered} h1=${JSON.stringify(h1)} code=${JSON.stringify((codeblk||'').slice(0,30))}`);
  console.log('   meta:', (last.match(/note\.md[^\n]*/) || ['-'])[0], '| copy:', last.includes('Copy text'));
  if (errs.length) console.log('   errors:', errs.slice(0, 3));
  await b.close();
}

async function imageCase() {
  const { b, p, errs } = await open();
  // a small PNG produced in-page, dropped through the file input (same path as paste)
  const png = await p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 40;
    const x = c.getContext('2d');
    x.fillStyle = '#0b57d0'; x.fillRect(0, 0, 64, 40);
    x.fillStyle = '#fff'; x.fillRect(8, 8, 20, 20);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    return Array.from(buf);
  });
  await p.locator('input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await p.getByRole('button', { name: 'Start sending' }).click();
  await p.waitForTimeout(600);
  const senderTxt = await p.locator('.app').innerText();
  const { last, secs } = await receive(p, 'webcam');
  const img = await p.locator('img.shot').count();
  const dims = img ? await p.locator('img.shot').evaluate(e => [e.naturalWidth, e.naturalHeight]) : null;
  console.log(`[image] ${png.length}B still=${senderTxt.includes('One frame')} complete=${last.includes('COMPLETE ✓')} ${secs.toFixed(1)}s inlinePreview=${img} naturalSize=${JSON.stringify(dims)}`);
  console.log('   meta:', (last.match(/shot\.png[^\n]*/) || ['-'])[0]);
  if (errs.length) console.log('   errors:', errs.slice(0, 3));
  await b.close();
}

await fileCase('ideal', 700);
await fileCase('good', 400);
await fileCase('webcam', 400);
await fileCase('potato', 120);
// ADR-0011: a camera on which nothing decodes must say so, not hang at 0%.
await fileCase('hopeless', 120);
await textCase(
  '# Air gap\n\nA **note** with `inline code`, a [link](https://example.com) and:\n\n```rust\nfn main() { println!("hi"); }\n```\n\n- one\n- two\n',
  'small',
);
await textCase('x'.repeat(3000), 'multiframe');
await imageCase();
