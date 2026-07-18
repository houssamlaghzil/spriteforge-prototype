
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import JSZip from "jszip";
import { MongoClient } from "mongodb";
import { Client as MinioClient } from "minio";
import { analyze, conform, keyBackground } from "./postprocess.mjs";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.use(express.static("public"));

const PRICES = {
  "gpt-image-2": { low:[.006,.005,.005], medium:[.053,.041,.041], high:[.211,.165,.165] },
  "gpt-image-1.5": { low:[.009,.013,.013], medium:[.034,.05,.05], high:[.133,.2,.2] },
  "gpt-image-1": { low:[.011,.016,.016], medium:[.042,.063,.063], high:[.167,.25,.25] },
  "gpt-image-1-mini": { low:[.005,.006,.006], medium:[.011,.015,.015], high:[.036,.052,.052] }
};
const SIZES = ["1024x1024","1024x1536","1536x1024"];
const CONCURRENCY = 5;          // requêtes OpenAI simultanées max
const FRAME_ATTEMPTS = 2;       // tentatives par frame (en plus des retries internes du SDK sur 429/5xx)
const JOB_TTL_MS = 30 * 60 * 1000;

const DEFAULT_BG = "#6b7a96";
const TEMPLATE_TTL_MS = 60 * 60 * 1000;

const jobs = new Map();
const templates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  for (const [id, t] of templates) if (now - t.createdAt > TEMPLATE_TTL_MS) templates.delete(id);
}, 60_000).unref();

// Persistance optionnelle : sans MONGO_URL / MINIO_ENDPOINT, l'app fonctionne
// à l'identique mais sans mémoire (utile pour un simple `npm start` local).
const MINIO_BUCKET = process.env.MINIO_BUCKET || "spriteforge";
let db = null, minio = null;

async function initPersistence() {
  if (process.env.MONGO_URL) {
    try {
      const c = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 5000 });
      await c.connect();
      db = c.db();
      await db.command({ ping: 1 });
      console.log(`[SpriteForge] MongoDB connecté (base "${db.databaseName}").`);
    } catch (e) { console.warn("[SpriteForge] MongoDB indisponible — historique désactivé :", e?.message); }
  } else console.log("[SpriteForge] MONGO_URL non défini — enregistrement MongoDB désactivé.");
  if (process.env.MINIO_ENDPOINT) {
    try {
      const c = new MinioClient({
        endPoint: process.env.MINIO_ENDPOINT,
        port: Number(process.env.MINIO_PORT) || 9000,
        useSSL: process.env.MINIO_USE_SSL === "true",
        accessKey: process.env.MINIO_ACCESS_KEY || "",
        secretKey: process.env.MINIO_SECRET_KEY || ""
      });
      if (!(await c.bucketExists(MINIO_BUCKET))) await c.makeBucket(MINIO_BUCKET);
      minio = c;
      console.log(`[SpriteForge] MinIO connecté (bucket "${MINIO_BUCKET}").`);
    } catch (e) { console.warn("[SpriteForge] MinIO indisponible — archivage désactivé :", e?.message); }
  } else console.log("[SpriteForge] MINIO_ENDPOINT non défini — archivage MinIO désactivé.");
}

