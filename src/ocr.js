// On-device OCR with Tesseract.js (vendored under /vendor/tesseract, nothing leaves the phone).
import { parseReceiptText } from './ocr-parse.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;
let workerPromise = null;
let progressHandler = () => {};

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const mod = await import('../vendor/tesseract/tesseract.esm.min.js');
      const { createWorker, PSM } = mod.default || mod;
      const worker = await createWorker('eng', 1, {
        workerPath: `${BASE}worker.min.js`,
        corePath: `${BASE}core`,
        langPath: `${BASE}lang`,
        gzip: true,
        logger: (m) => progressHandler(m),
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN, preserve_interword_spaces: '1' });
      return worker;
    })().catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

// Grayscale + percentile contrast stretch at a size Tesseract likes. Returns a canvas.
// Receipts are scaled so the longest side is about `target` px: small photos are upscaled,
// large ones downscaled, since Tesseract wants text roughly 20-40 px tall.
export async function preprocess(blob, target = 2200) {
  const img = await loadImage(blob);
  const scale = target / Math.max(img.naturalWidth, img.naturalHeight);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const gray = new Uint8ClampedArray(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    gray[j] = g;
    hist[g | 0] += 1;
  }
  // Stretch between the 2nd and 98th percentile so a few stray dark/bright pixels do not defeat it.
  const n = w * h;
  let lo = 0; let hi = 255; let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, ((gray[j] - lo) * 255) / range));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

export function ocrSupported() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

function usefulness(parsed) {
  return (parsed.total != null ? 2 : 0) + (parsed.date ? 1 : 0) + (parsed.merchant ? 1 : 0) + (parsed.tax != null ? 1 : 0);
}

// Returns { text, confidence, parsed, attempts }. onProgress receives { stage, progress }.
// Tries single-column segmentation first; if little comes back, retries treating the
// receipt as one uniform block, which copes better with skewed or curled paper.
export async function readReceipt(blob, { dateFormat = 'DMY', onProgress } = {}) {
  progressHandler = (m) => {
    if (!onProgress) return;
    if (m.status === 'recognizing text') onProgress({ stage: 'reading', progress: m.progress });
    else if (/loading|initializ/i.test(m.status || '')) onProgress({ stage: 'loading', progress: m.progress });
  };
  const worker = await getWorker();
  const { PSM } = (await import('../vendor/tesseract/tesseract.esm.min.js')).default;
  const canvas = await preprocess(blob);
  const attempts = [];
  for (const mode of [PSM.SINGLE_COLUMN, PSM.SINGLE_BLOCK]) {
    await worker.setParameters({ tessedit_pageseg_mode: mode });
    const { data } = await worker.recognize(canvas);
    const parsed = parseReceiptText(data.text, { dateFormat });
    attempts.push({ mode, text: data.text, confidence: data.confidence, parsed });
    if (usefulness(parsed) >= 3) break;
  }
  attempts.sort((a, b) => usefulness(b.parsed) - usefulness(a.parsed) || b.confidence - a.confidence);
  const best = attempts[0];
  return { text: best.text, confidence: best.confidence, parsed: best.parsed, attempts: attempts.length };
}
