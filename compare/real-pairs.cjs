// Real pairs and a multi-shot pick test: where the two methods disagree, save crops to judge.
const { chromium } = require('playwright-core');
const fs = require('fs');
const PAIRS = [['burst/affF01.jpg', 'burst/affF02.jpg'], ['burst/affF02.jpg', 'burst/affF01.jpg'], ...['01', '03', '05', '06', '07'].map((n) => ['burst/amb02.jpg', `burst/amb${n}.jpg`])];
const PICK = { main: 'burst/amb02.jpg', others: ['01', '03', '04', '05', '06', '07'].map((n) => `burst/amb${n}.jpg`) };
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5174'); await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    window.v = await import('/src/engine/vision.ts');
    window.A = await import('/src/engine/match.ts');
    window.B = await import('http://localhost:5189/src/engine/match.ts');
    await window.v.prepareModels();
    window.cache = {};
    window.load = async (name, b64) => (window.cache[name] ??= await window.v.readPhoto(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'image/jpeg' }), () => {}));
    window.crop = (x, p, f, col, row, S) => { if (!f) return; const b = f.box; x.drawImage(p.bitmap, b.x - b.w * 0.2, b.y - b.h * 0.2, b.w * 1.4, b.h * 1.4, col * S, row * S, S, S); };
  });
  const b64 = (f) => fs.readFileSync('imgs/' + f).toString('base64');
  for (const [m, o] of PAIRS) {
    const r = await page.evaluate(async ({ m, o, mb, ob }) => {
      const main = await window.load(m, mb), other = await window.load(o, ob);
      const ra = window.A.correspond(main, other), rb = window.B.correspond(main, other);
      let same = 0; const differ = [];
      for (const f of main.faces) {
        const x = ra.get(f.id)?.face.id, y = rb.get(f.id)?.face.id;
        if (x && x === y) same += 1; else if (x || y) differ.push(f);
      }
      const S = 100, c = document.createElement('canvas'); c.width = S * 3; c.height = Math.max(1, differ.length) * S; const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.font = 'bold 12px sans-serif';
      differ.forEach((f, i) => { window.crop(x, main, f, 0, i, S); window.crop(x, other, ra.get(f.id)?.face, 1, i, S); window.crop(x, other, rb.get(f.id)?.face, 2, i, S); x.fillStyle = '#ff0'; x.fillText(`#${i} this`, 3, i * S + 13); x.fillText('analogy', S + 3, i * S + 13); x.fillText('plain', 2 * S + 3, i * S + 13); });
      return { faces: main.faces.length, other: other.faces.length, a: ra.size, b: rb.size, same, differ: differ.length, png: c.toDataURL('image/png').split(',')[1] };
    }, { m, o, mb: b64(m), ob: b64(o) });
    const name = `abr-${m.replace(/.*\//, '').replace('.jpg', '')}-${o.replace(/.*\//, '').replace('.jpg', '')}.png`;
    fs.writeFileSync(name, Buffer.from(r.png, 'base64'));
    console.log(`${m} -> ${o}: faces ${r.faces}/${r.other}; matched analogy ${r.a}, plain ${r.b}; same ${r.same}; disagree ${r.differ} -> ${name}`);
  }
  // Pick test: each face's best take among six other shots.
  const r = await page.evaluate(async ({ main, others, mb, obs }) => {
    const m = await window.load(main, mb);
    const os = [];
    for (let i = 0; i < others.length; i += 1) os.push(await window.load(others[i], obs[i]));
    const ma = new Map(os.map((p) => [p.id, window.A.correspond(m, p)])), mb2 = new Map(os.map((p) => [p.id, window.B.correspond(m, p)]));
    let same = 0, differ = [], none = 0;
    for (const f of m.faces) {
      const a = window.A.rankCandidates(f, os, ma)[0], b = window.B.rankCandidates(f, os, mb2)[0];
      if (!a && !b) none += 1; else if (a && b && a.face.id === b.face.id) same += 1; else differ.push({ f, a, b });
    }
    const S = 100, c = document.createElement('canvas'); c.width = S * 3; c.height = Math.max(1, differ.length) * S; const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.font = 'bold 12px sans-serif';
    differ.forEach((d, i) => { window.crop(x, m, d.f, 0, i, S); if (d.a) window.crop(x, d.a.photo, d.a.face, 1, i, S); if (d.b) window.crop(x, d.b.photo, d.b.face, 2, i, S); x.fillStyle = '#ff0'; x.fillText(`#${i} this`, 3, i * S + 13); x.fillText('analogy', S + 3, i * S + 13); x.fillText('plain', 2 * S + 3, i * S + 13); });
    const fmt = (c) => c ? `${c.photo.name} q${c.quality.toFixed(2)} eyes${c.face.eyesOpen.toFixed(2)}` : '-';
    return { n: m.faces.length, same, none, rows: differ.map((d, i) => `#${i} this eyes${d.f.eyesOpen.toFixed(2)} | analogy ${fmt(d.a)} | plain ${fmt(d.b)}`), png: c.toDataURL('image/png').split(',')[1] };
  }, { main: PICK.main, others: PICK.others, mb: b64(PICK.main), obs: PICK.others.map(b64) });
  fs.writeFileSync('abr-picks.png', Buffer.from(r.png, 'base64'));
  console.log(`PICKS amb02 + 6 shots: ${r.n} faces; same best take ${r.same}; neither found ${r.none}; differ ${r.rows.length}`);
  console.log(r.rows.join('\n'));
  await browser.close();
})();