async function persistJob(job, { model, quality, size, emotion, style, frames, usages, out, sprite, estimateUsd, template, bg, pp }) {
  if (!db && !minio) return;
  job.phase = "archive";
  const okFrames = out.map((b, i) => (b ? [i, b] : null)).filter(Boolean);
  let stored = 0;
  if (minio) {
    try {
      for (const [i, b] of okFrames) {
        await minio.putObject(MINIO_BUCKET, `${job.id}/frames/frame-${String(i + 1).padStart(3, "0")}.png`, b, b.length, { "Content-Type": "image/png" });
        stored++;
      }
      if (sprite) {
        await minio.putObject(MINIO_BUCKET, `${job.id}/sprite-sheet.png`, sprite, sprite.length, { "Content-Type": "image/png" });
        stored++;
      }
      if (template) {
        await minio.putObject(MINIO_BUCKET, `${job.id}/template.png`, template.buffer, template.buffer.length, { "Content-Type": "image/png" });
        stored++;
      }
      if (job.zip) {
        await minio.putObject(MINIO_BUCKET, `${job.id}/archive.zip`, job.zip, job.zip.length, { "Content-Type": "application/zip" });
        stored++;
      }
      // mini sprite sheet (frames 128 px) pour l'animation au survol dans la Bibliothèque
      if (sprite && job.sheet) {
        const pw = 128, ph = Math.round(job.sheet.h * 128 / job.sheet.w);
        const smalls = [];
        for (const [, b] of okFrames) smalls.push(await sharp(b).resize(pw, ph).png().toBuffer());
        const preview = await sheet(smalls, pw, ph);
        await minio.putObject(MINIO_BUCKET, `${job.id}/sprite-preview.png`, preview, preview.length, { "Content-Type": "image/png" });
        job.previewSheet = { cols: Math.ceil(Math.sqrt(smalls.length)), rows: Math.ceil(smalls.length / Math.ceil(Math.sqrt(smalls.length))), w: pw, h: ph, count: smalls.length };
        stored++;
      }
      jlog(job, "info", `${stored} objet(s) archivé(s) dans MinIO (bucket "${MINIO_BUCKET}", préfixe "${job.id}/").`);
    } catch (e) { jlog(job, "warn", `Archivage MinIO impossible : ${e?.message}`); }
  }
  if (db) {
    try {
      await db.collection("generations").insertOne({
        jobId: job.id, createdAt: new Date(), status: job.error ? "failed" : "done", error: job.error,
        model, quality, size, emotion, style,
        framesRequested: frames, framesCompleted: okFrames.length,
        durationMs: Date.now() - job.startedAt, officialOutputEstimateUsd: estimateUsd, apiUsage: usages,
        background: template ? bg : null,
        template: template ? { id: template.id, params: template.params } : null,
        postProcessing: pp,
        zipName: job.zipName, sheet: job.sheet || null, previewSheet: job.previewSheet || null,
        storage: minio ? {
          bucket: MINIO_BUCKET, prefix: `${job.id}/`, objects: stored,
          hasZip: !!job.zip, hasSprite: !!sprite, hasPreview: !!job.previewSheet, hasTemplate: !!template
        } : null
      });
      jlog(job, "info", `Génération enregistrée dans MongoDB (collection "generations").`);
    } catch (e) { jlog(job, "warn", `Enregistrement MongoDB impossible : ${e?.message}`); }
  }
}

// persistJob ne rejette jamais, mais un service qui ne répond pas ne doit pas bloquer le job.
function persistWithTimeout(job, data) {
  return Promise.race([
    persistJob(job, data),
    new Promise(r => setTimeout(r, 30_000)).then(() => jlog(job, "warn", "Archivage trop long — le job continue sans attendre."))
  ]);
}

