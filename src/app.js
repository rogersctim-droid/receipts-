import { db } from './db.js';
import {
  REGIONS, CATEGORIES, PAY_METHODS, defaultSettings, categoryLabel, money, taxFromGross, imageFileName,
  billsCsv, invoiceCsv, claimCsv, summarize, filterReceipts, formatXeroDate, round2,
} from './export.js';
import { buildZip } from './zip.js';
import { readReceipt, ocrSupported, preloadOcr } from './ocr.js';

export const APP_VERSION = '1.2.0';

const $ = (sel) => document.querySelector(sel);
const state = {
  receipts: [],
  settings: null,
  currentId: null,
  pendingImage: null, // { full: Blob, thumb: Blob } for a receipt not yet saved
  taxTouched: false,
  initialValues: null, // field values when the form opened; OCR only fills fields still at these values
  openSnapshot: null, // every field as it was when the form opened, for the unsaved-changes check
  ocrToken: 0,
  followup: null, // { kind: 'xero'|'claim', receipts, text } after an export
  previousView: 'capture',
  view: 'capture',
  thumbUrls: new Map(),
};

// ---------- utilities ----------
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function fmtMoney(n, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || state.settings.currency }).format(Number(n) || 0);
  } catch { return `${money(n)} ${currency || ''}`; }
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
async function deliver(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return 'shared'; } catch (err) { if (err.name === 'AbortError') return 'cancelled'; }
  }
  download(blob, name);
  return 'downloaded';
}
function csvBlob(text) {
  return new Blob([text], { type: 'text/csv;charset=utf-8' });
}
function stamp() {
  return todayIso().replace(/-/g, '');
}

// ---------- images ----------
function loadImageEl(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}
function drawScaled(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}
async function processImage(file) {
  const img = await loadImageEl(file);
  const [full, thumb] = await Promise.all([drawScaled(img, 1800, 0.82), drawScaled(img, 240, 0.7)]);
  return { full, thumb };
}
function thumbUrl(id, blob) {
  if (!blob) return null;
  if (!state.thumbUrls.has(id)) state.thumbUrls.set(id, URL.createObjectURL(blob));
  return state.thumbUrls.get(id);
}

// ---------- navigation ----------
const TITLES = { capture: 'Receipts', edit: 'Receipt', list: 'All receipts', export: 'Export', settings: 'Settings' };
function showView(name) {
  if (name !== 'edit') state.previousView = name;
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $('#view-title').textContent = TITLES[name];
  $('#btn-back').classList.toggle('hidden', name !== 'edit');
  window.scrollTo(0, 0);
  if (name === 'capture') renderHome();
  if (name === 'list') renderList();
  if (name === 'export') renderExport();
  if (name === 'settings') renderSettings();
}

