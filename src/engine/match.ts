import { clamp, distance, type Face, type Photo } from './vision';

/*
 * The plain matcher: Fix Bad Face with the analogy methods taken out, as a control.
 *
 * It does what a camera-burst feature such as Google's Best Take can rely on, because its shots
 * come from the same phone a few seconds apart: once the frames are lined up, the same person is
 * at about the same place in every frame.
 *
 *  - Lining up: conventional image registration. The camera shift (pan and zoom) is the one that
 *    best lines up the pixels of the two whole images (normalised cross-correlation, coarse to
 *    fine), as any burst-merging feature has to do before it can blend.
 *  - Who is who: each face pairs with the face at the nearest position in the other frame, after
 *    lining up, that also looks most alike (face texture, hair, skin and clothing colour). Pairs
 *    are taken one-to-one, best first.
 *  - Best face: one pass over every match, scored on open eyes, sharpness, smile, head angle,
 *    size and match confidence.
 *
 * Removed compared with Fix Bad Face (see README.md):
 *  - structure-mapping correspondence: no search for the one camera shift the whole group's
 *    arrangement agrees with (systematicity); the shift comes from the pixels, and each face is
 *    then placed on its own;
 *  - the relational signature (how eyes, nose, mouth and chin sit relative to each other);
 *  - MAC/FAC two-stage retrieval with its structural check on the shortlist.
 * The appearance cues, thresholds and remaining weights are the same, so any difference in
 * results comes from the analogy methods alone.
 */

export type Match = { face: Face; confidence: number };
export type Candidate = {
  face: Face;
  photo: Photo;
  confidence: number;
  quality: number;
  pose: number;
  score: number;
};

function colourSimilarity(a: number[] | null, b: number[] | null) {
  if (!a || !b) return null;
  return Math.exp(-((Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 0.16) ** 2));
}

/** Appearance similarity in [0, 1]: do these two faces look like the same person in the same outfit? */
export function appearanceSimilarity(a: Face, b: Face) {
  let weighted = 0;
  let weights = 0;
  const add = (value: number | null, weight: number) => {
    if (value === null) return;
    weighted += value * weight;
    weights += weight;
  };
  let correlation = 0;
  for (let i = 0; i < a.texture.length; i += 1) correlation += a.texture[i] * b.texture[i];
  add(clamp((correlation - 0.2) / 0.7), 0.3);
  add(colourSimilarity(a.context.clothes, b.context.clothes), 0.3);
  add(colourSimilarity(a.context.hair, b.context.hair), 0.2);
  add(colourSimilarity(a.context.skin, b.context.skin), 0.1);
  return weighted / Math.max(0.0001, weights);
}

type Shift = { scale: number; dx: number; dy: number };
type Gray = { gray: Float32Array; width: number; height: number };

function grayscale(photo: Photo, width: number): Gray {
  const height = Math.max(1, Math.round((photo.height / photo.width) * width));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(photo.bitmap, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i += 1) gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  return { gray, width, height };
}

/** Normalised cross-correlation of image a against b, with a's pixel (x, y) at (x·s + dx, y·s + dy) in b. */
function correlation(a: Gray, b: Gray, s: number, dx: number, dy: number, step: number) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = 0; y < a.height; y += step) {
    const by = Math.round(y * s + dy);
    if (by < 0 || by >= b.height) continue;
    for (let x = 0; x < a.width; x += step) {
      const bx = Math.round(x * s + dx);
      if (bx < 0 || bx >= b.width) continue;
      const va = a.gray[y * a.width + x], vb = b.gray[by * b.width + bx];
      n += 1; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
  }
  // Too little overlap to trust.
  if (n < (a.width * a.height) / (step * step) / 3) return -1;
  const cov = sab / n - (sa / n) * (sb / n);
  return cov / Math.sqrt(Math.max(1e-6, (saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2)));
}

