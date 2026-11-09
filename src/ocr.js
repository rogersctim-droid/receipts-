// On-device OCR with Tesseract.js (vendored under /vendor/tesseract, nothing leaves the phone).
import { parseReceiptText } from './ocr-parse.js';

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;
let workerPromise = null;
let progressHandler = () => {};
let lastStage = 'starting';

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s (last step: ${lastStage})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      lastStage = 'loading engine script';
      const mod = await import('../vendor/tesseract/tesseract.esm.min.js');
      const { createWorker, PSM } = mod.default || mod;
      lastStage = 'starting worker';
      const worker = await withTimeout(createWorker('eng', 1, {
        workerPath: `${BASE}worker.min.js`,
        corePath: `${BASE}core`,
        langPath: `${BASE}lang`,
        gzip: true,
        // Load the worker script directly rather than via a blob: URL; blob workers are
        // unreliable in some iOS home-screen web apps.
        workerBlobURL: false,
        logger: (m) => { if (m && m.status) lastStage = m.status; progressHandler(m); },
      }), 120000, 'Loading the receipt reader');
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_COLUMN, preserve_interword_spaces: '1' });
      return worker;
    })().catch((err) => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// Start loading the engine in the background so the first photo does not wait for a 7 MB download.
export function preloadOcr() {
  if (!ocrSupported() || workerPromise) return;
  if (navigator.connection && navigator.connection.saveData) return;
  getWorker().catch(() => { /* reported when the user actually takes a photo */ });
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
export async function preprocess(blob, target = 2200, { threshold = true } = {}) {
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
  for (let j = 0; j < n; j++) gray[j] = Math.max(0, Math.min(255, ((gray[j] - lo) * 255) / range));
  if (!threshold) {
    for (let i = 0, j = 0; i < px.length; i += 4, j++) px[i] = px[i + 1] = px[i + 2] = gray[j];
    ctx.putImageData(data, 0, 0);
    return canvas;
  }

  // Adaptive threshold (Bradley): compare each pixel with the mean of its neighbourhood so that
  // shadows and curled paper do not turn half the receipt black. Uses an integral image.
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) {
      row += gray[(y - 1) * w + (x - 1)];
      integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row;
    }
  }
  const win = Math.max(15, Math.round(Math.min(w, h) / 12));
  const half = win >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half); const y1 = Math.min(h - 1, y + half);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half); const x1 = Math.min(w - 1, x + half);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)]
        - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const j = y * w + x;
      const v = gray[j] * count < sum * 0.85 ? 0 : 255;
      const i = j * 4;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
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
// First pass: adaptive-thresholded image, single-column layout (good for shadows and curled
// paper). If that finds little, second pass: plain grayscale, single block (better for
// stylised logos and clean photos). The more useful result wins.
export async function readReceipt(blob, { dateFormat = 'DMY', onProgress } = {}) {
  progressHandler = (m) => {
    if (!onProgress || !m) return;
    if (m.status === 'recognizing text') onProgress({ stage: 'reading', progress: m.progress });
    else if (/loading|initializ/i.test(m.status || '')) onProgress({ stage: 'loading', progress: m.progress, detail: m.status });
  };
  if (onProgress) onProgress({ stage: workerPromise ? 'preparing' : 'loading', progress: 0, detail: lastStage });
  const worker = await getWorker();
  const { PSM } = (await import('../vendor/tesseract/tesseract.esm.min.js')).default;
  const attempts = [];
  const passes = [
    { mode: PSM.SINGLE_COLUMN, threshold: true },
    { mode: PSM.SINGLE_BLOCK, threshold: false },
  ];
  for (const pass of passes) {
    lastStage = 'preparing image';
    const canvas = await preprocess(blob, 2200, { threshold: pass.threshold });
    lastStage = 'recognising';
    await worker.setParameters({ tessedit_pageseg_mode: pass.mode });
    const { data } = await withTimeout(worker.recognize(canvas), 120000, 'Reading the receipt');
    const parsed = parseReceiptText(data.text, { dateFormat });
    attempts.push({ ...pass, text: data.text, confidence: data.confidence, parsed });
    if (usefulness(parsed) >= 4) break;
  }
  attempts.sort((a, b) => usefulness(b.parsed) - usefulness(a.parsed) || b.confidence - a.confidence);
  const best = attempts[0];
  return { text: best.text, confidence: best.confidence, parsed: best.parsed, attempts: attempts.length };
}
