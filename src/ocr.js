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

// Grayscale + contrast stretch at a size Tesseract likes. Returns a canvas.
export async function preprocess(blob, maxSide = 2000) {
  const img = await loadImage(blob);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const gray = new Uint8ClampedArray(w * h);
  let lo = 255; let hi = 0;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const g = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
    gray[j] = g;
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = ((gray[j] - lo) * 255) / range;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

export function ocrSupported() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function';
}

// Returns { text, parsed }. onProgress receives 0..1 while recognising.
export async function readReceipt(blob, { dateFormat = 'DMY', onProgress } = {}) {
  progressHandler = (m) => {
    if (!onProgress) return;
    if (m.status === 'recognizing text') onProgress({ stage: 'reading', progress: m.progress });
    else if (/loading|initializ/i.test(m.status || '')) onProgress({ stage: 'loading', progress: m.progress });
  };
  const worker = await getWorker();
  const canvas = await preprocess(blob);
  const { data } = await worker.recognize(canvas);
  return { text: data.text, parsed: parseReceiptText(data.text, { dateFormat }) };
}
