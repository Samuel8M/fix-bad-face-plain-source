// A/B: Fix Bad Face (analogy) vs Fix Bad Face Plain, on the very same detected faces.
// Synthetic camera moves have exact ground truth; real pairs are checked by sheets of matched crops.
const { chromium } = require('playwright-core');
const fs = require('fs');
const SETS = [
  { name: 'family.jpg' },        // 9 people, studio
  { name: 'bigfamily.jpg' },     // 15 people
  { name: 'burst/mysF01.jpg' },  // 8 people, iPhone
  { name: 'burst/amb02.jpg' },   // 21 small faces, night
];
// Camera moves: pan as a fraction of the width/height, zoom about the centre.
const MOVES = [
  { label: 'still', pan: [0, 0], zoom: 1 },
  { label: 'pan 3%', pan: [0.03, 0.01], zoom: 1 },
  { label: 'pan 6%', pan: [0.06, 0.02], zoom: 1 },
  { label: 'pan 10%', pan: [-0.1, 0.02], zoom: 1 },
  { label: 'pan 15%', pan: [0.15, -0.03], zoom: 1 },
  { label: 'zoom in 15%', pan: [0, 0], zoom: 1.15 },
  { label: 'zoom out 12%', pan: [0, 0], zoom: 0.88 },
  { label: 'step + zoom', pan: [0.08, 0.03], zoom: 1.12 },
];
const REAL = [
  { main: 'burst/mysF01.jpg', other: 'burst/mysF02.jpg', truth: 'order' }, // same people, same order, still camera
  { main: 'burst/amb02.jpg', other: 'burst/amb03.jpg' },
  { main: 'burst/amb02.jpg', other: 'burst/amb04.jpg' },
];
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
    window.read = async (b64, name) => window.v.readPhoto(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'image/jpeg' }), () => {});
    // Scores a correspondence against where each main face should land.
    window.score = (main, other, result, expect) => {
      let correct = 0, wrong = 0, missed = 0, n = 0;
      const wrongIds = [];
      for (const face of main.faces) {
        const p = expect(face);
        if (!p) continue; // left the frame
        const truth = other.faces.find((f) => Math.hypot(f.center.x - p.x, f.center.y - p.y) < f.size * 0.35);
        if (!truth) continue; // not found by the face finder in the other shot: no fair answer
        n += 1;
        const got = result.get(face.id);
        if (!got) missed += 1;
        else if (got.face.id === truth.id) correct += 1;
        else { wrong += 1; wrongIds.push(face.id); }
      }
      return { n, correct, wrong, missed, wrongIds };
    };
  });
  const rows = [];
  for (const set of SETS) {
    const b64 = fs.readFileSync('imgs/' + set.name).toString('base64');
    for (const move of MOVES) {
      const r = await page.evaluate(async ({ b64, name, move }) => {
        if (!window.mainPhoto || window.mainName !== name) { window.mainPhoto = await window.read(b64, name); window.mainName = name; }
        const main = window.mainPhoto;
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
        const W = bmp.width, H = bmp.height, s = move.zoom;
        const dx = W * (1 - s) / 2 + move.pan[0] * W, dy = H * (1 - s) / 2 + move.pan[1] * H;
        const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
        x.fillStyle = '#777'; x.fillRect(0, 0, W, H); x.filter = 'brightness(0.96)'; x.drawImage(bmp, dx, dy, W * s, H * s);
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.93));
        const other = await window.v.readPhoto(new File([blob], 'moved.jpg', { type: 'image/jpeg' }), () => {});
        // main photo pixels → other photo pixels (both photos may be scaled to the working size)
        const km = W / main.width, ko = other.width / W;
        const expect = (face) => {
          const px = (face.center.x * km * s + dx) * ko, py = (face.center.y * km * s + dy) * ko;
          return px > 0 && py > 0 && px < other.width && py < other.height ? { x: px, y: py } : null;
        };
        const a = window.score(main, other, window.A.correspond(main, other), expect);
        const b = window.score(main, other, window.B.correspond(main, other), expect);
        return { faces: main.faces.length, a, b };
      }, { b64, name: set.name, move });
      rows.push({ set: set.name, move: move.label, ...r });
      console.log(`${set.name.padEnd(18)} ${move.label.padEnd(13)} n=${String(r.a.n).padStart(2)} | analogy ${r.a.correct}/${r.a.n} wrong ${r.a.wrong} missed ${r.a.missed} | plain ${r.b.correct}/${r.b.n} wrong ${r.b.wrong} missed ${r.b.missed}`);
    }
  }
  // Real pairs: save side-by-side sheets of each method's matches where they disagree.
  for (const pair of REAL) {
    const [m64, o64] = [pair.main, pair.other].map((f) => fs.readFileSync('imgs/' + f).toString('base64'));
    const r = await page.evaluate(async ({ m64, o64, truth }) => {
      const main = await window.read(m64, 'main.jpg'), other = await window.read(o64, 'other.jpg');
      const ra = window.A.correspond(main, other), rb = window.B.correspond(main, other);
      let agree = 0, differ = [], aOnly = 0, bOnly = 0;
      for (const f of main.faces) {
        const x = ra.get(f.id)?.face.id, y = rb.get(f.id)?.face.id;
        if (x && x === y) agree += 1;
        else if (x || y) differ.push(f);
        if (x && !y) aOnly += 1;
        if (y && !x) bOnly += 1;
      }
      let res = null;
      if (truth === 'order') {
        const byX = (p) => [...p.faces].sort((u, w) => u.center.x - w.center.x);
        const mm = byX(main), oo = byX(other);
        const expectId = new Map(mm.map((f, i) => [f.id, oo[i]?.id]));
        const grade = (r) => mm.reduce((s, f) => s + (r.get(f.id)?.face.id === expectId.get(f.id) ? 1 : 0), 0);
        res = { n: mm.length, a: grade(ra), b: grade(rb) };
      }
      // Sheet: for each face where they differ: main | analogy's pick | plain's pick
      const S = 110;
      const c = document.createElement('canvas'); c.width = S * 3; c.height = Math.max(1, differ.length) * S; const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.font = 'bold 12px sans-serif';
      const draw = (p, f, col, row) => { if (!f) return; const b = f.box; x.drawImage(p.bitmap, b.x - b.w * 0.2, b.y - b.h * 0.2, b.w * 1.4, b.h * 1.4, col * S, row * S, S, S); };
      differ.forEach((f, i) => {
        draw(main, f, 0, i); draw(other, ra.get(f.id)?.face, 1, i); draw(other, rb.get(f.id)?.face, 2, i);
        x.fillStyle = '#ff0'; x.fillText('this', 3, i * S + 13); x.fillText('analogy', S + 3, i * S + 13); x.fillText('plain', 2 * S + 3, i * S + 13);
      });
      return { faces: main.faces.length, other: other.faces.length, agree, differ: differ.length, aOnly, bOnly, res, png: c.toDataURL('image/png').split(',')[1] };
    }, { m64, o64, truth: pair.truth });
    const name = `ab-${pair.main.replace(/.*\//, '').replace('.jpg', '')}-${pair.other.replace(/.*\//, '').replace('.jpg', '')}.png`;
    fs.writeFileSync(name, Buffer.from(r.png, 'base64'));
    console.log(`REAL ${pair.main} -> ${pair.other}: faces ${r.faces}/${r.other}, same answer ${r.agree}, different ${r.differ} (only analogy matched ${r.aOnly}, only plain matched ${r.bOnly})${r.res ? `; vs truth: analogy ${r.res.a}/${r.res.n}, plain ${r.res.b}/${r.res.n}` : ''} -> ${name}`);
  }
  fs.writeFileSync('ab-results.json', JSON.stringify(rows, null, 1));
  await browser.close();
})();
