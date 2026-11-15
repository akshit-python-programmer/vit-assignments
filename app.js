import * as pdfjsLib from './vendor/pdf.min.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', import.meta.url).href;
const PDFJS_OPTS = {
  cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
};
const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;

/* ============================================================
   Constants
   ============================================================ */
const MB = 1_000_000;          // decimal MB: the strictest reading of "4 MB"
const SAFETY = 0.9875;         // 4 MB limit -> 3.95 MB hard cap
const FIT_LOW = 0.955;         // happy once we land within ~4.5% under the cap
const LINE = 1.2;              // line-height used both on screen and in the PDF
const A4 = [595.28, 841.89];
const FONTS = {
  helv:    { css: 'Arial, Helvetica, Arimo, "Liberation Sans", sans-serif', std: ['Helvetica', 'HelveticaBold'] },
  times:   { css: '"Times New Roman", Times, Tinos, "Liberation Serif", serif', std: ['TimesRoman', 'TimesRomanBold'] },
  courier: { css: '"Courier New", Courier, Cousine, "Liberation Mono", monospace', std: ['Courier', 'CourierBold'] },
};
const PLAINTEXT_ONLY = (() => {
  try { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only'; }
  catch { return false; }
})();

/* ============================================================
   State
   ============================================================ */
const state = {
  name: 'assignment',
  baseBytes: null,     // original PDF bytes (Uint8Array) or null for blank-only docs
  pdfjsDoc: null,
  pages: [],           // { id, src, pdfPage, vp, w, h, rot, block, el, canvas, layer, renderedScale }
  items: [],           // images + text boxes, in z-order
  images: new Map(),   // imgId -> { id, name, url, img, nw, nh, alpha, pngFriendly, thumb }
  scale: 1,
  fit: true,
  selected: null,
  editing: null,
  textMode: false,
  lastText: { size: 12, color: '#000000', font: 'helv', bold: false },
  busy: false,
  lastExport: null,
};
let uidCounter = 0;
const uid = p => `${p}${++uidCounter}`;
const visible = new Set();

/* ============================================================
   Small helpers
   ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtMB = b => (b < 100_000 ? `${Math.max(1, Math.round(b / 1000))} KB` : `${(b / MB).toFixed(2)} MB`);
const pageById = id => state.pages.find(p => p.id === id);
const isPdfFile = f => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
const isImageFile = f => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name));
const tick = () => new Promise(r => setTimeout(r, 0));

function canvasOf(w, hgt) { const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, hgt); return c; }
function freeCanvas(c) { if (c && c.getContext) { c.width = 0; c.height = 0; } }
const toBlob = (c, type, q) => new Promise((res, rej) =>
  c.toBlob(b => (b ? res(b) : rej(new Error('Image encoding failed (it may be too large for this browser).'))), type, q));
const blobBytes = async b => new Uint8Array(await b.arrayBuffer());

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** High-quality downscale (stepwise halving avoids aliasing on big ratios). */
function resample(src, tw, th, whiteBg) {
  tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
  let cur = src;
  let cw = src.naturalWidth || src.width, ch = src.naturalHeight || src.height;
  const temps = [];
  while (cw >= tw * 2 && ch >= th * 2) {
    const nw = Math.max(tw, Math.floor(cw / 2)), nh = Math.max(th, Math.floor(ch / 2));
    const c = canvasOf(nw, nh);
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    temps.push(c); cur = c; cw = nw; ch = nh;
  }
  const out = canvasOf(tw, th);
  const ctx = out.getContext('2d');
  if (whiteBg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th); }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, tw, th);
  temps.forEach(freeCanvas);
  return out;
}

/* ============================================================
   DOM refs
   ============================================================ */
const els = {
  viewer: $('#viewer'), pages: $('#pages'), empty: $('#empty'), dropzone: $('#dropzone'),
  trayList: $('#trayList'), trayAdd: $('#trayAdd'),
  pdfInput: $('#pdfInput'), imgInput: $('#imgInput'),
  btnText: $('#btnText'), btnDownload: $('#btnDownload'), limit: $('#limit'),
  zoomFit: $('#zoomFit'),
  selbar: $('#selbar'), fFont: $('#fFont'), fSize: $('#fSize'), fBold: $('#fBold'), fColor: $('#fColor'),
  modal: $('#modal'), mTitle: $('#mTitle'), mBarWrap: $('#mBarWrap'), mStatus: $('#mStatus'), mLog: $('#mLog'),
  mClose: $('#mClose'), mAgain: $('#mAgain'),
};

/* ============================================================
   Opening documents
   ============================================================ */
function hasWork() { return state.items.length > 0; }

function resetDoc() {
  select(null);
  state.items = [];
  for (const pg of state.pages) io.unobserve(pg.el);
  state.pages = [];
  visible.clear();
  els.pages.innerHTML = '';
  if (state.pdfjsDoc) { state.pdfjsDoc.destroy().catch(() => {}); state.pdfjsDoc = null; }
  state.baseBytes = null;
  updateTrayCounts();
}

async function openPdf(file) {
  if (hasWork() && !confirm('Open a new PDF? Images and text placed on the current one will be cleared (your image tray is kept).')) return;
  let bytes, doc;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise;
  } catch (err) {
    console.error(err);
    toast(err && err.name === 'PasswordException'
      ? 'This PDF is password-protected. Remove the password and try again.'
      : 'Could not open that file as a PDF.', 4000);
    return;
  }
  resetDoc();
  state.name = (file.name || 'assignment').replace(/\.pdf$/i, '') || 'assignment';
  state.baseBytes = bytes;
  state.pdfjsDoc = doc;
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    state.pages.push({ id: uid('p'), src: i - 1, pdfPage: p, vp, w: vp.width, h: vp.height, rot: ((p.rotate % 360) + 360) % 360 });
  }
  buildPagesDOM();
  toast(`Opened “${file.name}” · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''}`);
}

function startBlank() {
  if (hasWork() && !confirm('Start over with a blank page? Placed images and text will be cleared.')) return;
  resetDoc();
  state.name = 'assignment';
  state.pages.push(blankPageRecord(A4[0], A4[1]));
  buildPagesDOM();
}

function blankPageRecord(w, hgt) {
  return { id: uid('p'), src: null, pdfPage: null, vp: null, w, h: hgt, rot: 0 };
}

/* ============================================================
   Page DOM, zoom, lazy rendering
   ============================================================ */
const io = new IntersectionObserver(entries => {
  for (const en of entries) {
    const pg = state.pages.find(p => p.el === en.target);
    if (!pg) continue;
    if (en.isIntersecting) { visible.add(pg); if (pg.renderedScale !== state.scale) renderPage(pg); }
    else { visible.delete(pg); releasePage(pg); }
  }
}, { root: els.viewer, rootMargin: '1500px 0px' });

function buildPagesDOM() {
  els.pages.innerHTML = '';
  for (const pg of state.pages) els.pages.append(createPageBlock(pg));
  els.empty.hidden = state.pages.length > 0;
  els.btnDownload.disabled = state.pages.length === 0;
  renumber();
  if (state.fit) state.scale = fitScale();
  applyScale(false);
}