function jlog(job, level, text) {
  job.logs.push({ t: Date.now(), level, text });
  job.updatedAt = Date.now();
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[job ${job.id.slice(0, 8)}] ${text}`);
}

// 400/401/403/404… : rejouer ne changera rien. 429, 5xx, timeouts et erreurs réseau : oui.
function isRetryable(e) {
  const s = e?.status;
  return !(typeof s === "number" && s >= 400 && s < 429);
}

// Tous les modèles n'acceptent pas les mêmes paramètres (ex. gpt-image-2 et
// gpt-image-1-mini refusent input_fidelity). Plutôt qu'une liste figée, on
// apprend des erreurs « does not support the 'x' parameter » et on retire le
// paramètre pour toute la suite de la session.
const unsupportedParams = new Map([
  ["gpt-image-2", new Set(["input_fidelity"])],
  ["gpt-image-1-mini", new Set(["input_fidelity"])]
]);

function paramSupported(model, param) {
  return !unsupportedParams.get(model)?.has(param);
}

async function imagesEdit(client, model, params, opts) {
  for (;;) {
    const p = { ...params };
    for (const k of unsupportedParams.get(model) || []) delete p[k];
    try {
      return await client.images.edit(p, opts);
    } catch (e) {
      const m = /does not support the '([^']+)' parameter/.exec(e?.message || "");
      if (e?.status === 400 && m && paramSupported(model, m[1])) {
        if (!unsupportedParams.has(model)) unsupportedParams.set(model, new Set());
        unsupportedParams.get(model).add(m[1]);
        console.warn(`[SpriteForge] Le modèle ${model} ne supporte pas '${m[1]}' — paramètre retiré pour la suite.`);
        continue;
      }
      throw e;
    }
  }
}

const EMOTIONS = {
  neutral:"cold, composed, emotionally restrained, versatile; no permanent smile; suitable for positive or negative dialogue",
  joyful:"subtly upbeat and engaged, restrained warmth, occasional slight smile, never exaggerated",
  angry:"controlled irritation, slight brow tension, firmer mouth, sharper restrained gestures, never screaming"
};
const STYLE_LINE = "Clean production-ready 2D game dialogue illustration, crisp facial features, precise glasses, stable anatomy, controlled cel shading, cool neutral lighting, no warm cast, no painterly blur.";
const IDENTITY_LOCK = "ABSOLUTE IDENTITY LOCK: preserve exactly the same person, face geometry, skull, eyes, pupils, eyebrows, nose, jawline, hair, glasses, clothing, accessories, body proportions and age. Do not redesign.";
const BG_TRANSPARENT = "BACKGROUND: fully transparent background (alpha channel), no background elements, no shadow cast on the background.";

// Modèles qui ne rendent pas la transparence (gpt-image-2 confirmé en production).
// Pour eux : teinte exacte du fond imposée dans le prompt, puis détourage chroma
// côté serveur. Complété dynamiquement si un modèle renvoie des images sans alpha.
const opaqueModels = new Set(["gpt-image-2"]);

function solidBgLine(bg) {
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  return `BACKGROUND: perfectly flat, uniform, solid matte background filled with the exact color ${bg} (RGB ${r}, ${g}, ${b}) everywhere, absolutely even, no gradient, no vignetting, no texture, no noise, no lighting variation, no shadow cast on the background.`;
}

function bgLineFor(model, bg) {
  return opaqueModels.has(model) ? solidBgLine(bg) : BG_TRANSPARENT;
}

function templatePrompt({emotion, style, bgLine}) {
  return `EDIT THE PROVIDED CHARACTER REFERENCE into the canonical master frame of a dialogue animation.
${IDENTITY_LOCK}
STYLE: ${style}. ${STYLE_LINE}
CAMERA: fixed medium waist-up framing, eye-level, 70–85mm equivalent; the character is perfectly centered horizontally, top of the head at roughly 8% from the top edge, torso and pelvis fixed.
EMOTION: ${EMOTIONS[emotion] || EMOTIONS.neutral}.
POSE: neutral resting pose — closed resting lips, eyes open, hands resting naturally, subtle breathing only.
${bgLine}
AVOID: blurry face, identity drift, warped glasses, misaligned pupils, changing jaw/nose/hair/clothes, malformed hands, extra fingers, duplicate limbs, excessive smiling, motion blur, captions.`;
}

function promptFor({emotion, i, total, style, bgLine}) {
  const emotions = EMOTIONS;
  const mouths=["closed resting lips","small neutral opening","subtle A phoneme","subtle E phoneme","small O phoneme","lightly compressed lips","small conversational opening","almost closed transition"];
  const t = total <= 1 ? 0 : i/(total-1);
  const cycle=t*Math.PI*2;
  const hand=Math.round(Math.max(0,Math.sin(cycle))*100);
  const other=Math.round(Math.max(0,-Math.sin(cycle))*70);
  const head=Math.round(Math.sin(cycle+.4)*3);
  const blink=i%Math.max(10,Math.round(total/3));
  const eyes=blink===1?"eyelids slightly lowering":blink===2?"brief natural blink, eyes closed":blink===3?"eyelids reopening":"eyes open";
  return `EDIT THE PROVIDED CHARACTER REFERENCE. Frame ${i+1}/${total} of ONE continuous dialogue animation.
ABSOLUTE IDENTITY LOCK: preserve exactly the same person, face geometry, skull, eyes, pupils, eyebrows, nose, jawline, hair, glasses, clothing, accessories, body proportions and age. Do not redesign.
STYLE: ${style}. Clean production-ready 2D game dialogue illustration, crisp facial features, precise glasses, stable anatomy, controlled cel shading, cool neutral lighting, no warm cast, no painterly blur.
CAMERA: fixed medium waist-up framing, eye-level, 70–85mm equivalent, identical scale and anchor, torso and pelvis fixed, no zoom or perspective change.
EMOTION: ${emotions[emotion] || emotions.neutral}.
EXACT FRAME STATE:
- mouth: ${mouths[i%mouths.length]}
- eyes: ${eyes}
- head: subtle ${head>=0?"right":"left"} inclination ${Math.abs(head)} degrees
- primary hand gesture: ${hand}% of a restrained explanatory gesture
- secondary hand: ${other}% of a subtle counter-gesture
- subtle breathing only
TEMPORAL CONTINUITY: this must look like the immediate next video frame of the provided reference, not a new pose. Tiny deltas only. No jump cut, random pose, face morphing, jitter or camera movement.
${bgLine || "BACKGROUND: plain cool neutral studio background, identical lighting, no text or props."}
AVOID: blurry face, identity drift, warped glasses, misaligned pupils, changing jaw/nose/hair/clothes, malformed hands, extra fingers, duplicate limbs, excessive smiling, theatrical gestures, motion blur, captions.`;
}

async function sheet(buffers,w,h){
  const cols=Math.ceil(Math.sqrt(buffers.length));
  const rows=Math.ceil(buffers.length/cols);
  return sharp({create:{width:cols*w,height:rows*h,channels:4,background:{r:0,g:0,b:0,alpha:0}},limitInputPixels:false})
    .composite(buffers.map((b,i)=>({input:b,left:(i%cols)*w,top:Math.floor(i/cols)*h})))
    .png({compressionLevel:9}).toBuffer();
}

async function runJob(job, { client, ref, model, quality, size, emotion, style, frames, template, bg }) {
  const [w, h] = size.split("x").map(Number);
  const out = new Array(frames), usages = [];
  const controller = new AbortController();
  const transparent = !!template;
  const pp = transparent ? { recentered: 0, colorAdjusted: 0, noAlpha: 0, keyed: 0 } : null;
  let next = 0, fatal = null;

  try {
    const image = await toFile(ref, "character.png", { type: "image/png" });
    jlog(job, "info", `Génération de ${frames} frames (${model}, qualité ${quality}, ${size}) — ${Math.min(CONCURRENCY, frames)} requêtes en parallèle${transparent ? `, ancrées sur le gabarit ${template.id.slice(0, 8)}` : ""}.`);

    const frameTask = async (i) => {
      for (let attempt = 1; attempt <= FRAME_ATTEMPTS; attempt++) {
        const t0 = Date.now();
        try {
          const r = await imagesEdit(client, model,
            {
              model, image, prompt: promptFor({ emotion, i, total: frames, style, bgLine: transparent ? bgLineFor(model, bg) : null }), size, quality, n: 1, output_format: "png",
              ...(transparent && !opaqueModels.has(model) ? { background: "transparent" } : {}),
              ...(transparent ? { input_fidelity: "high" } : {})
            },
            { signal: controller.signal }
          );
          const b64 = r.data?.[0]?.b64_json;
          if (!b64) throw new Error("réponse sans image");
          let final = Buffer.from(b64, "base64"), detail = "";
          if (transparent) {
            const pre = await analyze(final);
            if (!pre.usable) {
              if (!opaqueModels.has(model)) {
                opaqueModels.add(model);
                jlog(job, "warn", `Le modèle ${model} ne rend pas la transparence — détourage chroma activé pour la suite.`);
              }
              final = await keyBackground(final);
              pp.keyed++;
              detail = " · détourée (chroma)";
            }
            const c = await conform(final, template.stats, bg);
            final = c.buffer;
            if (!c.transparent) { pp.noAlpha++; jlog(job, "warn", `Frame ${i + 1} : pas d'alpha exploitable, recadrage/normalisation sautés.`); }
            if (c.colorAdjusted) pp.colorAdjusted++;
            if (c.shift) { pp.recentered++; detail += ` · recalée de ${c.shift.dx}/${c.shift.dy} px`; }
          }
          out[i] = await sharp(final).resize(w, h, { fit: "cover" }).png().toBuffer();
          if (r.usage) usages.push(r.usage);
          job.done++;
          jlog(job, "info", `Frame ${i + 1}/${frames} générée en ${((Date.now() - t0) / 1000).toFixed(1)} s (${job.done}/${frames})${detail}.`);
          return;
        } catch (e) {
          if (controller.signal.aborted) return;
          const detail = e?.status ? `HTTP ${e.status} — ${e?.message}` : (e?.message || String(e));
          if (attempt < FRAME_ATTEMPTS && isRetryable(e)) {
            jlog(job, "warn", `Frame ${i + 1} : échec (${detail}), nouvelle tentative dans 2 s…`);
            await new Promise(r => setTimeout(r, 2000));
          } else {
            throw new Error(`Frame ${i + 1} : ${detail}`);
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, frames) }, async () => {
      while (!fatal) {
        const i = next++;
        if (i >= frames) return;
        try { await frameTask(i); }
        catch (e) { if (!fatal) { fatal = e; controller.abort(); } }
      }
    }));
    if (fatal) throw fatal;

    job.phase = "assembly";
    jlog(job, "info", "Assemblage de la sprite sheet et du ZIP…");
    const sprite = await sheet(out, w, h);
    const estimateUsd = PRICES[model][quality][SIZES.indexOf(size)] * frames;
    const z = new JSZip();
    out.forEach((b, i) => z.file(`frames/frame-${String(i + 1).padStart(3, "0")}.png`, b));
    z.file("sprite-sheet.png", sprite);
    z.file("manifest.json", JSON.stringify({
      model, quality, size, frames, emotion,
      officialOutputEstimateUsd: estimateUsd,
      note: "Le coût exact total inclut aussi les tokens d'entrée image et texte facturés par OpenAI pour l'édition.",
      background: transparent ? bg : null,
      template: transparent ? { id: template.id, params: template.params } : null,
      postProcessing: pp,
      apiUsage: usages
    }, null, 2));
    job.zip = await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    job.zipName = `spriteforge-${frames}-frames.zip`;
    job.sprite = sprite;
    job.sheet = { cols: Math.ceil(Math.sqrt(frames)), rows: Math.ceil(frames / Math.ceil(Math.sqrt(frames))), w, h, count: frames };
    if (transparent) jlog(job, "info", `Post-traitement : ${pp.recentered} frame(s) recalée(s), ${pp.colorAdjusted} normalisée(s) en couleur${pp.keyed ? `, ${pp.keyed} détourée(s) au chroma` : ""}${pp.noAlpha ? `, ${pp.noAlpha} sans alpha` : ""}.`);
    await persistWithTimeout(job, { model, quality, size, emotion, style, frames, usages, out, sprite, estimateUsd, template, bg, pp });
    job.durationMs = Date.now() - job.startedAt;
    job.status = "done";
    jlog(job, "info", `Terminé en ${Math.round(job.durationMs / 1000)} s. ZIP prêt (${(job.zip.length / 1e6).toFixed(1)} Mo).`);
  } catch (e) {
    job.error = e?.message || "Erreur inconnue";
    jlog(job, "error", `Génération interrompue : ${job.error}`);
    // Les frames déjà générées ont été payées : on les rend téléchargeables quand même.
    const okFrames = out.map((b, i) => b && [i, b]).filter(Boolean);
    if (okFrames.length) {
      try {
        const z = new JSZip();
        okFrames.forEach(([i, b]) => z.file(`frames/frame-${String(i + 1).padStart(3, "0")}.png`, b));
        z.file("manifest.json", JSON.stringify({
          model, quality, size, frames, emotion, framesCompleted: okFrames.length, error: job.error, apiUsage: usages
        }, null, 2));
        job.zip = await z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
        job.zipName = `spriteforge-partiel-${okFrames.length}-frames.zip`;
        jlog(job, "warn", `${okFrames.length} frame(s) déjà générée(s) restent téléchargeables.`);
      } catch (ze) {
        jlog(job, "error", `Impossible de créer le ZIP partiel : ${ze?.message}`);
      }
    }
    await persistWithTimeout(job, { model, quality, size, emotion, style, frames, usages, out, sprite: null, estimateUsd: null, template, bg, pp });
    job.status = "failed";
  }
}