/** Image registration: the pan and zoom that best line up the two whole images' pixels. */
function register(main: Photo, other: Photo): Shift {
  const base = 192;
  const a = grayscale(main, base);
  // Both drawn at the same width, so a still camera is scale 1 whatever the photos' resolutions.
  const b = grayscale(other, base);
  let best = { s: 1, dx: 0, dy: 0, score: -2 };
  const range = Math.round(base * 0.25);
  for (let s = 0.85; s <= 1.2001; s += 0.025) {
    for (let dy = -range; dy <= range; dy += 3) {
      for (let dx = -range; dx <= range; dx += 3) {
        const score = correlation(a, b, s, dx + (base * (1 - s)) / 2, dy + (a.height * (1 - s)) / 2, 4);
        if (score > best.score) best = { s, dx: dx + (base * (1 - s)) / 2, dy: dy + (a.height * (1 - s)) / 2, score };
      }
    }
  }
  for (const [step, span, sStep] of [[2, 3, 0.01], [1, 2, 0.004], [1, 1, 0.002]] as const) {
    const start = { ...best };
    for (let s = start.s - sStep * 2; s <= start.s + sStep * 2 + 1e-9; s += sStep) {
      for (let dy = start.dy - span; dy <= start.dy + span; dy += 1) {
        for (let dx = start.dx - span; dx <= start.dx + span; dx += 1) {
          const score = correlation(a, b, s, dx, dy, step);
          if (score > best.score) best = { s, dx, dy, score };
        }
      }
    }
  }
  const toOther = other.width / base;
  return { scale: best.s * (other.width / main.width), dx: best.dx * toOther, dy: best.dy * toOther };
}

/** Same place in the lined-up frames, same size, looks alike. */
function pairScore(shift: Shift, a: Face, b: Face, similarity: number) {
  const expected = a.size * shift.scale;
  const at = { x: a.center.x * shift.scale + shift.dx, y: a.center.y * shift.scale + shift.dy };
  const proximity = Math.exp(-((distance(at, b.center) / (0.6 * expected)) ** 2));
  const sizeAgreement = Math.exp(-2 * Math.abs(Math.log(b.size / Math.max(1, expected))));
  return proximity * sizeAgreement * (0.35 + 0.65 * similarity);
}

/** For each face in `main`, the same person in `other` (if any). */
export function correspond(main: Photo, other: Photo): Map<string, Match> {
  const result = new Map<string, Match>();
  if (!main.faces.length || !other.faces.length) return result;
  const shift = register(main, other);
  const pairs: { i: number; j: number; score: number }[] = [];
  main.faces.forEach((a, i) => other.faces.forEach((b, j) => pairs.push({ i, j, score: pairScore(shift, a, b, appearanceSimilarity(a, b)) })));
  pairs.sort((x, y) => y.score - x.score);
  const usedMain = new Set<number>();
  const usedOther = new Set<number>();
  for (const pair of pairs) {
    if (usedMain.has(pair.i) || usedOther.has(pair.j) || pair.score < 0.22) continue;
    usedMain.add(pair.i);
    usedOther.add(pair.j);
    result.set(main.faces[pair.i].id, { face: other.faces[pair.j], confidence: clamp(pair.score) });
  }
  return result;
}

export function quality(face: Face) {
  return 0.65 * face.eyesOpen + 0.2 * face.sharpness + 0.15 * face.smile;
}

function poseFit(target: Face, donor: Face) {
  return Math.exp(-0.5 * (((target.yaw - donor.yaw) / 0.16) ** 2 + ((target.pitch - donor.pitch) / 0.2) ** 2 + ((target.roll - donor.roll) / 0.24) ** 2));
}

/** Ranked replacement faces for `target`, best first, in one pass. */
export function rankCandidates(target: Face, photos: Photo[], matches: Map<string, Map<string, Match>>): Candidate[] {
  return photos
    .flatMap((photo) => {
      const match = matches.get(photo.id)?.get(target.id);
      if (!match) return [];
      const pose = poseFit(target, match.face);
      // Enlarging a smaller face blurs it; shrinking a larger one is harmless.
      const scale = match.face.size >= target.size ? 1 : Math.exp(-Math.abs(Math.log(match.face.size / target.size)) * 0.6);
      const q = quality(match.face);
      // Fix Bad Face's final weights with the structural term removed, rescaled to sum to 1.
      const score = 0.475 * q + 0.25 * pose + 0.125 * scale + 0.15 * match.confidence;
      return [{ face: match.face, photo, confidence: match.confidence, quality: q, pose, score }];
    })
    .sort((a, b) => b.score - a.score);
}

/** Below this width the eyes are only a few pixels, so their state is a guess. */
export const eyesReadable = (face: Face) => face.size >= 60;
// Closed eyes read ~0.0 and a smiling squint ~0.6, so the cut sits well below a squint.
export const eyesLookClosed = (face: Face) => eyesReadable(face) && face.eyesOpen < 0.35;

/** The candidate worth swapping in automatically, if the target's eyes look closed and a clearly better take exists. */
export function suggestedFix(target: Face, candidates: Candidate[]) {
  if (!eyesLookClosed(target)) return undefined;
  return candidates.find((candidate) => eyesReadable(candidate.face) && candidate.face.eyesOpen > 0.5 && candidate.face.eyesOpen > target.eyesOpen + 0.3);
}