function createPageBlock(pg) {
  const block = h('section', 'page-block');
  const bar = h('div', 'pagebar');
  bar.innerHTML = '<span class="pnum"></span><span class="spacer"></span>' +
    '<button class="pb-btn" data-act="blank" title="Insert an empty page after this one">+ Blank page after</button>' +
    '<button class="pb-btn danger" data-act="delete" title="Remove this page from the download">Delete page</button>';
  const page = h('div', 'page');
  const canvas = h('canvas');
  const layer = h('div', 'layer');
  page.append(canvas, layer);
  block.append(bar, page);
  Object.assign(pg, { block, el: page, canvas, layer, renderedScale: null, bar });
  bar.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'blank') insertBlankAfter(pg); else deletePage(pg);
  });
  setupPageEvents(pg);
  io.observe(page);
  return block;
}

function renumber() {
  state.pages.forEach((pg, i) => {
    pg.bar.querySelector('.pnum').textContent = `Page ${i + 1} of ${state.pages.length}${pg.src == null ? ' · blank' : ''}`;
  });
}

function insertBlankAfter(pg) {
  const idx = state.pages.indexOf(pg);
  const np = blankPageRecord(pg.w, pg.h);
  state.pages.splice(idx + 1, 0, np);
  pg.block.after(createPageBlock(np));
  sizePage(np);
  renumber();
  np.block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function deletePage(pg) {
  const its = state.items.filter(i => i.pageId === pg.id);
  const msg = its.length ? `Delete this page and the ${its.length} item(s) on it?` : 'Delete this page from the PDF?';
  if (!confirm(msg)) return;
  its.forEach(removeItem);
  io.unobserve(pg.el);
  visible.delete(pg);
  pg.block.remove();
  state.pages.splice(state.pages.indexOf(pg), 1);
  renumber();
  if (!state.pages.length) { els.empty.hidden = false; els.btnDownload.disabled = true; }
}

function fitScale() {
  if (!state.pages.length) return 1;
  const avail = Math.max(200, els.viewer.clientWidth - (window.innerWidth <= 760 ? 20 : 40));
  // fit the typical page (median width) so one landscape page doesn't shrink all the others
  const ws = state.pages.map(p => p.w).sort((a, b) => a - b);
  const typical = ws[Math.floor(ws.length / 2)];
  return clamp(avail / typical, 0.2, 1.6);
}

function sizePage(pg) {
  const s = state.scale;
  pg.el.style.width = `${pg.w * s}px`;
  pg.el.style.height = `${pg.h * s}px`;
}

function applyScale(keepScroll = true) {
  const v = els.viewer;
  const frac = keepScroll && v.scrollHeight > 0 ? (v.scrollTop + v.clientHeight / 2) / v.scrollHeight : 0;
  for (const pg of state.pages) sizePage(pg);
  for (const it of state.items) placeItemEl(it);
  els.zoomFit.textContent = `${Math.round((state.scale / (96 / 72)) * 100)}%`;
  if (keepScroll) v.scrollTop = frac * v.scrollHeight - v.clientHeight / 2;
  for (const pg of visible) renderPage(pg);
}

function setZoom(s) {
  state.fit = false;
  state.scale = clamp(s, 0.2, 5);
  applyScale(true);
}

async function renderPage(pg) {
  if (!pg.pdfPage) { pg.renderedScale = state.scale; return; } // blank pages are just white
  if (pg.rendering) { pg.rerender = true; return; }
  pg.rendering = true;
  try {
    do {
      pg.rerender = false;
      const sc = state.scale;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let k = sc * dpr;
      const maxPx = 12e6;                                // stay under mobile canvas limits
      if (pg.w * pg.h * k * k > maxPx) k = Math.sqrt(maxPx / (pg.w * pg.h));
      const vp = pg.pdfPage.getViewport({ scale: k });
      const off = canvasOf(Math.floor(vp.width), Math.floor(vp.height));
      const ctx = off.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, off.width, off.height);
      await pg.pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
      if (!visible.has(pg)) { freeCanvas(off); break; }
      pg.canvas.width = off.width; pg.canvas.height = off.height;
      pg.canvas.getContext('2d').drawImage(off, 0, 0);
      freeCanvas(off);
      pg.renderedScale = sc;
    } while (pg.rerender || (visible.has(pg) && pg.renderedScale !== state.scale));
  } catch (err) {
    console.warn('render failed', err);
  } finally {
    pg.rendering = false;
  }
}

function releasePage(pg) {
  if (!pg.pdfPage || pg.rendering) return;
  pg.canvas.width = 0; pg.canvas.height = 0;
  pg.renderedScale = null;
}

function ptIn(pg, e) {
  const r = pg.el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
}

function pageAtPoint(cx, cy) {
  let best = null, bestD = Infinity;
  for (const pg of state.pages) {
    const r = pg.el.getBoundingClientRect();
    if (cy >= r.top && cy <= r.bottom && cx >= r.left - 40 && cx <= r.right + 40) return pg;
    const d = cy < r.top ? r.top - cy : cy - r.bottom;
    if (d < bestD) { bestD = d; best = pg; }
  }
  return bestD < 14 ? best : null;
}

/** Page that occupies most of the viewer, and the centre of its visible part. */
function focusPoint() {
  const vr = els.viewer.getBoundingClientRect();
  let best = null, bestArea = -1;
  for (const pg of visible.size ? visible : state.pages) {
    const r = pg.el.getBoundingClientRect();
    const ih = Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
    const iw = Math.max(0, Math.min(r.right, vr.right) - Math.max(r.left, vr.left));
    if (ih * iw > bestArea) { bestArea = ih * iw; best = { pg, r }; }
  }
  if (!best) return null;
  const { pg, r } = best;
  const top = Math.max(r.top, vr.top), bottom = Math.min(r.bottom, vr.bottom);
  const left = Math.max(r.left, vr.left), right = Math.min(r.right, vr.right);
  return {
    pg,
    x: clamp(((left + right) / 2 - r.left) / state.scale, 0, pg.w),
    y: clamp(((top + bottom) / 2 - r.top) / state.scale, 0, pg.h),
  };
}

function setupPageEvents(pg) {
  const L = pg.layer;
  L.addEventListener('pointerdown', e => {
    if (e.target !== L) return;
    if (state.textMode) {
      e.preventDefault();
      const p = ptIn(pg, e);
      setTextMode(false);
      addText(pg, p.x, p.y - state.lastText.size * 0.6);
      return;
    }
    if (state.editing) state.editing.el.querySelector('.txt').blur();
    select(null);
  });
  L.addEventListener('dblclick', e => {
    if (e.target !== L) return;
    const p = ptIn(pg, e);
    addText(pg, p.x, p.y - state.lastText.size * 0.6);
  });
  L.addEventListener('dragover', e => {
    const types = [...(e.dataTransfer?.types || [])];
    if (!types.includes('Files') && !types.includes('application/x-tray-image')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    pg.el.classList.add('drop-hover');
  });
  L.addEventListener('dragleave', e => {
    if (!pg.el.contains(e.relatedTarget)) pg.el.classList.remove('drop-hover');
  });
  L.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    pg.el.classList.remove('drop-hover');
    const p = ptIn(pg, e);
    const trayId = e.dataTransfer.getData('application/x-tray-image');
    if (trayId && state.images.has(trayId)) { placeImage(state.images.get(trayId), pg, p.x, p.y); return; }
    const files = [...e.dataTransfer.files];
    const imgs = files.filter(isImageFile);
    if (!imgs.length) {
      const pdf = files.find(isPdfFile);
      if (pdf) openPdf(pdf);
      return;
    }
    const recs = await addImageFiles(imgs);
    recs.forEach((r, i) => placeImage(r, pg, p.x + i * 18, p.y + i * 18));
  });
}