app.post("/api/template", upload.single("image"), async (req, res) => {
  try {
    const { apiKey, model = "gpt-image-2", quality = "medium", size = "1024x1024", emotion = "neutral", style = "" } = req.body;
    if (!req.file) return res.status(400).json({ error: "Image manquante." });
    if (!apiKey?.startsWith("sk-")) return res.status(400).json({ error: "Clé API invalide." });
    if (!PRICES[model] || !["low","medium","high"].includes(quality) || !SIZES.includes(size))
      return res.status(400).json({ error: "Configuration invalide." });

    const bg = /^#[0-9a-fA-F]{6}$/.test(req.body.bg || "") ? req.body.bg : DEFAULT_BG;
    const ref = await sharp(req.file.buffer).rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const client = new OpenAI({ apiKey, timeout: 240_000 });
    const image = await toFile(ref, "character.png", { type: "image/png" });
    const t0 = Date.now();
    console.log(`[SpriteForge] Génération d'un gabarit (${model}, qualité ${quality}, ${size})…`);
    const r = await imagesEdit(client, model, {
      model, image, prompt: templatePrompt({ emotion, style, bgLine: bgLineFor(model, bg) }), size, quality, n: 1, output_format: "png",
      ...(opaqueModels.has(model) ? {} : { background: "transparent" }),
      input_fidelity: "high"
    });
    const b64 = r.data?.[0]?.b64_json;
    if (!b64) throw new Error("réponse sans image");
    let buffer = Buffer.from(b64, "base64"), keyed = false;
    let stats = await analyze(buffer);
    if (!stats.usable) {
      if (!opaqueModels.has(model)) {
        opaqueModels.add(model);
        console.warn(`[SpriteForge] Le modèle ${model} ne rend pas la transparence — détourage chroma activé.`);
      }
      buffer = await keyBackground(buffer);
      stats = await analyze(buffer);
      keyed = true;
    }
    const id = crypto.randomUUID();
    templates.set(id, { id, buffer, stats, usage: r.usage || null, createdAt: Date.now(), params: { model, quality, size, emotion, style } });
    console.log(`[SpriteForge] Gabarit ${id.slice(0, 8)} prêt en ${((Date.now() - t0) / 1000).toFixed(1)} s (alpha : ${stats.usable ? "oui" : "non"}${keyed ? ", détouré au chroma" : ""}).`);
    if (!stats.usable) console.warn("[SpriteForge] Gabarit sans alpha exploitable — recadrage et normalisation couleur seront limités.");
    res.json({ templateId: id, usable: stats.usable, keyed, usage: r.usage || null, inputFidelity: paramSupported(model, "input_fidelity") });
  } catch (e) {
    const detail = e?.status ? `HTTP ${e.status} — ${e?.message}` : (e?.message || "Erreur inconnue");
    console.error("[SpriteForge] Échec de la génération du gabarit :", detail);
    res.status(500).json({ error: `Gabarit : ${detail}` });
  }
});

