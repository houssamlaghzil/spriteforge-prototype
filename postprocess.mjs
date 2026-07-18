
import sharp from "sharp";

const ALPHA_MIN = 25;        // en-dessous, le pixel est considéré comme du fond
const STATS_WIDTH = 256;     // l'analyse se fait sur une version réduite
const HEAD_BAND = 0.22;      // bande haute de la silhouette servant d'ancre (la tête bouge peu)
const MAX_SHIFT = 0.08;      // décalage max autorisé, en fraction de la largeur
const GAIN_MIN = 0.75, GAIN_MAX = 1.3;

// Stats d'une image RGBA : ancre de recadrage (centroïde X de la tête, sommet de la
// silhouette) et moyenne/écart-type RGB des pixels du personnage (masque alpha).
export async function analyze(buffer) {
  const img = sharp(buffer).ensureAlpha();
  const meta = await img.metadata();
  const { data, info } = await img.resize({ width: STATS_WIDTH }).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const scale = meta.width / width;

  let minY = height, maxY = -1, count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * channels + 3] > ALPHA_MIN) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
  }
  // coverage ≈ 1 : image opaque (ensureAlpha met tout à 255) → masque inutilisable ;
  // coverage ≈ 0 : pas de personnage détecté.
  const coverage = count / (width * height);
  if (maxY < 0 || coverage < 0.02 || coverage > 0.95) return { w: meta.width, h: meta.height, usable: false, coverage };

  const bandEnd = minY + Math.max(2, Math.round((maxY - minY + 1) * HEAD_BAND));
  let sx = 0, sn = 0, n = 0;
  const sum = [0, 0, 0], sq = [0, 0, 0];
  for (let y = minY; y <= maxY; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * channels;
    if (data[o + 3] <= ALPHA_MIN) continue;
    if (y <= bandEnd) { sx += x; sn++; }
    for (let c = 0; c < 3; c++) { sum[c] += data[o + c]; sq[c] += data[o + c] * data[o + c]; }
    n++;
  }
  const mean = sum.map(s => s / n);
  const std = sq.map((s, c) => Math.sqrt(Math.max(1, s / n - mean[c] * mean[c])));
  return {
    w: meta.width, h: meta.height, usable: true, coverage,
    anchorX: (sx / sn) * scale, topY: minY * scale, mean, std
  };
}

// Gains/offsets linéaires par canal pour ramener `cur` sur `ref` (alpha inchangé).
function colorTransform(ref, cur) {
  const a = [], b = [];
  for (let c = 0; c < 3; c++) {
    const g = Math.min(GAIN_MAX, Math.max(GAIN_MIN, ref.std[c] / cur.std[c]));
    a.push(g);
    b.push(ref.mean[c] - g * cur.mean[c]);
  }
  return { a: [...a, 1], b: [...b, 0] };
}

const KEY_TOLERANCE = 90;   // somme des écarts RGB tolérée vs la couleur de fond échantillonnée
const BORDER = 3;           // épaisseur de l'anneau de bordure servant d'échantillon

// Détourage chroma pour les modèles sans transparence native : la couleur de fond
// est échantillonnée sur les bords, puis retirée par remplissage depuis les bords
// (seules les zones connectées au bord sont effacées — un vêtement de couleur
// proche au centre de l'image n'est pas mangé). Retourne un PNG RGBA.
export async function keyBackground(buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;

  let sr = 0, sg = 0, sb = 0, sn = 0;
  const sample = (x, y) => { const o = (y * W + x) * C; sr += data[o]; sg += data[o + 1]; sb += data[o + 2]; sn++; };
  for (let y = 0; y < BORDER; y++) for (let x = 0; x < W; x++) { sample(x, y); sample(x, H - 1 - y); }
  for (let x = 0; x < BORDER; x++) for (let y = BORDER; y < H - BORDER; y++) { sample(x, y); sample(W - 1 - x, y); }
  const bg = [sr / sn, sg / sn, sb / sn];

  const close = i => {
    const o = i * C;
    return Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2]) <= KEY_TOLERANCE;
  };
  const mask = Buffer.alloc(W * H, 255);
  const queue = new Int32Array(W * H);
  let qt = 0;
  const visit = i => { if (mask[i] === 255 && close(i)) { mask[i] = 0; queue[qt++] = i; } };
  for (let x = 0; x < W; x++) { visit(x); visit((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { visit(y * W); visit(y * W + W - 1); }
  for (let qh = 0; qh < qt; qh++) {
    const i = queue[qh], x = i % W;
    if (x > 0) visit(i - 1);
    if (x < W - 1) visit(i + 1);
    if (i >= W) visit(i - W);
    if (i < (H - 1) * W) visit(i + W);
  }

  // léger flou du masque pour adoucir le bord ; attention, sharp peut renvoyer le
  // raw en multi-canaux → on lit le stride réel dans info
  const { data: alpha, info: ai } = await sharp(mask, { raw: { width: W, height: H, channels: 1 } })
    .blur(0.6).raw().toBuffer({ resolveWithObject: true });
  const stride = ai.channels;
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = data[i * C];
    rgba[i * 4 + 1] = data[i * C + 1];
    rgba[i * 4 + 2] = data[i * C + 2];
    rgba[i * 4 + 3] = alpha[i * stride];
  }
  return sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

// Aligne une frame sur le gabarit : couleur → position → aplatissement sur fond uni.
// Sans alpha exploitable (modèle ayant ignoré le fond transparent), la frame est
// aplatie telle quelle et le reste est sauté.
export async function conform(buffer, refStats, background) {
  const cur = await analyze(buffer);
  const result = { transparent: cur.usable, colorAdjusted: false, shift: null };
  let work = buffer;

  if (cur.usable && refStats?.usable) {
    const t = colorTransform(refStats, cur);
    work = await sharp(work).ensureAlpha().linear(t.a, t.b).png().toBuffer();
    result.colorAdjusted = true;

    const maxShift = Math.round(cur.w * MAX_SHIFT);
    const clamp = v => Math.max(-maxShift, Math.min(maxShift, Math.round(v)));
    const dx = clamp(refStats.anchorX - cur.anchorX);
    const dy = clamp(refStats.topY - cur.topY);
    if (dx || dy) {
      // extend puis extract doivent être deux pipelines séparés : dans un même
      // pipeline sharp, extract est appliqué avant extend.
      const bgT = { r: 0, g: 0, b: 0, alpha: 0 };
      const extended = await sharp(work)
        .extend({ left: Math.max(0, dx), right: Math.max(0, -dx), top: Math.max(0, dy), bottom: Math.max(0, -dy), background: bgT })
        .png().toBuffer();
      work = await sharp(extended)
        .extract({ left: Math.max(0, -dx), top: Math.max(0, -dy), width: cur.w, height: cur.h })
        .png().toBuffer();
      result.shift = { dx, dy };
    }
  }

  result.buffer = await sharp(work).flatten({ background }).png().toBuffer();
  return result;
}