/* ============================================================
   Image tray
   ============================================================ */
async function addImageFiles(files) {
  const out = [];
  for (const f of files) {
    if (!isImageFile(f)) continue;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try { await img.decode(); }
    catch {
      URL.revokeObjectURL(url);
      toast(/\.(heic|heif)$/i.test(f.name)
        ? `“${f.name}” is HEIC — this browser can’t read it. Convert it to JPG/PNG first.`
        : `Couldn’t read “${f.name}” as an image.`, 4500);
      continue;
    }
    const rec = { id: uid('img'), name: f.name || 'pasted image', url, img, nw: img.naturalWidth, nh: img.naturalHeight, alpha: false, pngFriendly: false };
    try { await analyzeImage(rec, f.type || f.name); } catch (err) { console.warn(err); }
    state.images.set(rec.id, rec);
    addThumb(rec);
    out.push(rec);
  }
  return out;
}

/** Transparent images keep PNG; flat screenshots that compress better as PNG are flagged. */
async function analyzeImage(rec, type) {
  if (/jpe?g/i.test(type)) return;
  const tw = Math.min(256, rec.nw), th = Math.max(1, Math.round(tw * rec.nh / rec.nw));
  const c = canvasOf(tw, th);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(rec.img, 0, 0, tw, th);
  const d = ctx.getImageData(0, 0, tw, th).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { rec.alpha = true; break; }
  freeCanvas(c);
  if (rec.alpha) return;
  const cw = Math.min(512, rec.nw), ch = Math.min(512, rec.nh);
  const cc = canvasOf(cw, ch);
  const cx = cc.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch);
  cx.drawImage(rec.img, (rec.nw - cw) / 2, (rec.nh - ch) / 2, cw, ch, 0, 0, cw, ch);
  const [p, j] = await Promise.all([toBlob(cc, 'image/png'), toBlob(cc, 'image/jpeg', 0.92)]);
  rec.pngFriendly = p.size <= j.size * 1.05;
  freeCanvas(cc);
}

function addThumb(rec) {
  const t = h('div', 'thumb');
  t.draggable = true;
  t.tabIndex = 0;
  t.title = `${rec.name} — drag onto a page, or click to add`;
  const im = h('img'); im.src = rec.url; im.alt = rec.name;
  const count = h('span', 'count'); count.hidden = true;
  const x = h('button', 'x'); x.type = 'button'; x.textContent = '×'; x.title = 'Remove from tray'; x.setAttribute('aria-label', 'Remove image');
  t.append(im, count, x);
  rec.thumb = t; rec.countEl = count;
  t.addEventListener('dragstart', e => {
    e.dataTransfer.setData('application/x-tray-image', rec.id);
    e.dataTransfer.effectAllowed = 'copy';
    try { e.dataTransfer.setDragImage(im, 30, 30); } catch {}
  });
  const add = () => {
    const f = focusPoint();
    if (!f) { toast('Open a PDF first (or start with a blank page).'); return; }
    placeImage(rec, f.pg, f.x, f.y);
  };
  t.addEventListener('click', e => { if (!e.target.closest('.x')) add(); });
  t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); } });
  x.addEventListener('click', e => {
    e.stopPropagation();
    const placed = state.items.filter(i => i.imgId === rec.id);
    if (placed.length && !confirm(`This image is placed ${placed.length} time(s). Remove it from the pages too?`)) return;
    placed.forEach(removeItem);
    state.images.delete(rec.id);
    t.remove();
    URL.revokeObjectURL(rec.url);
  });
  els.trayAdd.before(t);
}

function updateTrayCounts() {
  for (const rec of state.images.values()) {
    const n = state.items.filter(i => i.imgId === rec.id).length;
    rec.countEl.hidden = n === 0;
    rec.countEl.textContent = `${n} placed`;
  }
}

/* ============================================================
   Items: images and text boxes
   ============================================================ */
function placeImage(rec, pg, cx, cy) {
  let w = rec.nw * 0.75, hgt = rec.nh * 0.75;             // 96 dpi pixels -> points
  const k = Math.min(1, (pg.w * 0.8) / w, (pg.h * 0.6) / hgt);
  w *= k; hgt *= k;
  if (w < 40 && hgt < 40) { const u = 40 / Math.max(w, hgt); w *= u; hgt *= u; }
  const it = { id: uid('it'), type: 'image', pageId: pg.id, imgId: rec.id, x: cx - w / 2, y: cy - hgt / 2, w, h: hgt };
  clampItem(it, pg);
  // cascade instead of stacking exactly on top of an existing image
  for (let n = 0; n < 30; n++) {
    const clash = state.items.some(o => o.pageId === pg.id && o.type === 'image' && Math.abs(o.x - it.x) < 4 && Math.abs(o.y - it.y) < 4);
    if (!clash) break;
    it.x += 18; it.y += 18;
    if (it.x + it.w > pg.w || it.y + it.h > pg.h) { it.x = Math.max(0, it.x - 18 * (n + 1)) + 6; it.y = Math.max(0, it.y - 18 * (n + 1)); }
    clampItem(it, pg);
  }
  state.items.push(it);
  mountItem(it);
  select(it);
  updateTrayCounts();
  return it;
}

function addText(pg, x, y, props = {}) {
  const it = { id: uid('it'), type: 'text', pageId: pg.id, x, y, text: '', w: 10, h: 10, ...state.lastText, ...props };
  state.items.push(it);
  mountItem(it);
  clampItem(it, pg); placeItemEl(it);
  select(it);
  if (!props.text) startEditing(it);
  return it;
}

const GRIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';

function mountItem(it) {
  const pg = pageById(it.pageId);
  const d = h('div', `item ${it.type}`);
  it.el = d;
  if (it.type === 'image') {
    const im = h('img'); im.src = state.images.get(it.imgId).url; im.draggable = false; im.alt = '';
    d.append(im);
    for (const c of ['nw', 'ne', 'sw', 'se']) { const hd = h('div', `handle ${c}`); hd.dataset.corner = c; d.append(hd); }
  } else {
    const t = h('div', 'txt');
    t.spellcheck = false;
    t.textContent = it.text;
    const grip = h('div', 'grip'); grip.title = 'Drag to move'; grip.innerHTML = GRIP_SVG;
    d.append(t, grip);
    t.addEventListener('input', () => { it.text = readText(t); measureText(it); });
    t.addEventListener('blur', () => stopEditing(it));
    t.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); t.blur(); }
    });
    t.addEventListener('paste', e => {
      e.stopPropagation();
      const s = e.clipboardData?.getData('text/plain');
      e.preventDefault();
      if (s) document.execCommand('insertText', false, s);
    });
    t.addEventListener('drop', e => e.preventDefault());
  }
  d.addEventListener('pointerdown', e => onItemPointerDown(e, it));
  pg.layer.append(d);
  placeItemEl(it);
}