app.get("/api/template/:id/image", (req, res) => {
  const t = templates.get(req.params.id);
  if (!t) return res.status(404).json({ error: "Gabarit inconnu ou expiré." });
  res.setHeader("Content-Type", "image/png");
  res.send(t.buffer);
});

app.post("/api/generate", upload.single("image"), async (req, res) => {
  try {
    const { apiKey, model = "gpt-image-2", quality = "medium", size = "1024x1024", emotion = "neutral", style = "" } = req.body;
    const frames = Number(req.body.frames || 24);
    if (!req.file) return res.status(400).json({ error: "Image manquante." });
    if (!apiKey?.startsWith("sk-")) return res.status(400).json({ error: "Clé API invalide." });
    if (!PRICES[model] || !["low","medium","high"].includes(quality) || !SIZES.includes(size) || ![24,45,100].includes(frames))
      return res.status(400).json({ error: "Configuration invalide." });

    let template = null;
    if (req.body.templateId) {
      template = templates.get(req.body.templateId);
      if (!template) return res.status(400).json({ error: "Gabarit inconnu ou expiré — régénère le gabarit." });
    }
    const bg = /^#[0-9a-fA-F]{6}$/.test(req.body.bg || "") ? req.body.bg : DEFAULT_BG;
    const ref = template
      ? template.buffer
      : await sharp(req.file.buffer).rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const client = new OpenAI({ apiKey, timeout: 240_000 });
    const id = crypto.randomUUID();
    const job = { id, status: "running", phase: "generation", total: frames, done: 0, logs: [], zip: null, zipName: null, error: null, durationMs: null, startedAt: Date.now(), updatedAt: Date.now() };
    jobs.set(id, job);
    runJob(job, { client, ref, model, quality, size, emotion, style, frames, template, bg }).catch(e => {
      job.status = "failed";
      job.error = e?.message || "Erreur inconnue";
      console.error(`[job ${id.slice(0, 8)}] Erreur inattendue :`, e);
    });
    res.json({ jobId: id, total: frames });
  } catch (e) {
    console.error("[SpriteForge] Échec du démarrage de la génération :", e);
    res.status(500).json({ error: e?.message || "Erreur inconnue" });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job inconnu ou expiré." });
  const { zip, sprite, ...pub } = job;
  res.json({ ...pub, hasZip: !!zip });
});

app.get("/api/jobs/:id/sprite", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.sprite) return res.status(404).json({ error: "Sprite sheet indisponible pour ce job." });
  res.setHeader("Content-Type", "image/png");
  res.send(job.sprite);
});