// ---------- rendering lists ----------
async function receiptItem(r) {
  const li = document.createElement('li');
  li.className = 'receipt';
  li.dataset.id = r.id;
  const img = r.hasImage ? await db.getImage(r.id) : null;
  const url = img ? thumbUrl(r.id, img.thumb) : null;
  const badges = [];
  if (r.client) badges.push(`<span class="badge">${escapeHtml(r.client)}</span>`);
  if (r.exportedXero) badges.push('<span class="badge ok">Xero ✓</span>');
  if (r.billable && r.exportedClaim) badges.push('<span class="badge ok">Claimed ✓</span>');
  if (r.paidWith === 'personal') badges.push('<span class="badge">Paid personally</span>');
  li.innerHTML = `
    ${url ? `<img src="${url}" alt="" />` : '<div class="thumb-empty">🧾</div>'}
    <div class="main">
      <div class="title">${escapeHtml(r.merchant || 'Unknown merchant')}</div>
      <div class="sub">${fmtDate(r.date)} · ${escapeHtml(categoryLabel(r.category))}</div>
      <div class="badges">${badges.join('')}</div>
    </div>
    <div class="amt">${fmtMoney(r.total, r.currency)}</div>`;
  li.addEventListener('click', () => openEdit(r.id));
  return li;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function fillList(ul, receipts) {
  ul.innerHTML = '';
  const items = await Promise.all(receipts.map(receiptItem));
  items.forEach((li) => ul.appendChild(li));
}
function sorted(receipts) {
  return [...receipts].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
}

async function renderHome() {
  const notXero = filterReceipts(state.receipts, { status: 'notXero' });
  const notClaimed = filterReceipts(state.receipts, { status: 'notClaimed' });
  $('#stat-xero').textContent = `${notXero.length} · ${fmtMoney(summarize(notXero).total)}`;
  $('#stat-claim').textContent = `${notClaimed.length} · ${fmtMoney(summarize(notClaimed).total)}`;
  await fillList($('#recent-list'), sorted(state.receipts).slice(0, 5));
  $('#empty-hint').classList.toggle('hidden', state.receipts.length > 0);
}

function clients() {
  const set = new Set(state.receipts.map((r) => (r.client || '').trim()).filter(Boolean));
  if (state.settings.defaultClient) set.add(state.settings.defaultClient);
  return [...set].sort();
}
function fillClientSelect(sel) {
  const cur = sel.value;
  sel.innerHTML = '<option value="">All clients</option>' + clients().map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = cur;
}
function listFilter() {
  const month = $('#l-month').value;
  return {
    status: $('#l-status').value,
    client: $('#l-client').value,
    from: month ? `${month}-01` : '',
    to: month ? `${month}-31` : '',
  };
}
function summaryHtml(receipts) {
  const s = summarize(receipts);
  return `<b>${s.count}</b> receipt${s.count === 1 ? '' : 's'} · total <b>${fmtMoney(s.total)}</b> · tax ${fmtMoney(s.tax)} · paid personally ${fmtMoney(s.personal)} · billable ${fmtMoney(s.billable)}`;
}
async function renderList() {
  fillClientSelect($('#l-client'));
  const rs = sorted(filterReceipts(state.receipts, listFilter()));
  $('#list-summary').innerHTML = summaryHtml(rs);
  await fillList($('#all-list'), rs);
}

// ---------- edit form ----------
function fillCategorySelect() {
  $('#f-category').innerHTML = CATEGORIES.map((c) => `<option value="${c.key}">${c.label}</option>`).join('');
}
function fillDatalists() {
  const merchants = [...new Set(state.receipts.map((r) => r.merchant).filter(Boolean))].sort();
  $('#merchant-list').innerHTML = merchants.map((m) => `<option value="${escapeHtml(m)}">`).join('');
  $('#client-list').innerHTML = clients().map((c) => `<option value="${escapeHtml(c)}">`).join('');
}
async function showEditImage(blob) {
  const img = $('#edit-image');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (blob) {
    const url = URL.createObjectURL(blob);
    img.src = url; img.dataset.url = url;
    $('#btn-view-photo').classList.remove('hidden');
    $('#edit-noimage').classList.add('hidden');
  } else {
    img.removeAttribute('src'); delete img.dataset.url;
    $('#btn-view-photo').classList.add('hidden');
    $('#edit-noimage').classList.remove('hidden');
  }
}

// ---------- full-screen photo viewer with pinch zoom ----------
const viewer = { scale: 1, x: 0, y: 0, start: null };
function viewerApply() {
  $('#viewer-img').style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.scale})`;
}
function openViewer() {
  const src = $('#edit-image').src;
  if (!src) return;
  const img = $('#viewer-img');
  img.src = src;
  viewer.scale = 1; viewer.x = 0; viewer.y = 0; viewerApply();
  $('#viewer').classList.remove('hidden');
}
function closeViewer() { $('#viewer').classList.add('hidden'); }
function bindViewer() {
  const el = $('#viewer');
  const img = $('#viewer-img');
  let lastTap = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  const clamp = () => {
    viewer.scale = Math.min(6, Math.max(1, viewer.scale));
    if (viewer.scale === 1) { viewer.x = 0; viewer.y = 0; }
  };
  // Image-space point under a screen point, given the current transform.
  const toImage = (sx, sy) => { const r = img.getBoundingClientRect(); return { x: (sx - r.left) / viewer.scale, y: (sy - r.top) / viewer.scale }; };
  // Set scale so that image point p stays under screen point s.
  const zoomAbout = (p, s2, scale) => {
    const r0 = img.getBoundingClientRect();
    const originX = r0.left - viewer.x; const originY = r0.top - viewer.y; // untransformed top-left
    viewer.scale = scale;
    viewer.x = s2.x - originX - p.x * scale;
    viewer.y = s2.y - originY - p.y * scale;
  };
  el.addEventListener('touchstart', (e) => {
    if (e.target === $('#viewer-close')) return;
    e.preventDefault();
    const t = e.touches;
    if (t.length === 2) {
      const m = mid(t);
      viewer.start = { kind: 'pinch', d: dist(t), p: toImage(m.x, m.y), scale: viewer.scale };
    } else if (t.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) {
        if (viewer.scale > 1) { viewer.scale = 1; viewer.x = 0; viewer.y = 0; }
        else zoomAbout(toImage(t[0].clientX, t[0].clientY), { x: t[0].clientX, y: t[0].clientY }, 2.5);
        clamp(); viewerApply(); lastTap = 0; viewer.start = null; return;
      }
      lastTap = now;
      viewer.start = { kind: 'pan', px: t[0].clientX, py: t[0].clientY, x: viewer.x, y: viewer.y, moved: false };
    }
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const st = viewer.start; if (!st) return;
    const t = e.touches;
    if (st.kind === 'pinch' && t.length === 2) {
      const m = mid(t);
      zoomAbout(st.p, m, Math.min(6, Math.max(1, st.scale * (dist(t) / st.d))));
    } else if (st.kind === 'pan' && t.length === 1 && viewer.scale > 1) {
      viewer.x = st.x + (t[0].clientX - st.px); viewer.y = st.y + (t[0].clientY - st.py);
      if (Math.abs(t[0].clientX - st.px) > 6 || Math.abs(t[0].clientY - st.py) > 6) st.moved = true;
    }
    viewerApply();
  }, { passive: false });
  el.addEventListener('touchend', (e) => {
    const st = viewer.start;
    if (st && st.kind === 'pan' && !st.moved && viewer.scale === 1 && e.touches.length === 0) {
      // Single tap on an unzoomed photo closes it (after the double-tap window).
      setTimeout(() => { if (Date.now() - lastTap >= 300 && viewer.scale === 1) closeViewer(); }, 310);
    }
    if (e.touches.length === 0) { clamp(); viewerApply(); viewer.start = null; }
    else if (e.touches.length === 1) viewer.start = { kind: 'pan', px: e.touches[0].clientX, py: e.touches[0].clientY, x: viewer.x, y: viewer.y, moved: true };
  });
  // Mouse: wheel to zoom, click to close when not zoomed.
  el.addEventListener('wheel', (e) => { e.preventDefault(); viewer.scale *= e.deltaY < 0 ? 1.15 : 0.87; clamp(); viewerApply(); }, { passive: false });
  el.addEventListener('click', (e) => { if (e.target !== img && viewer.scale === 1) closeViewer(); });
  $('#viewer-close').addEventListener('click', closeViewer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });
}
async function openEdit(id, pending) {
  state.currentId = id;
  state.pendingImage = pending || null;
  state.taxTouched = false;
  fillDatalists();
  const r = id ? state.receipts.find((x) => x.id === id) : null;
  const s = state.settings;
  $('#f-total').value = r ? money(r.total) : '';
  $('#f-merchant').value = r ? r.merchant : '';
  $('#f-date').value = r ? r.date : todayIso();
  $('#f-category').value = r ? r.category : (s.lastCategory || 'meals');
  $('#f-tax').value = r ? money(r.tax) : '';
  $('#f-notax').checked = r ? !!r.noTax : false;
  $('#f-paid').value = r ? r.paidWith : 'personal';
  $('#f-billable').checked = r ? !!r.billable : !!s.defaultClient;
  $('#f-client').value = r ? r.client || '' : s.defaultClient || '';
  $('#f-notes').value = r ? r.notes || '' : '';
  $('#client-field').classList.toggle('hidden', !$('#f-billable').checked);
  $('#f-tax').disabled = $('#f-notax').checked;
  $('#btn-delete').classList.toggle('hidden', !r);
  $('#edit-status').textContent = r
    ? [r.exportedXero ? `In Xero since ${fmtDate(r.exportedXero.slice(0, 10))}` : 'Not yet exported to Xero',
      r.billable ? (r.exportedClaim ? `Claimed ${fmtDate(r.exportedClaim.slice(0, 10))}` : 'Not yet claimed') : null]
      .filter(Boolean).join(' · ')
    : '';
  if (pending) await showEditImage(pending.full);
  else if (r && r.hasImage) await showEditImage((await db.getImage(r.id))?.full);
  else await showEditImage(null);
  state.initialValues = snapshotFields();
  state.openSnapshot = formSnapshot();
  state.ocrToken += 1;
  clearSuggested();
  $('#ocr-status').classList.add('hidden');
  $('#ocr-debug').classList.add('hidden');
  $('#btn-ocr').classList.toggle('hidden', !(pending || (r && r.hasImage)) || !ocrSupported() || state.settings.ocr === false);
  showView('edit');
  if (!r) setTimeout(() => $('#f-total').focus(), 50);
}

const OCR_FIELDS = ['#f-total', '#f-merchant', '#f-date', '#f-tax', '#f-category'];
function snapshotFields() {
  return Object.fromEntries(OCR_FIELDS.map((sel) => [sel, $(sel).value]));
}
function clearSuggested() {
  OCR_FIELDS.forEach((sel) => { $(sel).classList.remove('suggested'); $(sel).closest('label').classList.remove('from-photo'); });
}
function markFromPhoto(sel) {
  $(sel).classList.add('suggested');
  $(sel).closest('label').classList.add('from-photo');
}
const ALL_FIELDS = ['#f-total', '#f-merchant', '#f-date', '#f-category', '#f-tax', '#f-paid', '#f-client', '#f-notes'];
function formSnapshot() {
  return JSON.stringify([...ALL_FIELDS.map((sel) => $(sel).value), $('#f-notax').checked, $('#f-billable').checked]);
}
function editIsDirty() {
  return state.view === 'edit' && (!!state.pendingImage || formSnapshot() !== state.openSnapshot);
}
// Returns true if it is OK to leave the edit screen.
function confirmLeaveEdit() {
  if (!editIsDirty()) return true;
  const ok = confirm(state.currentId ? 'Discard your changes to this receipt?' : 'Discard this receipt? The photo and details will be lost.');
  if (ok) state.pendingImage = null;
  return ok;
}
function setOcrStatus(text, cls) {
  const el = $('#ocr-status');
  el.textContent = text;
  el.className = `status-line ${cls || ''}`;
  el.classList.toggle('hidden', !text);
}
async function currentImageBlob() {
  if (state.pendingImage) return state.pendingImage.full;
  if (state.currentId) return (await db.getImage(state.currentId))?.full || null;
  return null;
}
// Run OCR on the receipt photo and fill in fields the user has not touched yet.
async function runOcr(blob) {
  if (!blob || !ocrSupported()) return;
  const token = ++state.ocrToken;
  const live = () => token === state.ocrToken && state.view === 'edit';
  const started = Date.now();
  let stageText = 'Starting receipt reader…';
  const tick = () => {
    if (!live()) return;
    const secs = Math.round((Date.now() - started) / 1000);
    setOcrStatus(secs >= 4 ? `${stageText} (${secs}s)` : stageText);
  };
  tick();
  const timer = setInterval(tick, 1000);
  $('#ocr-debug').classList.add('hidden');
  $('#ocr-text').textContent = '';
  try {
    const { parsed, text, confidence } = await readReceipt(blob, {
      dateFormat: state.settings.dateFormat,
      onProgress: ({ stage, progress, detail }) => {
        if (stage === 'loading') stageText = `Downloading receipt reader, first time only: ${detail || 'please wait'}…`;
        else if (stage === 'preparing') stageText = 'Preparing receipt reader…';
        else stageText = `Reading receipt… ${Math.round((progress || 0) * 100)}%`;
        tick();
      },
    });
    clearInterval(timer);
    if (!live()) return;
    const init = state.initialValues || {};
    const untouched = (sel) => $(sel).value === (init[sel] ?? '');
    const found = [];
    if (parsed.total != null && untouched('#f-total')) {
      $('#f-total').value = money(parsed.total); markFromPhoto('#f-total'); found.push('total');
      if (untouched('#f-tax') && !$('#f-notax').checked) {
        if (parsed.tax != null) { $('#f-tax').value = money(parsed.tax); markFromPhoto('#f-tax'); found.push('GST'); }
        else recomputeTax();
      }
    }
    if (parsed.merchant && untouched('#f-merchant')) { $('#f-merchant').value = parsed.merchant; markFromPhoto('#f-merchant'); found.push('merchant'); }
    if (parsed.date && untouched('#f-date')) { $('#f-date').value = parsed.date; markFromPhoto('#f-date'); found.push('date'); }
    if (parsed.category && untouched('#f-category')) { $('#f-category').value = parsed.category; markFromPhoto('#f-category'); found.push('category'); }
    const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
    $('#ocr-text').textContent = `${Math.round(confidence || 0)}% confidence, ${words} words\n\n${(text || '').trim() || '(no text found)'}`;
    $('#ocr-debug').classList.toggle('hidden', !(state.settings.showOcrText || !found.length));
    if (found.length) setOcrStatus(`Read from photo: ${found.join(', ')}. Tap the photo to zoom and check.`, 'ok');
    else if (words < 5) setOcrStatus('Could not make out any text. Try again with the receipt flat, filling the frame, in good light.', 'warn');
    else setOcrStatus('Read the text but could not find a total or date in it. Please enter the details.', 'warn');
  } catch (err) {
    clearInterval(timer);
    if (!live()) return;
    setOcrStatus(`Receipt reader failed: ${err && err.message ? err.message : err}`, 'warn');
    $('#ocr-text').textContent = String(err && err.stack ? err.stack : err);
    $('#ocr-debug').classList.remove('hidden');
  }
}
function recomputeTax() {
  if (state.taxTouched || $('#f-notax').checked) return;
  $('#f-tax').value = money(taxFromGross($('#f-total').value, state.settings.taxRate));
}
async function saveEdit(e) {
  e.preventDefault();
  const existing = state.currentId ? state.receipts.find((x) => x.id === state.currentId) : null;
  const id = existing ? existing.id : uid();
  const billable = $('#f-billable').checked;
  const r = {
    ...(existing || {}),
    id,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    date: $('#f-date').value || todayIso(),
    merchant: $('#f-merchant').value.trim(),
    category: $('#f-category').value,
    total: round2($('#f-total').value),
    tax: $('#f-notax').checked ? 0 : round2($('#f-tax').value),
    noTax: $('#f-notax').checked,
    paidWith: $('#f-paid').value,
    billable,
    client: billable ? $('#f-client').value.trim() : '',
    notes: $('#f-notes').value.trim(),
    currency: state.settings.currency,
    hasImage: !!(existing && existing.hasImage) || !!state.pendingImage,
    exportedXero: existing ? existing.exportedXero || null : null,
    exportedClaim: existing ? existing.exportedClaim || null : null,
  };
  if (state.pendingImage) {
    await db.putImage({ id, full: state.pendingImage.full, thumb: state.pendingImage.thumb });
    if (state.thumbUrls.has(id)) { URL.revokeObjectURL(state.thumbUrls.get(id)); state.thumbUrls.delete(id); }
  }
  await db.putReceipt(r);
  state.receipts = state.receipts.filter((x) => x.id !== id).concat(r);
  state.pendingImage = null;
  state.openSnapshot = formSnapshot();
  if (state.settings.lastCategory !== r.category) { state.settings.lastCategory = r.category; db.putSettings(state.settings).catch(() => {}); }
  toast('Saved');
  showView(state.previousView);
}
async function deleteCurrent() {
  const r = state.receipts.find((x) => x.id === state.currentId);
  if (!r) return;
  if (!confirm(`Delete receipt from ${r.merchant || 'unknown merchant'} for ${fmtMoney(r.total)}?`)) return;
  await db.deleteReceipt(r.id);
  await db.deleteImage(r.id);
  state.receipts = state.receipts.filter((x) => x.id !== r.id);
  toast('Deleted');
  showView(state.previousView);
}
async function handleNewPhoto(file) {
  if (!file) return;
  toast('Processing photo…', 8000);
  try {
    const img = await processImage(file);
    $('#toast').classList.add('hidden');
    await openEdit(null, img);
    if (state.settings.ocr) runOcr(img.full);
  } catch (err) {
    toast(`Could not read that image: ${err.message}`);
  }
}
async function handleReplacePhoto(file) {
  if (!file) return;
  try {
    state.pendingImage = await processImage(file);
    await showEditImage(state.pendingImage.full);
    $('#btn-ocr').classList.toggle('hidden', !ocrSupported());
    toast('Photo updated. Save to keep it.');
    if (state.settings.ocr) runOcr(state.pendingImage.full);
  } catch (err) {
    toast(`Could not read that image: ${err.message}`);
  }
}

// ---------- export ----------
function exportFilter() {
  return { status: $('#e-status').value, client: $('#e-client').value, from: $('#e-from').value, to: $('#e-to').value };
}
function exportSelection() {
  return sorted(filterReceipts(state.receipts, exportFilter())).reverse(); // oldest first for exports
}
function renderExport() {
  fillClientSelect($('#e-client'));
  clearFollowup();
  const rs = exportSelection();
  $('#export-summary').innerHTML = summaryHtml(rs);
  document.querySelectorAll('#view-export .btn').forEach((b) => { b.disabled = rs.length === 0; });
}
function requireSelection() {
  const rs = exportSelection();
  if (!rs.length) toast('Nothing matches the current filters.');
  return rs;
}
async function imageEntries(rs) {
  const out = [];
  for (const r of rs) {
    if (!r.hasImage) continue;
    const img = await db.getImage(r.id);
    if (!img) continue;
    out.push({ r, name: imageFileName(r), blob: img.full });
  }
  return out;
}
function offerMark(kind, rs, what) {
  const n = `${rs.length} receipt${rs.length === 1 ? '' : 's'}`;
  state.followup = { kind, receipts: rs };
  $('#export-followup-text').textContent = `${what} for ${n}. When it is in Xero, mark ${rs.length === 1 ? 'it' : 'them'} as ${kind === 'xero' ? '“in Xero”' : '“claimed”'} so ${rs.length === 1 ? 'it is' : 'they are'} not exported twice.`;
  $('#btn-followup-mark').textContent = kind === 'xero' ? 'Mark as in Xero' : 'Mark as claimed';
  $('#export-followup').classList.remove('hidden');
  $('#export-followup').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearFollowup() {
  state.followup = null;
  $('#export-followup').classList.add('hidden');
}
async function markExported(kind, rs) {
  const now = new Date().toISOString();
  for (const r of rs) {
    if (kind === 'xero') r.exportedXero = now; else r.exportedClaim = now;
    await db.putReceipt(r);
  }
  toast(`Marked ${rs.length} as ${kind === 'xero' ? 'in Xero' : 'claimed'}`);
  renderExport();
}

async function exportBills() {
  const rs = requireSelection(); if (!rs.length) return;
  const how = await deliver(csvBlob(billsCsv(rs, state.settings)), `xero-bills-${stamp()}.csv`, 'Xero bills import');
  if (how === 'cancelled') return;
  toast('In Xero choose “Tax Inclusive” when importing.', 5000);
  offerMark('xero', rs, `Bills CSV ${how}`);
}
async function exportImagesZip() {
  const rs = requireSelection(); if (!rs.length) return;
  const entries = await imageEntries(rs);
  if (!entries.length) return toast('None of the selected receipts has a photo.');
  const zipEntries = [];
  for (const e of entries) zipEntries.push({ name: e.name, data: new Uint8Array(await e.blob.arrayBuffer()), date: new Date() });
  zipEntries.push({ name: 'receipts.csv', data: new TextEncoder().encode(claimCsv(rs, state.settings)), date: new Date() });
  await deliver(new Blob([buildZip(zipEntries)], { type: 'application/zip' }), `receipt-images-${stamp()}.zip`, 'Receipt photos');
}
async function shareToXero() {
  const rs = requireSelection(); if (!rs.length) return;
  const entries = await imageEntries(rs);
  if (!entries.length) return toast('None of the selected receipts has a photo.');
  const files = entries.map((e) => new File([e.blob], e.name, { type: 'image/jpeg' }));
  const email = state.settings.xeroEmail;
  const text = `${rs.length} receipt${rs.length === 1 ? '' : 's'}, total ${fmtMoney(summarize(rs).total)}.` + (email ? `\nSend to: ${email}` : '');
  if (navigator.canShare && navigator.canShare({ files })) {
    if (email && navigator.clipboard) {
      try { await navigator.clipboard.writeText(email); toast(`Xero address copied: ${email}`, 4000); } catch { /* ignore */ }
    }
    try {
      await navigator.share({ files, title: 'Receipts for Xero', text });
      offerMark('xero', rs, 'Photos shared');
    } catch (err) {
      if (err.name !== 'AbortError') toast(`Share failed: ${err.message}`);
    }
  } else {
    toast('Sharing files is not supported here. Downloading a ZIP instead.', 4000);
    await exportImagesZip();
  }
}
async function exportInvoice() {
  const all = requireSelection(); if (!all.length) return;
  const rs = all.filter((r) => r.billable);
  if (!rs.length) return toast('None of the selected receipts is marked “Bill this to a client”.', 4000);
  if (rs.length < all.length) toast(`Skipping ${all.length - rs.length} receipt(s) not marked as billable.`, 3500);
  const unassigned = rs.filter((r) => !r.client);
  if (unassigned.length && !confirm(`${unassigned.length} receipt(s) have no client and will be put on an “Unassigned” invoice. Continue?`)) return;
  const how = await deliver(csvBlob(invoiceCsv(rs, state.settings, { invoiceDate: todayIso() })), `xero-sales-invoices-${stamp()}.csv`, 'Xero sales invoice import');
  if (how === 'cancelled') return;
  toast('Import as draft invoices in Xero, then review before approving.', 5000);
  offerMark('claim', rs, `Invoice CSV ${how}`);
}
async function exportClaimCsv() {
  const rs = requireSelection(); if (!rs.length) return;
  await deliver(csvBlob(claimCsv(rs, state.settings)), `expenses-${stamp()}.csv`, 'Expense list');
}
async function exportClaimPdf() {
  const rs = requireSelection(); if (!rs.length) return;
  const s = state.settings;
  const sum = summarize(rs);
  const entries = await imageEntries(rs);
  const urls = entries.map((e) => ({ ...e, url: URL.createObjectURL(e.blob) }));
  const clientLabel = $('#e-client').value || 'All clients';
  const period = [$('#e-from').value, $('#e-to').value].filter(Boolean).map(fmtDate).join(' to ') || 'All dates';
  const rows = rs.map((r) => `<tr>
      <td>${formatXeroDate(r.date, s.dateFormat)}</td><td>${escapeHtml(r.merchant)}</td><td>${escapeHtml(categoryLabel(r.category))}</td>
      <td>${escapeHtml(r.client || '')}</td><td>${escapeHtml(r.notes || '')}</td>
      <td class="num">${money((r.total || 0) - (r.noTax ? 0 : r.tax || 0))}</td><td class="num">${money(r.noTax ? 0 : r.tax)}</td><td class="num">${money(r.total)}</td>
    </tr>`).join('');
  const figs = urls.map((e) => `<figure><img src="${e.url}" alt="" /><figcaption>${formatXeroDate(e.r.date, s.dateFormat)} · ${escapeHtml(e.r.merchant)} · ${money(e.r.total)} ${escapeHtml(e.r.currency || s.currency)}</figcaption></figure>`).join('');
  $('#print-view').innerHTML = `
    <h1>Expense claim${s.yourName ? ` – ${escapeHtml(s.yourName)}` : ''}</h1>
    <div>Client: ${escapeHtml(clientLabel)} · Period: ${period} · Prepared ${fmtDate(todayIso())}</div>
    <table>
      <thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th>Client</th><th>Notes</th><th class="num">Net</th><th class="num">Tax</th><th class="num">Total</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th colspan="5">Total (${escapeHtml(s.currency)})</th><th class="num">${money(sum.total - sum.tax)}</th><th class="num">${money(sum.tax)}</th><th class="num">${money(sum.total)}</th></tr></tfoot>
    </table>
    <h2>Receipts</h2>
    <div class="photos">${figs}</div>`;
  await Promise.all([...$('#print-view').querySelectorAll('img')].map((img) => img.complete ? null : new Promise((res) => { img.onload = res; img.onerror = res; })));
  window.addEventListener('afterprint', () => {
    urls.forEach((e) => URL.revokeObjectURL(e.url));
    offerMark('claim', rs, 'Expense claim prepared');
  }, { once: true });
  toast('Use “Save as PDF” in the print dialog.', 4000);
  window.print();
}

// ---------- settings ----------
function renderSettings() {
  const s = state.settings;
  $('#s-region').innerHTML = Object.entries(REGIONS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('') + '<option value="custom">Custom</option>';
  $('#s-region').value = REGIONS[s.region] ? s.region : 'custom';
  $('#s-currency').value = s.currency;
  $('#s-taxrate').value = s.taxRate;
  $('#s-datefmt').value = s.dateFormat;
  $('#s-accounts').innerHTML = CATEGORIES.map((c) => `<label>${c.label} <input type="text" data-acct="${c.key}" value="${escapeHtml(s.accountCodes[c.key] || c.account)}" /></label>`).join('');
  $('#s-income').value = s.incomeAccount;
  $('#s-rechargetax').value = s.rechargeTax;
  $('#s-prefix').value = s.invoicePrefix;
  $('#s-due').value = s.dueDays;
  $('#s-tax-exp').value = s.taxNames.expense;
  $('#s-tax-exp0').value = s.taxNames.expenseZero;
  $('#s-tax-expn').value = s.taxNames.expenseNone;
  $('#s-tax-inc').value = s.taxNames.income;
  $('#s-tax-inc0').value = s.taxNames.incomeZero;
  $('#s-name').value = s.yourName || '';
  $('#s-client').value = s.defaultClient || '';
  $('#s-xeroemail').value = s.xeroEmail || '';
  $('#s-ocr').checked = s.ocr !== false;
  $('#s-ocrtext').checked = !!s.showOcrText;
  $('#s-version').textContent = `Receipts v${APP_VERSION} · ${state.receipts.length} receipts stored on this device`;
}
function applyRegionDefaults() {
  const key = $('#s-region').value;
  if (!REGIONS[key]) return;
  const d = defaultSettings(key);
  $('#s-currency').value = d.currency;
  $('#s-taxrate').value = d.taxRate;
  $('#s-datefmt').value = d.dateFormat;
  $('#s-tax-exp').value = d.taxNames.expense;
  $('#s-tax-exp0').value = d.taxNames.expenseZero;
  $('#s-tax-expn').value = d.taxNames.expenseNone;
  $('#s-tax-inc').value = d.taxNames.income;
  $('#s-tax-inc0').value = d.taxNames.incomeZero;
}
async function saveSettings(e) {
  e.preventDefault();
  const accountCodes = {};
  document.querySelectorAll('#s-accounts input').forEach((i) => { accountCodes[i.dataset.acct] = i.value.trim(); });
  state.settings = {
    ...state.settings,
    region: $('#s-region').value,
    currency: $('#s-currency').value.trim().toUpperCase() || 'AUD',
    taxRate: Number($('#s-taxrate').value) || 0,
    dateFormat: $('#s-datefmt').value,
    accountCodes,
    incomeAccount: $('#s-income').value.trim() || '200',
    rechargeTax: $('#s-rechargetax').value,
    invoicePrefix: $('#s-prefix').value.trim() || 'EXP',
    dueDays: Number($('#s-due').value) || 0,
    taxNames: {
      expense: $('#s-tax-exp').value.trim(), expenseZero: $('#s-tax-exp0').value.trim(), expenseNone: $('#s-tax-expn').value.trim(),
      income: $('#s-tax-inc').value.trim(), incomeZero: $('#s-tax-inc0').value.trim(),
    },
    yourName: $('#s-name').value.trim(),
    defaultClient: $('#s-client').value.trim(),
    xeroEmail: $('#s-xeroemail').value.trim(),
    ocr: $('#s-ocr').checked,
    showOcrText: $('#s-ocrtext').checked,
  };
  await db.putSettings(state.settings);
  toast('Settings saved');
}

// ---------- backup / restore ----------
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
async function dataUrlToBlob(url) {
  return (await fetch(url)).blob();
}
async function backup() {
  toast('Preparing backup…', 10000);
  const images = await db.allImages();
  const imgs = [];
  for (const i of images) imgs.push({ id: i.id, full: await blobToDataUrl(i.full), thumb: await blobToDataUrl(i.thumb) });
  const payload = { app: 'receipts', version: APP_VERSION, exportedAt: new Date().toISOString(), settings: state.settings, receipts: state.receipts, images: imgs };
  download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `receipts-backup-${stamp()}.json`);
  toast('Backup downloaded');
}
async function restore(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== 'receipts' || !Array.isArray(payload.receipts)) throw new Error('Not a Receipts backup file');
    if (!confirm(`Restore ${payload.receipts.length} receipts from this backup? Existing receipts with the same ID will be replaced.`)) return;
    for (const r of payload.receipts) await db.putReceipt(r);
    for (const i of payload.images || []) await db.putImage({ id: i.id, full: await dataUrlToBlob(i.full), thumb: await dataUrlToBlob(i.thumb) });
    if (payload.settings) { state.settings = { ...defaultSettings(), ...payload.settings }; await db.putSettings(state.settings); }
    state.receipts = await db.allReceipts();
    state.thumbUrls.forEach((u) => URL.revokeObjectURL(u)); state.thumbUrls.clear();
    toast('Restored');
    showView('capture');
  } catch (err) {
    toast(`Restore failed: ${err.message}`, 5000);
  }
}
async function wipe() {
  if (!confirm('Delete ALL receipts and photos from this device? Download a backup first if you need them.')) return;
  if (!confirm('Really delete everything? This cannot be undone.')) return;
  await db.clearAll();
  state.receipts = [];
  state.thumbUrls.forEach((u) => URL.revokeObjectURL(u)); state.thumbUrls.clear();
  toast('All receipts deleted');
  showView('capture');
}

// ---------- wiring ----------
function bind() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { if (confirmLeaveEdit()) showView(t.dataset.view); }));
  $('#btn-back').addEventListener('click', () => { if (confirmLeaveEdit()) showView(state.previousView); });
  $('#btn-view-photo').addEventListener('click', openViewer);
  bindViewer();
  $('#btn-followup-mark').addEventListener('click', async () => {
    if (!state.followup) return;
    const { kind, receipts } = state.followup;
    clearFollowup();
    await markExported(kind, receipts);
  });
  $('#btn-followup-dismiss').addEventListener('click', clearFollowup);

  $('#file-camera').addEventListener('change', (e) => { handleNewPhoto(e.target.files[0]); e.target.value = ''; });
  $('#file-gallery').addEventListener('change', (e) => { handleNewPhoto(e.target.files[0]); e.target.value = ''; });
  $('#file-replace').addEventListener('change', (e) => { handleReplacePhoto(e.target.files[0]); e.target.value = ''; });
  $('#btn-no-photo').addEventListener('click', () => openEdit(null));

  $('#edit-form').addEventListener('submit', saveEdit);
  $('#btn-delete').addEventListener('click', deleteCurrent);
  $('#f-total').addEventListener('input', recomputeTax);
  OCR_FIELDS.forEach((sel) => $(sel).addEventListener('input', () => { $(sel).classList.remove('suggested'); $(sel).closest('label').classList.remove('from-photo'); }));
  $('#btn-ocr-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#ocr-text').textContent); toast('Copied'); } catch { toast('Could not copy. Long-press the text to select it.'); }
  });
  $('#btn-ocr').addEventListener('click', async () => {
    // Re-read: treat whatever is in the form now as the baseline, so every field may be replaced.
    const blob = await currentImageBlob();
    if (!blob) return;
    state.initialValues = snapshotFields();
    state.taxTouched = false;
    runOcr(blob);
  });
  $('#f-tax').addEventListener('input', () => { state.taxTouched = true; });
  $('#f-notax').addEventListener('change', (e) => {
    $('#f-tax').disabled = e.target.checked;
    if (e.target.checked) $('#f-tax').value = '0.00'; else { state.taxTouched = false; recomputeTax(); }
  });
  $('#f-billable').addEventListener('change', (e) => $('#client-field').classList.toggle('hidden', !e.target.checked));

  ['#l-status', '#l-client', '#l-month'].forEach((sel) => $(sel).addEventListener('change', renderList));
  ['#e-status', '#e-client', '#e-from', '#e-to'].forEach((sel) => $(sel).addEventListener('change', renderExport));
  window.addEventListener('beforeunload', (e) => { if (editIsDirty()) { e.preventDefault(); e.returnValue = ''; } });

  $('#x-bills').addEventListener('click', exportBills);
  $('#x-images').addEventListener('click', exportImagesZip);
  $('#x-share').addEventListener('click', shareToXero);
  $('#x-invoice').addEventListener('click', exportInvoice);
  $('#x-claim-pdf').addEventListener('click', exportClaimPdf);
  $('#x-claim-csv').addEventListener('click', exportClaimCsv);
  $('#x-mark-xero').addEventListener('click', () => { const rs = requireSelection(); if (rs.length) markExported('xero', rs); });
  $('#x-mark-claim').addEventListener('click', () => { const rs = requireSelection(); if (rs.length) markExported('claim', rs); });

  $('#settings-form').addEventListener('submit', saveSettings);
  $('#s-region').addEventListener('change', applyRegionDefaults);
  $('#s-backup').addEventListener('click', backup);
  $('#s-restore-file').addEventListener('change', (e) => { restore(e.target.files[0]); e.target.value = ''; });
  $('#s-wipe').addEventListener('click', wipe);
}

async function init() {
  state.settings = { ...defaultSettings(), ...((await db.getSettings()) || {}) };
  state.receipts = await db.allReceipts();
  fillCategorySelect();
  bind();
  showView('capture');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (state.settings.ocr !== false) setTimeout(preloadOcr, 2500);
}

init().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<pre style="padding:16px;color:#b42318">${escapeHtml(err.stack || err.message)}</pre>`);
});