function readText(t) {
  return t.innerText.replace(/ /g, ' ').replace(/\r/g, '');
}

function placeItemEl(it) {
  const s = state.scale, d = it.el;
  if (!d) return;
  d.style.left = `${it.x * s}px`;
  d.style.top = `${it.y * s}px`;
  if (it.type === 'image') {
    d.style.width = `${it.w * s}px`;
    d.style.height = `${it.h * s}px`;
  } else {
    const t = d.firstChild;
    t.style.fontSize = `${it.size * s}px`;
    t.style.fontFamily = FONTS[it.font].css;
    t.style.fontWeight = it.bold ? '700' : '400';
    t.style.color = it.color;
    measureText(it);
  }
}

function measureText(it) {
  const r = it.el.getBoundingClientRect();
  if (r.width || r.height) { it.w = r.width / state.scale; it.h = r.height / state.scale; }
}

function clampItem(it, pg) {
  it.x = clamp(it.x, Math.min(0, pg.w - it.w), Math.max(0, pg.w - it.w));
  it.y = clamp(it.y, Math.min(0, pg.h - it.h), Math.max(0, pg.h - it.h));
}

function removeItem(it) {
  if (state.editing === it) state.editing = null;
  if (state.selected === it) select(null);
  it.el?.remove();
  const i = state.items.indexOf(it);
  if (i >= 0) state.items.splice(i, 1);
  updateTrayCounts();
}

function duplicateItem(it) {
  const pg = pageById(it.pageId);
  const copy = { ...it, id: uid('it'), x: it.x + 14, y: it.y + 14, el: null };
  clampItem(copy, pg);
  state.items.push(copy);
  mountItem(copy);
  select(copy);
  updateTrayCounts();
}

function startEditing(it) {
  if (state.editing && state.editing !== it) state.editing.el.querySelector('.txt').blur();
  state.editing = it;
  it.el.classList.add('editing');
  const t = it.el.querySelector('.txt');
  t.contentEditable = PLAINTEXT_ONLY ? 'plaintext-only' : 'true';
  t.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(t);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
}

function stopEditing(it) {
  if (state.editing !== it) return;
  state.editing = null;
  it.el.classList.remove('editing');
  const t = it.el.querySelector('.txt');
  t.contentEditable = 'false';
  it.text = readText(t);
  if (!it.text.trim()) { removeItem(it); return; }
  measureText(it);
}

function select(it) {
  if (state.selected && state.selected !== it) state.selected.el?.classList.remove('selected');
  state.selected = it;
  if (it) it.el.classList.add('selected');
  updateSelbar();
}

function updateSelbar() {
  const it = state.selected;
  els.selbar.hidden = !it;
  if (!it) return;
  $('.text-only', els.selbar).hidden = it.type !== 'text';
  $('.img-only', els.selbar).hidden = it.type !== 'image';
  if (it.type === 'text') {
    els.fFont.value = it.font;
    els.fSize.value = Math.round(it.size * 10) / 10;
    els.fBold.setAttribute('aria-pressed', String(!!it.bold));
    els.fColor.value = it.color;
  }
}

function onItemPointerDown(e, it) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const handle = e.target.closest('.handle');
  if (handle) {
    e.preventDefault(); e.stopPropagation();
    select(it);
    startResize(e, it, handle.dataset.corner);
    return;
  }
  if (it.type === 'text' && state.editing === it && !e.target.closest('.grip')) { e.stopPropagation(); return; }
  e.preventDefault(); e.stopPropagation();
  const wasSelected = state.selected === it;
  if (state.editing && state.editing !== it) state.editing.el.querySelector('.txt').blur();
  select(it);
  startMove(e, it, () => { if (it.type === 'text' && wasSelected && state.editing !== it) startEditing(it); });
}

function autoScroll(cy) {
  const r = els.viewer.getBoundingClientRect();
  const edge = 50;
  if (cy < r.top + edge) els.viewer.scrollTop -= Math.ceil((r.top + edge - cy) / 3);
  else if (cy > r.bottom - edge) els.viewer.scrollTop += Math.ceil((cy - (r.bottom - edge)) / 3);
}