app.get("/api/generations", async (req, res) => {
  if (!db) return res.status(503).json({ error: "MongoDB non configuré (MONGO_URL) — pas d'historique." });
  try {
    const list = await db.collection("generations").find({}, { projection: { apiUsage: 0 } }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e?.message || "Erreur MongoDB" });
  }
});

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function streamObject(res, key, headers) {
  try {
    const stream = await minio.getObject(MINIO_BUCKET, key);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (e) {
    res.status(e?.code === "NoSuchKey" ? 404 : 500).json({ error: e?.code === "NoSuchKey" ? "Objet introuvable dans MinIO." : (e?.message || "Erreur MinIO") });
  }
}

async function minioBuffer(key) {
  const stream = await minio.getObject(MINIO_BUCKET, key);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function assetRoute(handler) {
  return async (req, res) => {
    if (!minio) return res.status(503).json({ error: "MinIO non configuré — pas d'archive." });
    if (!JOB_ID_RE.test(req.params.id)) return res.status(400).json({ error: "Identifiant invalide." });
    await handler(req, res);
  };
}

app.get("/api/generations/:id/zip", assetRoute(async (req, res) => {
  let name = `spriteforge-${req.params.id.slice(0, 8)}.zip`;
  if (db) {
    try {
      const d = await db.collection("generations").findOne({ jobId: req.params.id }, { projection: { zipName: 1 } });
      if (d?.zipName) name = d.zipName;
    } catch {}
  }
  await streamObject(res, `${req.params.id}/archive.zip`, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"` });
}));

app.get("/api/generations/:id/sprite", assetRoute((req, res) =>
  streamObject(res, `${req.params.id}/sprite-sheet.png`, { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" })));

app.get("/api/generations/:id/preview", assetRoute((req, res) =>
  streamObject(res, `${req.params.id}/sprite-preview.png`, { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" })));

app.get("/api/generations/:id/thumb", assetRoute(async (req, res) => {
  try {
    let buf;
    try { buf = await minioBuffer(`${req.params.id}/template.png`); }
    catch { buf = await minioBuffer(`${req.params.id}/frames/frame-001.png`); }
    const out = await sharp(buf).resize({ width: 360 }).webp({ quality: 82 }).toBuffer();
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(out);
  } catch {
    res.status(404).json({ error: "Vignette indisponible." });
  }
}));

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.zip) return res.status(404).json({ error: "Aucune archive disponible pour ce job." });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${job.zipName}"`);
  res.send(job.zip);
});

const PORT = Number(process.env.PORT) || 3000;
await initPersistence();
app.listen(PORT, () => console.log(`SpriteForge: http://localhost:${PORT}`));