function startMove(e, it, onClick) {
  const s = state.scale;
  const sx = e.clientX, sy = e.clientY;
  const r0 = it.el.getBoundingClientRect();
  const gx = (sx - r0.left) / s, gy = (sy - r0.top) / s;
  let moved = false;
  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    if (!moved && state.editing === it) it.el.querySelector('.txt').blur();
    moved = true;
    it.el.classList.add('dragging');
    let pg = pageById(it.pageId);
    const over = pageAtPoint(ev.clientX, ev.clientY);
    if (over && over !== pg) {
      over.layer.append(it.el);
      it.pageId = over.id;
      state.items.splice(state.items.indexOf(it), 1);
      state.items.push(it);
      pg = over;
    }
    const r = pg.el.getBoundingClientRect();
    it.x = (ev.clientX - r.left) / s - gx;
    it.y = (ev.clientY - r.top) / s - gy;
    clampItem(it, pg);
    placeItemEl(it);
    autoScroll(ev.clientY);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    it.el.classList.remove('dragging');
    if (!moved && onClick) onClick();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function startResize(e, it, corner) {
  const pg = pageById(it.pageId);
  const ar = it.w / it.h;
  const ax = corner.includes('w') ? it.x + it.w : it.x;
  const ay = corner.includes('n') ? it.y + it.h : it.y;
  const move = ev => {
    const p = ptIn(pg, ev);
    let w = Math.abs(p.x - ax), hgt = Math.abs(p.y - ay);
    if (!ev.shiftKey) { if (w / hgt > ar) hgt = w / ar; else w = hgt * ar; }
    w = Math.max(w, 12); hgt = Math.max(hgt, 12);
    let x = corner.includes('w') ? ax - w : ax;
    let y = corner.includes('n') ? ay - hgt : ay;
    // keep inside the page
    if (x < 0 || y < 0 || x + w > pg.w || y + hgt > pg.h) {
      const maxW = corner.includes('w') ? ax : pg.w - ax;
      const maxH = corner.includes('n') ? ay : pg.h - ay;
      const k = Math.min(1, maxW / w, maxH / hgt);
      w *= k; hgt *= k;
      x = corner.includes('w') ? ax - w : ax;
      y = corner.includes('n') ? ay - hgt : ay;
    }
    Object.assign(it, { x, y, w, h: hgt });
    placeItemEl(it);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function setTextMode(on) {
  state.textMode = on;
  els.btnText.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('text-mode', on);
  if (on) toast('Click anywhere on a page to place text');
}

function styleText(patch) {
  const it = state.selected;
  if (!it || it.type !== 'text') return;
  Object.assign(it, patch);
  Object.assign(state.lastText, patch);
  placeItemEl(it);
  clampItem(it, pageById(it.pageId));
  placeItemEl(it);
  updateSelbar();
}

/* ============================================================
   Export: build the PDF and squeeze it to just under the limit
   ============================================================ */

/** Quality ladder for images placed on original (vector) pages. L in [0, 2]. */
function vecParams(L) {
  if (L >= 1) { const t = L - 1; return { dpi: 300 + 300 * t, q: 0.95 + 0.03 * t }; }
  if (L >= 0.5) { const t = (L - 0.5) / 0.5; return { dpi: 150 + 150 * t, q: 0.80 + 0.15 * t }; }
  const t = L / 0.5; return { dpi: 60 + 90 * t, q: 0.40 + 0.40 * t };
}
/** Quality ladder when whole pages have to be flattened to images. L in [0, 1]. */
function rasParams(L) {
  if (L >= 0.5) { const t = (L - 0.5) / 0.5; return { dpi: 120 + 100 * t, q: 0.75 + 0.17 * t }; }
  const t = L / 0.5; return { dpi: 50 + 70 * t, q: 0.35 + 0.40 * t };
}
const RAS_MAX_DPI = 220;

let winAnsi = null;
async function getWinAnsi() {
  if (winAnsi) return winAnsi;
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  winAnsi = new Set(f.getCharacterSet());
  return winAnsi;
}

const baselineCache = new Map();
function baselineRatio(font, bold) {
  const key = `${font}|${bold}`;
  if (baselineCache.has(key)) return baselineCache.get(key);
  const d = h('div');
  d.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:100px;line-height:${LINE};font-family:${FONTS[font].css};font-weight:${bold ? 700 : 400}`;
  d.innerHTML = 'Hg<span style="display:inline-block;width:1px;height:0;vertical-align:baseline"></span>';
  document.body.append(d);
  const b = d.querySelector('span').offsetTop / 100;
  d.remove();
  baselineCache.set(key, b);
  return b;
}

function textLines(it) {
  const lines = it.text.replace(/\t/g, '    ').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Text with characters the built-in PDF fonts can't encode (₹, θ, ≤, Hindi, emoji…) is drawn as a crisp image. */
function drawTextOnCanvas(ctx, it, k, ox = 0, oy = 0) {
  ctx.font = `${it.bold ? 700 : 400} ${it.size * k}px ${FONTS[it.font].css}`;
  ctx.fillStyle = it.color;
  ctx.textBaseline = 'alphabetic';
  const base = baselineRatio(it.font, it.bold) * it.size;
  textLines(it).forEach((line, i) => ctx.fillText(line, ox + it.x * k, oy + (it.y + base + i * LINE * it.size) * k));
}

async function textToPng(it) {
  const k = 300 / 72;
  const c = canvasOf(Math.ceil(it.w * k) + 4, Math.ceil(it.h * k) + 4);
  drawTextOnCanvas(c.getContext('2d'), it, k, -it.x * k, -it.y * k);
  const bytes = await blobBytes(await toBlob(c, 'image/png'));
  const res = { bytes, w: c.width / k, h: c.height / k };
  freeCanvas(c);
  return res;
}

function activeTexts() {
  return state.items.filter(i => i.type === 'text' && i.text.trim());
}

async function classifyTexts() {
  const set = await getWinAnsi();
  const vector = [], fancy = [];
  for (const it of activeTexts()) {
    measureText(it);
    const ok = [...textLines(it).join('')].every(ch => set.has(ch.codePointAt(0)));
    (ok ? vector : fancy).push(it);
  }
  return { vector, fancy };
}

function pageTransform(pg, flattened) {
  if (pg.src != null && !flattened) {
    return { T: (x, y) => pg.vp.convertToPdfPoint(x, y), R: pg.rot };
  }
  return { T: (x, y) => [x, pg.h - y], R: 0 };
}

async function drawVectorText(doc, pdfPage, pg, it, fonts, flattened) {
  const name = FONTS[it.font].std[it.bold ? 1 : 0];
  if (!fonts.has(name)) fonts.set(name, await doc.embedFont(StandardFonts[name]));
  const font = fonts.get(name);
  const { T, R } = pageTransform(pg, flattened);
  const base = baselineRatio(it.font, it.bold) * it.size;
  const color = hexToRgb(it.color);
  textLines(it).forEach((line, i) => {
    if (!line.trim()) return;
    const [x, y] = T(it.x, it.y + base + i * LINE * it.size);
    pdfPage.drawText(line, { x, y, size: it.size, font, color, rotate: degrees(R) });
  });
}

/* ---------- Mode A: keep the original pages, recompress only the added images ---------- */

async function buildVectorDoc(encs, textPngs, vectorTexts) {
  const out = await PDFDocument.create();
  const srcIdx = state.pages.filter(p => p.src != null).map(p => p.src);
  let copied = [];
  if (srcIdx.length) {
    const src = await PDFDocument.load(state.baseBytes, { updateMetadata: false });
    copied = await out.copyPages(src, srcIdx);
  }
  const pdfPages = new Map();
  let ci = 0;
  for (const pg of state.pages) pdfPages.set(pg.id, pg.src != null ? out.addPage(copied[ci++]) : out.addPage([pg.w, pg.h]));
  const fonts = new Map(), embedded = new Map();
  const vecSet = new Set(vectorTexts);
  for (const it of state.items) {
    const pg = pageById(it.pageId), page = pdfPages.get(pg.id);
    const { T, R } = pageTransform(pg, false);
    if (it.type === 'image') {
      const e = encs && encs.get(it.id);
      if (!e) continue;
      if (!embedded.has(e.key)) embedded.set(e.key, e.fmt === 'png' ? await out.embedPng(e.bytes) : await out.embedJpg(e.bytes));
      const [x, y] = T(it.x, it.y + it.h);
      page.drawImage(embedded.get(e.key), { x, y, width: it.w, height: it.h, rotate: degrees(R) });
    } else if (textPngs.has(it.id)) {
      const tp = textPngs.get(it.id);
      const im = await out.embedPng(tp.bytes);
      const [x, y] = T(it.x, it.y + tp.h);
      page.drawImage(im, { x, y, width: tp.w, height: tp.h, rotate: degrees(R) });
    } else if (vecSet.has(it)) {
      await drawVectorText(out, page, pg, it, fonts, false);
    }
  }
  out.setTitle(state.name);
  out.setProducer('Assignment PDF Editor');
  return out.save({ useObjectStreams: true });
}

async function searchVector(cap, ui) {
  const { vector, fancy } = await classifyTexts();
  const textPngs = new Map();
  for (const it of fancy) textPngs.set(it.id, await textToPng(it));
  ui.status('Reading your PDF…');
  const baseBytes = await buildVectorDoc(null, textPngs, vector);
  const base = baseBytes.length;
  const imgItems = state.items.filter(i => i.type === 'image');
  ui.log(`Your PDF + text: ${fmtMB(base)}`);
  if (!imgItems.length) {
    return base <= cap ? { bytes: baseBytes, mode: 'vector', L: null, base } : { fail: true, base };
  }
  if (base > cap * 0.92) return { fail: true, base };

  // A high-quality source canvas per image, sized for the best quality level it could ever need.
  const sources = new Map();
  const top = vecParams(2);
  for (const it of imgItems) {
    const rec = state.images.get(it.imgId);
    const need = Math.min(rec.nw, Math.ceil(Math.max(it.w / 72 * top.dpi, (it.h / 72 * top.dpi) * rec.nw / rec.nh)));
    const prev = sources.get(rec.id);
    if (!prev || prev.need < need) sources.set(rec.id, { need });
  }
  ui.status('Preparing images…');
  for (const [id, s] of sources) {
    const rec = state.images.get(id);
    const sw = s.need, sh = Math.max(1, Math.round(s.need * rec.nh / rec.nw));
    // Near-native sizes just reuse the decoded image (saves a lot of memory on phones).
    s.canvas = sw >= rec.nw * 0.85 ? rec.img : resample(rec.img, sw, sh, false);
    await tick();
  }

  const cache = new Map();
  const encodeItem = async (it, L) => {
    const rec = state.images.get(it.imgId);
    const { dpi, q } = vecParams(L);
    const pw = Math.max(1, Math.round(Math.min(rec.nw, it.w / 72 * dpi)));
    const ph = Math.max(1, Math.round(Math.min(rec.nh, it.h / 72 * dpi)));
    const fmt = rec.alpha || (rec.pngFriendly && L >= 0.5) ? 'png' : 'jpg';
    const key = `${rec.id}|${pw}x${ph}|${fmt}|${fmt === 'jpg' ? q.toFixed(3) : ''}`;
    if (cache.has(key)) return cache.get(key);
    const src = sources.get(rec.id).canvas;
    const c = resample(src, pw, ph, !rec.alpha);
    const bytes = await blobBytes(await toBlob(c, fmt === 'png' ? 'image/png' : 'image/jpeg', q));
    freeCanvas(c);
    const v = { key, fmt, bytes, pw, ph, q };
    cache.set(key, v);
    return v;
  };
  const sizeAt = async L => {
    const encs = new Map(), seen = new Set();
    let sum = 0;
    for (const it of imgItems) {
      const e = await encodeItem(it, L);
      encs.set(it.id, e);
      if (!seen.has(e.key)) { seen.add(e.key); sum += e.bytes.length + 260; }
      sum += 90;
    }
    return { total: base + sum, encs, L };
  };
  const describe = L => { const p = vecParams(L); return `images ~${Math.round(p.dpi)} DPI, quality ${Math.round(p.q * 100)}%`; };

  let capAdj = cap;
  for (let attempt = 0; attempt < 4; attempt++) {
    const best = await searchLevel(sizeAt, capAdj, 0, 2, ui, describe);
    if (!best) break;
    ui.status('Building the final PDF…');
    const bytes = await buildVectorDoc(best.r.encs, textPngs, vector);
    if (bytes.length <= cap) {
      for (const s of sources.values()) if (s.canvas instanceof HTMLCanvasElement) freeCanvas(s.canvas);
      return { bytes, mode: 'vector', L: best.L, top: best.top, desc: describe(best.L), base };
    }
    ui.log(`Final file was ${fmtMB(bytes.length)} — adjusting`, 'no');
    capAdj -= (bytes.length - cap) + 15000;
  }
  for (const s of sources.values()) if (s.canvas instanceof HTMLCanvasElement) freeCanvas(s.canvas);
  return { fail: true, base };
}

/* ---------- Mode B: flatten every page to an image (for PDFs that are already huge) ---------- */

async function rasterizePage(pg, fancy) {
  let k = RAS_MAX_DPI / 72;
  if (pg.w * pg.h * k * k > 14e6) k = Math.sqrt(14e6 / (pg.w * pg.h));
  const W = Math.round(pg.w * k), H = Math.round(pg.h * k);
  const c = canvasOf(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  if (pg.pdfPage) {
    const vp = pg.pdfPage.getViewport({ scale: k });
    await pg.pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
  }
  for (const it of state.items) {
    if (it.pageId !== pg.id) continue;
    if (it.type === 'image') {
      const rec = state.images.get(it.imgId);
      const r = resample(rec.img, Math.min(rec.nw, it.w * k), Math.min(rec.nh, it.h * k), false);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(r, it.x * k, it.y * k, it.w * k, it.h * k);
      freeCanvas(r);
    } else if (fancy.includes(it)) {
      drawTextOnCanvas(ctx, it, k);
    }
  }
  const blob = await toBlob(c, 'image/jpeg', 0.95);
  freeCanvas(c);
  return { blob, W, H };
}

async function buildRasterDoc(encs, vectorTexts) {
  const out = await PDFDocument.create();
  const fonts = new Map();
  for (let i = 0; i < state.pages.length; i++) {
    const pg = state.pages[i];
    const page = out.addPage([pg.w, pg.h]);
    if (encs) {
      const im = await out.embedJpg(encs[i].bytes);
      page.drawImage(im, { x: 0, y: 0, width: pg.w, height: pg.h });
    }
    for (const it of vectorTexts) if (it.pageId === pg.id) await drawVectorText(out, page, pg, it, fonts, true);
  }
  out.setTitle(state.name);
  out.setProducer('Assignment PDF Editor');
  return out.save({ useObjectStreams: true });
}

async function searchRaster(cap, ui) {
  const { vector, fancy } = await classifyTexts();
  const prep = [];
  for (let i = 0; i < state.pages.length; i++) {
    ui.status(`Flattening page ${i + 1} of ${state.pages.length}…`);
    prep.push(await rasterizePage(state.pages[i], fancy));
  }
  const base = (await buildRasterDoc(null, vector)).length;
  const cache = new Map();
  const encodePage = async (i, L) => {
    const { dpi, q } = rasParams(L);
    const pg = state.pages[i], p = prep[i];
    const tw = Math.min(p.W, Math.round(pg.w / 72 * dpi)), th = Math.min(p.H, Math.round(pg.h / 72 * dpi));
    const key = `${i}|${tw}x${th}|${q.toFixed(3)}`;
    if (cache.has(key)) return cache.get(key);
    const bmp = await createImageBitmap(p.blob);
    const c = resample(bmp, tw, th, true);
    bmp.close && bmp.close();
    const bytes = await blobBytes(await toBlob(c, 'image/jpeg', q));
    freeCanvas(c);
    const v = { bytes };
    cache.set(key, v);
    return v;
  };
  const sizeAt = async L => {
    const encs = [];
    let sum = 0;
    for (let i = 0; i < prep.length; i++) { const e = await encodePage(i, L); encs.push(e); sum += e.bytes.length + 300; }
    return { total: base + sum, encs, L };
  };
  const describe = L => { const p = rasParams(L); return `pages ~${Math.round(p.dpi)} DPI, quality ${Math.round(p.q * 100)}%`; };

  let capAdj = cap;
  for (let attempt = 0; attempt < 4; attempt++) {
    const best = await searchLevel(sizeAt, capAdj, 0, 1, ui, describe);
    if (!best) break;
    ui.status('Building the final PDF…');
    const bytes = await buildRasterDoc(best.r.encs, vector);
    if (bytes.length <= cap) return { bytes, mode: 'raster', L: best.L, top: best.top, desc: describe(best.L) };
    ui.log(`Final file was ${fmtMB(bytes.length)} — adjusting`, 'no');
    capAdj -= (bytes.length - cap) + 15000;
  }
  const min = await sizeAt(0);
  return { fail: true, min: min.total };
}

/**
 * Find the highest quality level L whose output fits under `cap`,
 * stopping as soon as we land in the [FIT_LOW * cap, cap] window.
 */
async function searchLevel(sizeAt, cap, Lmin, Lmax, ui, describe) {
  const tryL = async L => {
    ui.status(`Trying ${describe(L)}…`);
    const r = await sizeAt(L);
    const ok = r.total <= cap;
    ui.log(`${describe(L)} → ${fmtMB(r.total)} ${ok ? '✓ fits' : '✗ too big'}`, ok ? 'ok' : 'no');
    return { L, r };
  };
  let hi = await tryL(Lmax);
  if (hi.r.total <= cap) return { ...hi, top: true };
  let lo = await tryL(Lmin);
  if (lo.r.total > cap) return null;
  const target = cap * (1 + FIT_LOW) / 2;
  for (let i = 0; i < 14; i++) {
    if (lo.r.total >= cap * FIT_LOW) break;
    const span = hi.L - lo.L;
    if (span < 0.002) break;
    const a = Math.log(lo.r.total), b = Math.log(hi.r.total);
    let L = lo.L + span * (Math.log(target) - a) / (b - a);
    L = clamp(L, lo.L + span * 0.08, hi.L - span * 0.08);
    const cur = await tryL(L);
    if (cur.r.total <= cap) lo = cur; else hi = cur;
  }
  return lo;
}

async function compressToFit(cap, ui) {
  let vecRes = null;
  let canVector = true;
  if (state.baseBytes) {
    try {
      const d = await PDFDocument.load(state.baseBytes, { updateMetadata: false });
      if (d.isEncrypted) canVector = false;
    } catch (err) {
      console.warn('pdf-lib could not load this PDF; flattening instead', err);
      canVector = false;
    }
  }
  if (canVector) {
    try { vecRes = await searchVector(cap, ui); }
    catch (err) { console.warn('vector export failed, flattening instead', err); vecRes = { fail: true }; }
    const good = vecRes && !vecRes.fail && (vecRes.L == null || vecRes.L >= 0.15 || vecRes.base < cap * 0.5);
    if (good) return vecRes;
    ui.log(vecRes && !vecRes.fail
      ? 'Images would get very blurry — trying to flatten the pages instead'
      : 'Original PDF is too big on its own — flattening pages to fit', 'no');
  } else {
    ui.log('This PDF can’t be edited directly — flattening pages to fit', 'no');
  }
  const rasRes = await searchRaster(cap, ui);
  if (!rasRes.fail) return rasRes;
  if (vecRes && !vecRes.fail) return vecRes;
  return { fail: true, min: rasRes.min };
}

/* ---------- Download flow ---------- */

/* ---------- static ads in the download dialog (configured in ads.js) ---------- */
let adShownAt = 0;
let countdownTimer = null;
function showAd() {
  const ads = (Array.isArray(window.APE_ADS) ? window.APE_ADS : []).filter(a => a && a.image);
  const el = $('#mAd');
  if (!ads.length) { el.hidden = true; adShownAt = 0; return; }
  const ad = ads[Math.floor(Math.random() * ads.length)];
  const img = el.querySelector('img');
  img.src = ad.image;
  img.alt = ad.alt || 'Advertisement';
  if (ad.link) el.href = ad.link; else el.removeAttribute('href');
  el.hidden = false;
  adShownAt = Date.now();
}
function unlockDownload() {
  clearInterval(countdownTimer);
  const btn = els.mAgain;
  btn.hidden = false;
  const wait = adShownAt ? Math.max(0, Number(window.APE_AD_SECONDS) || 0) * 1000 - (Date.now() - adShownAt) : 0;
  const ready = () => { btn.disabled = false; btn.textContent = 'Download PDF'; };
  if (wait <= 0) { ready(); return; }
  const end = Date.now() + wait;
  btn.disabled = true;
  const tickFn = () => {
    const s = Math.ceil((end - Date.now()) / 1000);
    if (s <= 0) { clearInterval(countdownTimer); ready(); }
    else btn.textContent = `Download in ${s}s…`;
  };
  tickFn();
  countdownTimer = setInterval(tickFn, 250);
}

function makeUI() {
  els.mLog.innerHTML = '';
  els.mStatus.textContent = '';
  els.mTitle.textContent = 'Compressing your PDF…';
  els.mBarWrap.className = 'bar';
  els.mAgain.hidden = true;
  els.mClose.textContent = 'Close';
  els.modal.hidden = false;
  showAd();
  return {
    status: t => { els.mStatus.textContent = t; },
    log: (t, cls) => {
      const li = h('li'); li.textContent = t; if (cls) li.className = cls;
      els.mLog.append(li); els.mLog.scrollTop = els.mLog.scrollHeight;
    },
  };
}

function triggerDownload(bytes) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = h('a');
  a.href = url;
  a.download = `${state.name}_final.pdf`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportPdf() {
  if (state.busy || !state.pages.length) return;
  if (state.editing) state.editing.el.querySelector('.txt').blur();
  const limitMB = parseFloat(els.limit.value);
  if (!(limitMB > 0.2)) { toast('Set a valid size limit first.'); els.limit.focus(); return; }
  const cap = Math.floor(limitMB * MB * SAFETY);
  state.busy = true;
  els.btnDownload.disabled = true;
  const ui = makeUI();
  ui.log(`Target: under ${fmtMB(cap)} (limit ${limitMB} MB, with a small safety margin)`);
  await document.fonts.ready.catch(() => {});
  try {
    const res = await compressToFit(cap, ui);
    if (res.fail) {
      els.mBarWrap.className = 'bar fail';
      els.mTitle.textContent = 'Couldn’t fit under the limit';
      els.mStatus.textContent = `Even at the lowest quality this would be about ${fmtMB(res.min || 0)}. Remove some images or pages, or raise the limit.`;
      return;
    }
    state.lastExport = res.bytes;
    els.mBarWrap.className = 'bar done';
    els.mTitle.textContent = 'Your PDF is ready';
    let note;
    if (res.mode === 'vector' && res.L == null) note = 'No images to compress — your PDF already fits.';
    else if (res.top) note = res.mode === 'vector'
      ? 'Everything fits at full quality — images kept at their original resolution. No visible compression was needed.'
      : `Everything fits at maximum quality (${res.desc}).`;
    else if (res.mode === 'vector') note = `Original pages kept sharp; ${res.desc}.`;
    else note = `Your original PDF was too large on its own, so pages were flattened (${res.desc}).`;
    els.mStatus.innerHTML = '';
    const big = h('span', 'big'); big.textContent = fmtMB(res.bytes.length);
    const small = h('span'); small.textContent = note;
    els.mStatus.append(big, small);
    els.mClose.textContent = 'Back to editing';
    unlockDownload();
  } catch (err) {
    console.error(err);
    els.mBarWrap.className = 'bar fail';
    els.mTitle.textContent = 'Something went wrong';
    els.mStatus.textContent = String(err && err.message || err);
  } finally {
    state.busy = false;
    els.btnDownload.disabled = !state.pages.length;
  }
}

/* ============================================================
   Wiring
   ============================================================ */
$('#btnOpen').addEventListener('click', () => els.pdfInput.click());
$('#emptyOpen').addEventListener('click', () => els.pdfInput.click());
$('#emptyBlank').addEventListener('click', startBlank);
$('#btnImages').addEventListener('click', () => els.imgInput.click());
els.trayAdd.addEventListener('click', () => els.imgInput.click());
els.pdfInput.addEventListener('change', () => { const f = els.pdfInput.files[0]; if (f) openPdf(f); els.pdfInput.value = ''; });
els.imgInput.addEventListener('change', async () => {
  const files = [...els.imgInput.files];
  els.imgInput.value = '';
  const recs = await addImageFiles(files);
  if (recs.length) toast(state.pages.length
    ? `${recs.length} image${recs.length > 1 ? 's' : ''} added — drag onto a page or tap to place`
    : `${recs.length} image${recs.length > 1 ? 's' : ''} added — now open your PDF`);
});
els.btnText.addEventListener('click', () => {
  if (!state.pages.length) { toast('Open a PDF first (or start with a blank page).'); return; }
  setTextMode(!state.textMode);
});
els.btnDownload.addEventListener('click', exportPdf);
$('#zoomIn').addEventListener('click', () => setZoom(state.scale * 1.2));
$('#zoomOut').addEventListener('click', () => setZoom(state.scale / 1.2));
els.zoomFit.addEventListener('click', () => { state.fit = true; state.scale = fitScale(); applyScale(true); });
window.addEventListener('resize', () => {
  if (!state.fit || !state.pages.length) return;
  const s = fitScale();
  if (Math.abs(s - state.scale) > 0.005) { state.scale = s; applyScale(true); }
});

try { const saved = localStorage.getItem('ape-limit'); if (saved) els.limit.value = saved; } catch {}
els.limit.addEventListener('change', () => { try { localStorage.setItem('ape-limit', els.limit.value); } catch {} });

els.mClose.addEventListener('click', () => { if (!state.busy) els.modal.hidden = true; });
els.mAgain.addEventListener('click', () => state.lastExport && triggerDownload(state.lastExport));

// selection toolbar — keep focus in the text box while clicking buttons
els.selbar.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.preventDefault(); });
els.fFont.addEventListener('change', () => styleText({ font: els.fFont.value }));
els.fSize.addEventListener('change', () => { const v = parseFloat(els.fSize.value); if (v > 0) styleText({ size: clamp(v, 4, 300) }); });
$('#fSmaller').addEventListener('click', () => state.selected && styleText({ size: Math.max(4, Math.round(state.selected.size - 1)) }));
$('#fBigger').addEventListener('click', () => state.selected && styleText({ size: Math.min(300, Math.round(state.selected.size + 1)) }));
els.fBold.addEventListener('click', () => state.selected && styleText({ bold: !state.selected.bold }));
els.fColor.addEventListener('input', () => styleText({ color: els.fColor.value }));
$('#iFit').addEventListener('click', () => {
  const it = state.selected;
  if (!it || it.type !== 'image') return;
  const pg = pageById(it.pageId);
  const margin = Math.min(36, pg.w * 0.06);
  const ar = it.w / it.h;
  let w = pg.w - margin * 2, hgt = w / ar;
  if (hgt > pg.h - margin * 2) { hgt = pg.h - margin * 2; w = hgt * ar; }
  Object.assign(it, { w, h: hgt, x: (pg.w - w) / 2 });
  clampItem(it, pg);
  placeItemEl(it);
});
$('#sDup').addEventListener('click', () => state.selected && duplicateItem(state.selected));
$('#sDel').addEventListener('click', () => state.selected && removeItem(state.selected));

// clicking the grey area around pages deselects
els.viewer.addEventListener('pointerdown', e => {
  if (e.target === els.viewer || e.target === els.pages || e.target.classList.contains('page-block')) {
    if (state.editing) state.editing.el.querySelector('.txt').blur();
    select(null);
  }
});

const isField = el => el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
document.addEventListener('keydown', e => {
  if (isField(document.activeElement) || state.editing) return;
  const it = state.selected;
  if (e.key === 'Escape') { setTextMode(false); select(null); return; }
  if (!it) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeItem(it); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateItem(it); return; }
  if (e.key === 'Enter' && it.type === 'text') { e.preventDefault(); startEditing(it); return; }
  const step = e.shiftKey ? 10 : 1;
  const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (mv) {
    e.preventDefault();
    it.x += mv[0]; it.y += mv[1];
    clampItem(it, pageById(it.pageId));
    placeItemEl(it);
  }
});

// paste screenshots straight onto the page in view
document.addEventListener('paste', async e => {
  if (state.editing || isField(document.activeElement)) return;
  const files = [...(e.clipboardData?.files || [])].filter(isImageFile);
  if (!files.length) return;
  e.preventDefault();
  const recs = await addImageFiles(files);
  const f = focusPoint();
  if (!f) { toast('Image added to the tray — open a PDF to place it.'); return; }
  recs.forEach((r, i) => placeImage(r, f.pg, f.x + i * 18, f.y + i * 18));
});

// drop files anywhere: PDF opens, images go to the tray
window.addEventListener('dragover', e => { e.preventDefault(); if (!state.pages.length) els.dropzone.classList.add('hover'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) els.dropzone.classList.remove('hover'); });
window.addEventListener('drop', async e => {
  e.preventDefault();
  els.dropzone.classList.remove('hover');
  const files = [...(e.dataTransfer?.files || [])];
  const pdf = files.find(isPdfFile);
  if (pdf) { await openPdf(pdf); }
  const imgs = files.filter(isImageFile);
  if (imgs.length) {
    const recs = await addImageFiles(imgs);
    if (recs.length) toast(`${recs.length} image${recs.length > 1 ? 's' : ''} added to the tray — drag onto a page`);
  }
});

window.addEventListener('beforeunload', e => { if (hasWork()) { e.preventDefault(); e.returnValue = ''; } });

// expose a tiny hook for automated tests
window.__ape = { state, openPdf, addImageFiles, placeImage, addText, compressToFit, exportPdf, startBlank, vecParams, select };
