import { inspect, repack, createIdentity, importPrivateKey, parseCertificate, sha256, pngSize } from './rpk.js';
import { readZip, dataOf, crc32 } from './zip.js';

const BUILD = __BUILD__;
const VERSION = { code: 2300, name: '2.3.0' };

(function syncVersion() {
  if (window.__PAGE_VERSION__ === BUILD) return;
  try {
    const key = `rpk-reload-${BUILD}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch { }
  const u = new URL(location.href);
  u.searchParams.set('v', BUILD);
  location.replace(u.toString());
})();

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const te = new TextEncoder();
const hexUpper = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const raf = () => new Promise(r => requestAnimationFrame(() => r()));
const yieldToUI = () => new Promise(resolve => {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    scheduler.yield().then(resolve, resolve);
    return;
  }
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
  ch.port2.postMessage(0);
});

const PAGES = [
  { id: 'overview', label: '包', path: 'M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.2 6.5 3.2L12 10.6 5.5 7.4 12 4.2z' },
  { id: 'edit', label: '编辑', path: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' },
  { id: 'toolbox', label: '工具箱', path: 'M21 6h-2.6l-1.2-1.8A2 2 0 0 0 15.5 3h-7a2 2 0 0 0-1.7 1.2L5.6 6H3a1 1 0 0 0-1 1v4h2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8h2V7a1 1 0 0 0-1-1zm-9 0h3l.8 1H11l.8-1z' },
  { id: 'history', label: '历史', path: 'M13 3a9 9 0 1 0 8.5 12h-2.2A7 7 0 1 1 13 5v3l4-4-4-4v3zm-1 5v5l4 2 .8-1.3-3.3-2V8H12z' },
  { id: 'settings', label: '设置', path: 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.38.12-.6l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.22-.07.46.12.6l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.38-.12.6l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.46-.12-.6l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z' },
];

const DEFAULT_SETTINGS = {
  theme: 'auto',
  optVerify: true,
  optWatch: true,
  record: true,
  storeFiles: true,
  autoIdentity: true,
  updAuto: true,
  updMirror: '',
};

const S = {
  pkg: null,
  identity: null,
  images: {},
  urls: new Map(),
  sizes: new Map(),
  tab: 'images',
  page: 0,
  fileName: '',
  busy: false,
  pending: null,
  dupes: null,
  layer: null,
  stale: false,
  lastExport: null,
  settings: { ...DEFAULT_SETTINGS },
  idMode: 'auto',
  tbOs: 'os4',
  tbCatalog: null,
  history: [],
};

/* ---------- 提示 / 遮罩 ---------- */

let snackTimer = null;
function snack(text) {
  const bar = $('snackbar');
  bar.textContent = text;
  bar.classList.add('is-open');
  document.body.classList.add('snack-open');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => {
    bar.classList.remove('is-open');
    document.body.classList.remove('snack-open');
  }, 3800);
}

let scrimTimer = null;
function showScrim(text, sub = '') {
  clearTimeout(scrimTimer);
  scrimTimer = setTimeout(() => {
    $('scrimText').textContent = text;
    $('scrimSub').textContent = sub;
    $('scrim').hidden = false;
    document.body.classList.add('is-busy');
  }, 140);
}
function setScrimProgress(done, total, label) {
  if (!$('scrim') || $('scrim').hidden) return;
  const bar = $('scrimBar');
  bar.hidden = false;
  bar.firstElementChild.style.width = total ? `${Math.round(done / total * 100)}%` : '0%';
  if (label) $('scrimText').textContent = label;
  $('scrimSub').textContent = total ? `${done} / ${total}` : '';
}
function hideScrim() {
  clearTimeout(scrimTimer);
  $('scrim').hidden = true;
  $('scrimBar').hidden = true;
  $('scrimBar').firstElementChild.style.width = '0%';
  document.body.classList.remove('is-busy');
}

/* ---------- 保存 / 分享 ---------- */

const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function download(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function saveBlob(name, bytes) {
  if (IN_TAURI) {
    try {
      const path = await window.__TAURI__.core.invoke('save_bytes', { name, base64: bytesToBase64(bytes) });
      if (path) snack(`已保存 ${String(path).split(/[\\/]/).pop()}`);
      return true;
    } catch (e) {
      snack(`保存失败：${e}`);
      return false;
    }
  }
  download(name, bytes);
  return true;
}

async function shareBlob(name, bytes) {
  if (IN_TAURI) {
    try {
      await window.__TAURI__.core.invoke('share_bytes', { name, base64: bytesToBase64(bytes) });
      return true;
    } catch (e) {
      snack(`分享失败：${e}`);
      return false;
    }
  }
  const file = new File([bytes], name, { type: 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return true;
    } catch { }
  }
  download(name, bytes);
  return true;
}

/* ---------- 本地存储：IndexedDB ---------- */

const DB_NAME = 'rpk-studio';
const DB_VER = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('history')) {
        const st = db.createObjectStore('history', { keyPath: 'id' });
        st.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbDel(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function saveSettings() {
  try { localStorage.setItem('rpk-settings', JSON.stringify(S.settings)); } catch { }
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('rpk-settings') || '{}');
    S.settings = { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    S.settings = { ...DEFAULT_SETTINGS };
  }
}

/* ---------- 历史记录 ---------- */

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function addHistory(rec, bytes) {
  if (!S.settings.record) return;
  const item = {
    id: uid(),
    at: Date.now(),
    kind: rec.kind,
    file: rec.file || '',
    pkg: rec.pkg || '',
    name: rec.name || '',
    version: rec.version || '',
    size: rec.size || 0,
    verified: rec.verified ?? null,
    hasBlob: Boolean(bytes) && S.settings.storeFiles,
  };
  if (item.hasBlob) item.blob = new Blob([bytes], { type: 'application/octet-stream' });
  await dbPut('history', item);
  await refreshHistory();
}

async function refreshHistory() {
  S.history = await dbAll('history');
  S.history.sort((a, b) => b.at - a.at);
  renderHistory();
  updateStorageHint();
}

function timeLabel(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

function renderHistory() {
  const ul = $('histList');
  ul.textContent = '';
  $('histEmpty').hidden = S.history.length > 0;
  $('clearHistory').disabled = S.history.length === 0;

  for (const item of S.history) {
    const li = document.createElement('li');
    const btn = el('button', 'md-history__item');
    btn.type = 'button';

    const kind = el('span', `md-history__kind md-history__kind--${item.kind === 'export' ? 'export' : 'load'}`,
      item.kind === 'export' ? '导出' : '载入');

    const body = el('span', 'md-history__body');
    body.append(
      el('span', 'md-body-medium', item.pkg || item.file || '—'),
      el('span', 'md-history__meta',
        [item.name, item.version, item.size ? fmtSize(item.size) : '', item.hasBlob ? '' : '仅元数据'].filter(Boolean).join(' · ')),
    );
    btn.append(kind, body, el('span', 'md-history__time', timeLabel(item.at)));
    btn.addEventListener('click', () => openHistorySheet(item));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function openHistorySheet(item) {
  const actions = [];
  if (item.hasBlob) {
    actions.push({
      label: '继续编辑',
      icon: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
      onPick: () => continueFromHistory(item),
    });
    actions.push({
      label: '另存为',
      icon: 'M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4L11 12.2V3zM5 19h14v2H5z',
      onPick: async () => {
        const buf = new Uint8Array(await item.blob.arrayBuffer());
        await saveBlob(item.file || `${item.pkg || 'package'}.rpk`, buf);
      },
    });
  }
  actions.push({
    label: '删除记录',
    icon: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    danger: true,
    onPick: async () => {
      await dbDel('history', item.id);
      await refreshHistory();
      snack('已删除');
    },
  });
  openSheet(item.pkg || item.file || '记录', actions);
}

async function continueFromHistory(item) {
  if (!item.blob) { snack('这条记录没有保存文件'); return; }
  const buf = await item.blob.arrayBuffer();
  const file = new File([buf], item.file || 'restored.rpk', { type: 'application/octet-stream' });
  await loadFile(file, { fromHistory: true });
  goTo(1, true);
}

async function updateStorageHint() {
  const n = S.history.length;
  let bytes = 0;
  for (const h of S.history) if (h.blob) bytes += h.blob.size;
  const id = S.identity ? 1 : 0;
  $('histUsage').textContent = n ? `${n} 条记录 · ${fmtSize(bytes)}` : '暂无记录';
  $('storageHint').textContent = `${n} 条 · ${fmtSize(bytes)}${id ? ' · 已保存身份' : ''}`;
  $('stUsage').textContent = '';
  $('stUsage').append(
    el('dt', null, '历史'), el('dd', null, `${n} 条 · ${fmtSize(bytes)}`),
    el('dt', null, '签名'), el('dd', null, id ? '已保存' : '未保存'),
  );
}

/* ---------- 导航 ---------- */

function buildNav() {
  const icon = p => `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${p}"/></svg>`;
  const html = PAGES.map((v, i) => `
    <button class="md-nav-item" type="button" data-page="${v.id}" data-index="${i}" aria-current="${i === 0 ? 'page' : 'false'}" aria-label="${v.label}">
      <span class="md-nav-item__icon">${icon(v.path)}</span>
      <span class="md-nav-item__label">${v.label}</span>
    </button>`).join('');
  $('rail').innerHTML = html;
  $('navBar').innerHTML = html;

  for (const root of [$('rail'), $('navBar')]) {
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-index]');
      if (!b) return;
      goTo(Number(b.dataset.index), true);
      showNavBar();
    });
  }
}

function pageWidth() {
  return $('pager').clientWidth || 1;
}

function setTrack(x, animate) {
  const track = $('track');
  track.style.transition = animate ? 'transform .34s cubic-bezier(.2, 0, 0, 1)' : 'none';
  track.style.transform = `translate3d(${x}px, 0, 0)`;
}

function goTo(index, animate = true) {
  index = clamp(index, 0, PAGES.length - 1);
  S.page = index;
  setTrack(-index * pageWidth(), animate);
  for (const b of document.querySelectorAll('.md-nav-item')) {
    b.setAttribute('aria-current', Number(b.dataset.index) === index ? 'page' : 'false');
  }
  $('topTitle').textContent = PAGES[index].label;
  showNavBar();
  if (index === 1 && S.stale) {
    S.stale = false;
    if (S.tab === 'files') renderFiles(); else renderImages();
  }
  if (index === 3) refreshHistory();
  if (index === 4) renderSettingsPage();
}

/* ---------- 横向手势 ---------- */

let swipe = null;

function swipeTarget(e) {
  if (S.layer) return false;
  const t = e.target;
  if (!t.closest) return false;
  if (t.closest('input, textarea, select, .md-slider, .md-segmented, [data-no-swipe]')) return false;
  return true;
}

$('pager').addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (!swipeTarget(e)) return;
  swipe = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    t: performance.now(),
    axis: null,
    base: -S.page * pageWidth(),
    dx: 0,
  };
}, { passive: true });

$('pager').addEventListener('pointermove', e => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;

  if (!swipe.axis) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    swipe.axis = Math.abs(dx) > Math.abs(dy) * 1.1 ? 'x' : 'y';
    if (swipe.axis === 'y') { swipe = null; return; }
    try { $('pager').setPointerCapture(e.pointerId); } catch { }
    document.body.classList.add('is-swiping');
  }

  e.preventDefault();
  let off = swipe.base + dx;
  const atEdge = (S.page === 0 && dx > 0) || (S.page === PAGES.length - 1 && dx < 0);
  if (atEdge) off = swipe.base + dx * 0.32;
  swipe.dx = dx;
  setTrack(off, false);
}, { passive: false });

function endSwipe(e) {
  if (!swipe || (e && e.pointerId !== swipe.id)) return;
  const s = swipe;
  swipe = null;
  document.body.classList.remove('is-swiping');
  if (s.axis !== 'x') return;

  const dx = s.dx || 0;
  if (Math.abs(dx) > 8) suppressClick = true;
  const dt = Math.max(1, performance.now() - s.t);
  const v = dx / dt;
  const w = pageWidth();
  let next = S.page;

  if (dx < -w * 0.22 || v < -0.45) next = S.page + 1;
  else if (dx > w * 0.22 || v > 0.45) next = S.page - 1;

  goTo(clamp(next, 0, PAGES.length - 1), true);
}

$('pager').addEventListener('pointerup', endSwipe);
$('pager').addEventListener('pointercancel', () => {
  document.body.classList.remove('is-swiping');
  if (swipe) { const p = S.page; swipe = null; setTrack(-p * pageWidth(), true); }
});

let suppressClick = false;
document.addEventListener('click', e => {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

/* ---------- 顶栏与底栏收放 ---------- */

const navBar = $('navBar');
let navHidden = false;

function hideNavBar() {
  if (navHidden) return;
  navHidden = true;
  navBar.classList.add('is-hidden');
  $('topBar').classList.add('is-hidden');
}

function showNavBar() {
  if (!navHidden) return;
  navHidden = false;
  navBar.classList.remove('is-hidden');
  $('topBar').classList.remove('is-hidden');
}

for (const page of document.querySelectorAll('.md-page')) {
  let last = 0;
  let ticking = false;
  page.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (S.layer) return;
      const y = page.scrollTop;
      const dy = y - last;
      last = y;
      if (y < 12) { showNavBar(); return; }
      const atBottom = y + page.clientHeight >= page.scrollHeight - 12;
      if (atBottom) { showNavBar(); return; }
      if (dy > 8) hideNavBar();
      else if (dy < -8) showNavBar();
    });
  }, { passive: true });
}

/* ---------- 二级页面 ---------- */

function layerEl(name) {
  return document.querySelector(`.md-layer[data-layer="${name}"]`);
}

function showLayer(name) {
  const el = layerEl(name);
  if (!el) return;
  S.layer = name;
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  hideNavBar();
  $('backBtn').hidden = false;
  history.pushState({ layer: name }, '', location.href);
}

function hideLayer(name) {
  const el = layerEl(name);
  if (!el) return;
  el.classList.remove('is-open');
  el.setAttribute('aria-hidden', 'true');
  if (S.layer === name) S.layer = null;
  $('backBtn').hidden = true;
  showNavBar();
}

function openLayer(name) {
  showLayer(name);
}

function closeLayer() {
  if (!S.layer) return;
  const name = S.layer;
  hideLayer(name);
  if (history.state && history.state.layer) {
    try { history.back(); } catch { }
  }
}

$('backBtn').addEventListener('click', () => closeLayer());

window.addEventListener('popstate', () => {
  if (S.layer) {
    const name = S.layer;
    hideLayer(name);
  }
});

/* ---------- 底部弹层 ---------- */

let sheetOpen = false;
let sheetTimer = null;

function openSheet(title, items) {
  document.body.classList.add('sheet-open');
  $('sheetTitle').textContent = title;
  const list = $('sheetList');
  list.textContent = '';

  for (const it of items) {
    const b = el('button', 'md-sheet-item' + (it.danger ? ' is-danger' : ''));
    b.type = 'button';
    if (it.icon) {
      const span = el('span', 'md-sheet-item__icon');
      span.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${it.icon}"/></svg>`;
      b.appendChild(span);
    }
    b.appendChild(el('span', 'md-grow', it.label));
    b.addEventListener('click', async () => {
      closeSheet();
      await it.onPick();
    });
    list.appendChild(b);
  }

  clearTimeout(sheetTimer);
  $('sheetScrim').hidden = false;
  requestAnimationFrame(() => {
    $('sheetScrim').classList.add('is-open');
    $('sheet').classList.add('is-open');
    $('sheet').setAttribute('aria-hidden', 'false');
  });
  sheetOpen = true;
}

function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false;
  document.body.classList.remove('sheet-open');
  $('sheet').classList.remove('is-open');
  $('sheetScrim').classList.remove('is-open');
  $('sheet').setAttribute('aria-hidden', 'true');
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => { $('sheetScrim').hidden = true; }, 220);
}

$('sheetScrim').addEventListener('click', closeSheet);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (sheetOpen) { closeSheet(); return; }
  if (S.layer) closeLayer();
});

/* ---------- 概览 ---------- */

function setChip(state, text) {
  const chip = $('badge');
  chip.className = `md-chip${state ? ' is-' + state : ''}`;
  chip.textContent = text;
}

function renderKV() {
  const kv = $('kv');
  kv.textContent = '';
  const rows = S.pkg ? [
    ['包名', S.pkg.manifest?.package || '—'],
    ['名称', S.pkg.manifest?.name || '—'],
    ['版本', S.pkg.manifest?.versionName || '—'],
    ['版本号', String(S.pkg.manifest?.versionCode ?? '—')],
    ['页面', String(S.pkg.manifest?.pages?.length ?? '—')],
    ['文件', `${S.pkg.entries.length}`],
    ['图片', `${S.pkg.images.length}`],
    ['体积', fmtSize(S.pkg.bytes.length)],
  ] : [
    ['包名', '—'], ['名称', '—'], ['版本', '—'], ['版本号', '—'],
    ['页面', '—'], ['文件', '—'], ['图片', '—'], ['体积', '—'],
  ];
  for (const [k, v] of rows) kv.append(el('dt', null, k), el('dd', null, v));
}

function renderVerify() {
  const box = $('verify');
  box.textContent = '';
  if (!S.pkg) {
    box.appendChild(el('p', 'md-body-small md-muted', '载入包后显示校验结果'));
    return;
  }
  const v = S.pkg.verify;
  const row = (label, ok, text) => {
    const r = el('div', 'md-row md-row--between');
    r.append(el('span', 'md-body-small md-muted', label), el('span', `md-chip${ok ? ' is-ok' : ' is-bad'}`, text));
    box.appendChild(r);
  };
  if (!v) {
    row('签名块', false, '不存在');
    return;
  }
  row('RSA 验签', v.rsaOk, v.rsaOk ? '通过' : '失败');
  row('三段摘要', v.digestOk, v.digestOk ? '匹配' : '不匹配');
  row('文件摘要', v.badFiles === 0, v.badFiles === 0 ? `${v.fileCount} 项一致` : `${v.badFiles} 项异常`);
  if (S.pkg.sig?.certDer) {
    const info = el('p', 'md-body-small md-muted');
    info.textContent = `证书：${S.pkg.verify.cert?.cn || '未知'} · ${S.pkg.sig.signature.length * 8} 位签名`;
    box.appendChild(info);
  }
}

function renderNotice() {
  const box = $('notice');
  const pkg = S.pkg;
  if (!pkg) { box.hidden = true; return; }
  const emb = pkg.embedded;
  if (!emb || !emb.text) { box.hidden = true; return; }
  const cur = String(pkg.manifest?.versionCode ?? '');
  const old = (emb.text.match(/"versionCode":(\d+)/) || [])[1];
  if (old && cur && old !== cur) {
    box.hidden = false;
    box.textContent = `注意：${emb.source} 内嵌的版本号仍为 ${old}，外层已改为 ${cur}。字节码不会随 JSON 一起变。`;
  } else {
    box.hidden = true;
  }
}

/* ---------- 编辑页 ---------- */

const entryByName = n => S.pkg?.entries.find(e => e.name === n) || null;
const imageBytes = n => S.images[n] || (entryByName(n) ? dataOf(entryByName(n)) : null);
const iconName = () => (S.pkg?.manifest?.icon || '/common/icon.png').replace(/^\//, '');

function imgMeta(name) {
  const fromSize = S.sizes.get(name);
  if (fromSize) return fromSize;
  const meta = S.pkg?.images.find(i => i.name === name);
  if (!meta) return null;
  if (!meta.w) {
    try {
      const d = imageBytes(name);
      const wh = d ? pngSize(d) : null;
      if (wh) actualSize(name, wh);
      return { w: wh?.w || 0, h: wh?.h || 0 };
    } catch { return { w: 0, h: 0 }; }
  }
  return { w: meta.w, h: meta.h };
}

function actualSize(name, wh) {
  S.sizes.set(name, { w: wh.w, h: wh.h });
}

function renderForm() {
  const m = S.pkg?.manifest;
  const on = Boolean(m);
  for (const [id, val] of [['fName', m?.name], ['fPackage', m?.package], ['fVersionName', m?.versionName], ['fVersionCode', m?.versionCode]]) {
    const node = $(id);
    node.disabled = !on;
    node.value = val ?? '';
  }
  $('pickIcon').disabled = !on;
  $('search').disabled = !on;
  updateFab();
  renderIcon();
  if (!on) $('detailState').textContent = '载入包后可编辑';
  else renderDirty();
}

function renderIcon() {
  const box = $('iconPreview');
  box.textContent = '';
  const name = iconName();
  const bytes = S.pkg ? imageBytes(name) : null;
  if (!bytes) {
    box.appendChild(el('span', 'md-body-small md-muted', '无'));
    $('iconHint').textContent = '—';
    return;
  }
  const meta = imgMeta(name);
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  img.onload = () => URL.revokeObjectURL(img.src);
  box.appendChild(img);
  $('iconHint').textContent = meta?.w ? `${meta.w} × ${meta.h} PNG` : 'PNG';
}

function renderDirty() {
  if (!S.pkg) { $('detailState').textContent = '载入包后可编辑'; return; }
  const dirty = Object.keys(S.images).length;
  const m = collectPatch().manifest;
  const changed = m.name !== S.pkg.manifest.name || m.package !== S.pkg.manifest.package
    || m.versionName !== S.pkg.manifest.versionName || Number(m.versionCode) !== Number(S.pkg.manifest.versionCode);
  $('detailState').textContent = (changed || dirty)
    ? `已修改${dirty ? ` · ${dirty} 张图` : ''}，导出时生效`
    : '与包内一致';
  updateFab();
}

function collectPatch() {
  const base = S.pkg?.manifest || {};
  const m = { ...base };
  m.name = $('fName').value.trim();
  m.package = $('fPackage').value.trim();
  m.versionName = $('fVersionName').value.trim();
  m.versionCode = Number($('fVersionCode').value);

  const watch = S.pkg?.watch
    ? { ...S.pkg.watch, name: m.name, package: m.package, versionName: m.versionName, versionCode: m.versionCode }
    : null;
  const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

  return {
    manifestText: S.pkg && changed(S.pkg.manifest, m) ? JSON.stringify(m, null, 2) + '\n' : null,
    watchText: (S.settings.optWatch && watch && changed(S.pkg.watch, watch)) ? JSON.stringify(watch, null, 2) + '\n' : null,
    images: S.images,
    manifest: m,
  };
}

function validate(m) {
  if (!m.name) return '应用名称不能为空';
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(m.package)) return '包名格式不对，应类似 com.example.app';
  if (!m.versionName) return '版本名不能为空';
  if (!Number.isInteger(m.versionCode) || m.versionCode <= 0) return '版本号需为正整数';
  return null;
}

/* ---------- 文件列表 ---------- */

let fileToken = 0;

async function renderFiles() {
  const token = ++fileToken;
  const list = $('fileList');
  const q = ($('search').value || '').trim().toLowerCase();
  list.textContent = '';
  const status = $('listStatus');
  status.hidden = true;

  if (!S.pkg) {
    list.classList.add('is-empty');
    list.appendChild(el('p', 'md-body-small md-muted', '载入包后显示文件'));
    $('entryCount').textContent = '';
    return;
  }
  list.classList.remove('is-empty');

  const all = S.pkg.entries.filter(e => !q || e.name.toLowerCase().includes(q));
  $('entryCount').textContent = `${all.length}`;
  const BATCH = 60;

  for (let i = 0; i < all.length; i += BATCH) {
    if (token !== fileToken) return;
    const frag = document.createDocumentFragment();
    for (const e of all.slice(i, i + BATCH)) {
      const li = el('li');
      const btn = el('button', 'md-list-item');
      btn.type = 'button';
      btn.append(
        el('span', 'md-list-item__name', e.name),
        el('span', 'md-list-item__meta', e.isDir ? '目录' : fmtSize(e.usize)),
      );
      btn.addEventListener('click', () => openFileSheet(e));
      li.appendChild(btn);
      frag.appendChild(li);
    }
    list.appendChild(frag);
    if (all.length > BATCH) {
      status.hidden = false;
      status.textContent = `已显示 ${Math.min(i + BATCH, all.length)} / ${all.length}`;
      await yieldToUI();
    }
  }
}

function openFileSheet(entry) {
  if (entry.isDir) { snack('这是目录'); return; }
  openSheet(entry.name.split('/').pop(), [
    {
      label: '取出这个文件',
      icon: 'M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4L11 12.2V3zM5 19h14v2H5z',
      onPick: () => saveBlob(entry.name.split('/').pop(), dataOf(entry)),
    },
    {
      label: '替换内容',
      icon: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25z',
      onPick: () => pickForImage(entry.name),
    },
  ]);
}

/* ---------- 图片网格 ---------- */

let imgToken = 0;
const hydration = [];
let pumping = false;

const io = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      hydration.push(e.target);
    }
    pumpHydration();
  }, { rootMargin: '220px' })
  : null;

async function pumpHydration() {
  if (pumping) return;
  pumping = true;
  let n = 0;
  while (hydration.length) {
    const tile = hydration.shift();
    if (tile && tile.isConnected && tile.classList.contains('is-skeleton')) hydrateTile(tile);
    if (++n % 4 === 0) await yieldToUI();
  }
  pumping = false;
}

function duplicateBases(list) {
  const count = new Map();
  for (const i of list) {
    const b = i.name.split('/').pop();
    count.set(b, (count.get(b) || 0) + 1);
  }
  const dup = new Set();
  for (const [b, n] of count) if (n > 1) dup.add(b);
  return dup;
}

function subLabel(name) {
  const parts = name.split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

function skeletonTile(img, index) {
  const tile = el('div', 'md-tile is-skeleton');
  tile.dataset.name = img.name;
  tile.title = img.name;
  const frame = el('div', 'md-tile__img');
  frame.appendChild(el('span', 'md-tile__ph'));
  const base = img.name.split('/').pop();
  const dir = S.dupes?.has(base) ? subLabel(img.name) : '';
  tile.append(frame,
    el('div', 'md-tile__name', base),
    el('div', 'md-tile__meta', dir ? `${dir} · ${fmtSize(img.bytes)}` : fmtSize(img.bytes)));
  tile.style.animationDelay = `${Math.min(index, 12) * 8}ms`;
  return tile;
}

function hydrateTile(tile) {
  const name = tile.dataset.name;
  const meta = imgMeta(name);
  tile.classList.remove('is-skeleton');
  const frame = tile.querySelector('.md-tile__img');
  frame.textContent = '';
  const bytes = imageBytes(name);
  if (bytes) {
    const im = new Image();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    S.urls.set(name, url);
    im.src = url;
    im.alt = name;
    frame.appendChild(im);
  }
  const base = name.split('/').pop();
  const dir = S.dupes?.has(base) ? subLabel(name) : '';
  const dim = meta?.w ? `${meta.w}×${meta.h}` : '';
  tile.querySelector('.md-tile__meta').textContent = dir ? `${dir} · ${dim}` : dim;
  if (S.images[name]) tile.classList.add('is-changed');
  tile.addEventListener('click', () => openImageSheet(name));
}

async function renderImages() {
  const token = ++imgToken;
  const grid = $('imageGrid');
  const status = $('gridStatus');
  const q = ($('search').value || '').trim().toLowerCase();
  grid.textContent = '';
  status.hidden = true;

  if (!S.pkg) {
    grid.classList.add('is-empty');
    grid.appendChild(el('p', 'md-body-small md-muted', '载入包后显示图片'));
    $('imgCount').textContent = '';
    return;
  }
  grid.classList.remove('is-empty');

  const all = S.pkg.images;
  const list = q ? all.filter(i => i.name.toLowerCase().includes(q)) : all;
  S.dupes = duplicateBases(all);
  $('imgCount').textContent = String(all.length);

  if (!list.length) {
    grid.appendChild(el('p', 'md-body-small md-muted', '没有匹配的图片'));
    return;
  }

  const BATCH = 20;
  for (let i = 0; i < list.length; i += BATCH) {
    if (token !== imgToken) return;
    const frag = document.createDocumentFragment();
    const fresh = [];
    for (const img of list.slice(i, i + BATCH)) {
      const tile = skeletonTile(img, i);
      frag.appendChild(tile);
      fresh.push(tile);
    }
    grid.appendChild(frag);
    for (const t of fresh) {
      if (io) io.observe(t); else hydration.push(t);
    }
    if (!io) pumpHydration();
    if (list.length > BATCH) {
      status.hidden = false;
      status.textContent = `已加载 ${Math.min(i + BATCH, list.length)} / ${list.length}`;
      await raf();
      await yieldToUI();
    }
  }
}

function updateTile(name) {
  const tile = document.querySelector(`.md-tile[data-name="${CSS.escape(name)}"]`);
  if (!tile) return;
  tile.classList.add('is-changed');
  const frame = tile.querySelector('.md-tile__img');
  if (!frame) return;
  frame.textContent = '';
  const bytes = imageBytes(name);
  if (bytes) {
    const im = new Image();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    S.urls.set(name, url);
    im.src = url;
    frame.appendChild(im);
  }
  const meta = imgMeta(name);
  const base = name.split('/').pop();
  const dir = S.dupes?.has(base) ? subLabel(name) : '';
  const dim = meta?.w ? `${meta.w}×${meta.h}` : '';
  tile.querySelector('.md-tile__meta').textContent = dir ? `${dir} · ${dim}` : dim;
}

function openImageSheet(name) {
  const items = [
    {
      label: '调整这张图',
      icon: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25z',
      onPick: () => openEditor(name),
    },
    {
      label: '换一张图',
      icon: 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z',
      onPick: () => pickForImage(name),
    },
  ];
  if (S.images[name]) {
    items.push({
      label: '还原成原图',
      danger: true,
      icon: 'M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z',
      onPick: () => { delete S.images[name]; updateTile(name); renderDirty(); snack('已还原'); },
    });
  }
  openSheet(name.split('/').pop(), items);
}

function setTab(tab) {
  S.tab = tab;
  const images = tab === 'images';
  $('tabImages').setAttribute('aria-selected', String(images));
  $('tabFiles').setAttribute('aria-selected', String(!images));
  $('imageGrid').hidden = !images;
  $('fileList').hidden = images;
  $('exportImages').classList.toggle('hidden', !images);
  $('search').placeholder = images ? '筛选图片名称' : '筛选文件路径';
  S.stale = false;
  if (images) renderImages(); else renderFiles();
}

/* ---------- 图片编辑器 ---------- */

const Ed = {};

const HINTS = {
  fit: '整张图缩放到目标尺寸内，四周补透明。',
  cover: '按比例铺满目标尺寸，超出部分裁掉，可拖动。',
  stretch: '直接拉伸到目标尺寸，比例会变。',
  raw: '保持原图像素尺寸，不做任何缩放。',
};

function openEditor(name) {
  const meta = imgMeta(name);
  if (!meta) { snack('读不到尺寸'); return; }
  const bytes = imageBytes(name);
  if (!bytes) { snack('这张图读不出来'); return; }

  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  Ed.name = name;
  Ed.W = meta.w || 0;
  Ed.H = meta.h || 0;
  Ed.file = null;
  Ed.circle = false;
  Ed.lock = true;
  Ed.zoom = 1;
  Ed.dx = 0;
  Ed.dy = 0;

  $('edSub').textContent = name;
  $('edCircle').checked = false;
  $('edLock').setAttribute('aria-pressed', 'true');

  const img = new Image();
  img.onload = () => {
    Ed.img = img;
    Ed.iw = img.naturalWidth;
    Ed.ih = img.naturalHeight;
    if (!Ed.W || !Ed.H) { Ed.W = Ed.iw; Ed.H = Ed.ih; }
    openLayer('editor');
    requestAnimationFrame(() => { setMode('fit'); scaleCanvas(); });
  };
  img.onerror = () => snack('图片解码失败');
  img.src = url;
  setTimeout(() => URL.revokeObjectURL(url), 12000);
}

function pickForImage(name) {
  S.pending = { name };
  $('imageInput').click();
}

function setMode(mode) {
  Ed.mode = mode;
  for (const b of $('edModes').children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  $('edHint').textContent = HINTS[mode];

  const raw = mode === 'raw';
  $('edZoomRow').style.display = (mode === 'stretch' || raw) ? 'none' : '';
  $('edW').disabled = raw;
  $('edH').disabled = raw;
  $('edLock').disabled = raw;

  if (raw) {
    $('edW').value = Ed.iw;
    $('edH').value = Ed.ih;
  } else {
    $('edW').value = Ed.W;
    $('edH').value = Ed.H;
  }

  $('edZoom').min = mode === 'fit' ? 10 : 100;
  $('edZoom').max = mode === 'fit' ? 100 : 400;
  Ed.zoom = mode === 'fit' ? 1 : Math.max(1, Ed.zoom);
  $('edZoom').value = Math.round(Ed.zoom * 100);
  $('edZoomVal').textContent = `${Math.round(Ed.zoom * 100)}%`;
  Ed.dx = 0;
  Ed.dy = 0;
  draw();
}

function readSize() {
  return {
    w: clamp(Math.round(Number($('edW').value) || 1), 1, 8192),
    h: clamp(Math.round(Number($('edH').value) || 1), 1, 8192),
  };
}

function applySize() {
  if (Ed.mode === 'raw') return;
  const { w, h } = readSize();
  Ed.W = w;
  Ed.H = h;
  draw();
}

function onWidthInput() {
  const w = clamp(Math.round(Number($('edW').value) || 1), 1, 8192);
  if (Ed.lock && Ed.iw && Ed.ih) $('edH').value = Math.max(1, Math.round(w * (Ed.ih / Ed.iw)));
  applySize();
}

function onHeightInput() {
  const h = clamp(Math.round(Number($('edH').value) || 1), 1, 8192);
  if (Ed.lock && Ed.iw && Ed.ih) $('edW').value = Math.max(1, Math.round(h * (Ed.iw / Ed.ih)));
  applySize();
}

function draw() {
  const cv = $('edCanvas');
  if (!Ed.img) return;

  const raw = Ed.mode === 'raw';
  const W = raw ? Ed.iw : Ed.W;
  const H = raw ? Ed.ih : Ed.H;
  if (!W || !H) return;

  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (Ed.circle) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.min(W, H) / 2, 0, Math.PI * 2);
    ctx.clip();
  }

  if (raw) {
    ctx.drawImage(Ed.img, 0, 0);
  } else if (Ed.mode === 'stretch') {
    ctx.drawImage(Ed.img, 0, 0, W, H);
  } else {
    const base = Ed.mode === 'fit' ? Math.min(W / Ed.iw, H / Ed.ih) : Math.max(W / Ed.iw, H / Ed.ih);
    const s = base * Ed.zoom;
    const dw = Ed.iw * s;
    const dh = Ed.ih * s;
    let x = (W - dw) / 2 + Ed.dx;
    let y = (H - dh) / 2 + Ed.dy;
    if (Ed.mode === 'cover') {
      x = clamp(x, W - dw, 0);
      y = clamp(y, H - dh, 0);
      Ed.dx = x - (W - dw) / 2;
      Ed.dy = y - (H - dh) / 2;
    }
    ctx.drawImage(Ed.img, x, y, dw, dh);
  }

  if (Ed.circle) ctx.restore();

  scaleCanvas();
  updateInfo(W, H);
}

function scaleCanvas() {
  const cv = $('edCanvas');
  const stage = $('edStage');
  if (!cv.width || !stage.clientWidth) return;
  const aw = stage.clientWidth - 32;
  const ah = stage.clientHeight - 32;
  if (aw <= 0 || ah <= 0) return;
  const k = Math.min(aw / cv.width, ah / cv.height, 4);
  cv.style.width = `${Math.max(40, Math.round(cv.width * k))}px`;
  cv.style.height = `${Math.max(40, Math.round(cv.height * k))}px`;
}

function updateInfo(outW, outH) {
  const kv = $('edInfo');
  kv.textContent = '';
  for (const [k, v] of [
    ['目标', `${Ed.W} × ${Ed.H}`],
    ['原图', `${Ed.iw} × ${Ed.ih}`],
    ['输出', `${outW} × ${outH}`],
    ['格式', Ed.circle ? 'PNG · 圆形透明' : 'PNG'],
  ]) kv.append(el('dt', null, k), el('dd', null, v));
}

async function applyEditor() {
  if (!Ed.img) return;
  const btn = $('edApply');
  btn.disabled = true;
  btn.classList.add('is-loading');
  await raf();

  try {
    const cv = $('edCanvas');
    let bytes;
    if (Ed.mode === 'raw' && !Ed.circle && Ed.file && Ed.file.type === 'image/png') {
      bytes = new Uint8Array(await Ed.file.arrayBuffer());
    } else {
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      if (!blob) throw new Error('导出失败');
      bytes = new Uint8Array(await blob.arrayBuffer());
    }

    const before = imageBytes(Ed.name)?.length || 0;
    S.images[Ed.name] = bytes;

    const meta = S.pkg.images.find(i => i.name === Ed.name);
    if (meta) { meta.w = cv.width; meta.h = cv.height; }
    S.sizes.set(Ed.name, { w: cv.width, h: cv.height });

    closeLayer();
    if (Ed.name === iconName()) renderIcon();
    updateTile(Ed.name);
    renderDirty();
    snack(`已应用 · ${fmtSize(before)} → ${fmtSize(bytes.length)}`);
  } catch (e) {
    snack(`处理失败：${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

async function loadIntoEditor(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    Ed.img = img;
    Ed.iw = img.naturalWidth;
    Ed.ih = img.naturalHeight;
    Ed.file = file;
    if (!Ed.W || !Ed.H) { Ed.W = Ed.iw; Ed.H = Ed.ih; }
    Ed.zoom = 1;
    Ed.dx = 0;
    Ed.dy = 0;

    $('edSub').textContent = `${Ed.name} · 新图 ${Ed.iw}×${Ed.ih}`;
    if (S.layer !== 'editor') openLayer('editor');
    requestAnimationFrame(() => {
      const sameRatio = Math.abs(Ed.ih / Ed.iw - Ed.H / Ed.W) < 0.02;
      setMode(sameRatio ? 'fit' : 'cover');
    });
    setTimeout(() => URL.revokeObjectURL(url), 12000);
  };
  img.onerror = () => { snack('无法解码这张图片'); URL.revokeObjectURL(url); };
  img.src = url;
}

/* ---------- 签名身份 ---------- */

function fingerprint() {
  const id = S.identity;
  if (!id) return '';
  return hexUpper(id.fingerprint?.slice(0, 8) || new Uint8Array(8));
}

function renderIdentity() {
  const id = S.identity;
  $('idChip').textContent = id ? '已就绪' : '未设置';
  $('idChip').className = `md-chip${id ? ' is-ok' : ''}`;
  $('idName').textContent = id ? id.cn || '未命名' : '未设置身份';
  const fp = id ? fingerprint() : '';
  $('idSub').textContent = id
    ? `${fp ? fp.match(/../g).join(' ') + ' · ' : ''}${new Date(id.notBefore).toLocaleDateString()} 起`
    : '导出前需要一把私钥';

  for (const b of ['copyFingerprint', 'exportId', 'exportCert', 'exportPub', 'exportZip']) {
    const node = $(b);
    if (node) node.disabled = !id;
  }
  updateFab();
}

async function persistIdentity() {
  try {
    if (!S.settings.autoIdentity) { await dbDel('kv', 'identity'); return; }
    const id = S.identity;
    if (!id) return;
    await dbPut('kv', {
      k: 'identity',
      pkcs8: id.pkcs8,
      certDer: id.certDer,
      pubDer: id.pubDer,
      cn: id.cn,
      notBefore: id.notBefore,
      notAfter: id.notAfter,
      fingerprint: id.fingerprint,
    });
  } catch { }
}

async function restoreIdentity() {
  if (!S.settings.autoIdentity) return;
  try {
    const rec = await dbGet('kv', 'identity');
    if (!rec) return;
    const key = await importPrivateKey(rec.pkcs8, 'pkcs8');
    S.identity = {
      key,
      certDer: new Uint8Array(rec.certDer),
      pubDer: new Uint8Array(rec.pubDer),
      cn: rec.cn,
      notBefore: rec.notBefore,
      notAfter: rec.notAfter,
      fingerprint: rec.fingerprint ? new Uint8Array(rec.fingerprint) : null,
      pkcs8: rec.pkcs8,
    };
    renderIdentity();
  } catch { }
}

function randomCn() {
  const s = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RPK-${s}`;
}

async function generateIdentity() {
  const mode = S.idMode;
  const cn = ($('cnInput').value || '').trim() || (mode === 'auto' ? randomCn() : 'RPK Studio');
  const days = clamp(Number($('daysInput').value) || 3650, 1, 36500);
  const opts = {
    cn,
    days,
    o: mode === 'manual' ? ($('orgInput').value || '').trim() : '',
    ou: mode === 'manual' ? ($('ouInput').value || '').trim() : '',
    c: mode === 'manual' ? ($('countryInput').value || '').trim().toUpperCase() : '',
  };

  const btn = $('genId');
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const id = await createIdentity(opts);
    const fp = new Uint8Array(await crypto.subtle.digest('SHA-256', id.certDer));
    S.identity = { ...id, fingerprint: fp };
    $('cnInput').value = cn;
    await persistIdentity();
    renderIdentity();
    snack('身份已生成');
  } catch (e) {
    snack(`生成失败：${e.message || e}`);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

/* ---------- 导入 / 导出身份 ---------- */

const PEM_KINDS = [
  ['BEGIN RSA PRIVATE KEY', 'pkcs1'],
  ['BEGIN PRIVATE KEY', 'pkcs8'],
  ['BEGIN CERTIFICATE', 'cert'],
  ['BEGIN PUBLIC KEY', 'pub'],
];

function sniffPem(text) {
  for (const [tag, kind] of PEM_KINDS) if (text.includes(tag)) return kind;
  return null;
}

/** 把 DER 里的 RSA 公钥与私钥做一次签名自检，确认配对。 */
async function keysMatch(key, certDer) {
  try {
    const cert = parseCertificate(certDer);
    const spki = cert.spki;
    const pub = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const probe = te.encode('rpk-studio');
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, probe);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, sig, probe);
  } catch {
    return false;
  }
}

async function importIdentityFiles(files) {
  let key = null;
  let certDer = null;
  let cn = '';
  let pubDer = null;

  for (const file of files) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const name = file.name.toLowerCase();

    if (name.endsWith('.p12') || name.endsWith('.pfx')) {
      snack('暂不支持 .p12，请用 openssl 转成 pem 再导入');
      continue;
    }

    const text = (name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.crt') || name.endsWith('.cer') || name.endsWith('.pub') || name.endsWith('.txt'))
      ? new TextDecoder().decode(buf) : '';
    const kind = text ? sniffPem(text) : null;

    try {
      if (kind === 'pkcs1') {
        key = await importPrivateKey(text, 'pkcs1');
      } else if (kind === 'pkcs8') {
        key = await importPrivateKey(text, 'pkcs8');
      } else if (kind === 'cert') {
        certDer = base64ToBytes(text);
      } else if (kind === 'pub') {
        pubDer = base64ToBytes(text);
      } else if (!kind) {
        // 无 PEM 头，按 DER 猜：证书 → PKCS#8
        try {
          const cert = parseCertificate(buf);
          if (cert && cert.spki) { certDer = buf; cn = cert.cn || ''; }
          else key = await importPrivateKey(buf, 'pkcs8');
        } catch {
          key = await importPrivateKey(buf, 'pkcs8');
        }
      }
    } catch (e) {
      snack(`无法识别 ${file.name}`);
    }
  }

  if (!key) { snack('没有找到私钥'); return; }

  if (!certDer) {
    const id = await createIdentity({ cn: cn || ($('cnInput').value || '').trim() || randomCn(), key });
    S.identity = id;
  } else {
    const ok = await keysMatch(key.key, certDer);
    if (!ok) { snack('私钥与证书不匹配'); return; }
    const cert = parseCertificate(certDer);
    S.identity = {
      key: key.key,
      certDer,
      pubDer: cert.spki,
      cn: cert.cn,
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
    };
  }

  const fp = new Uint8Array(await crypto.subtle.digest('SHA-256', S.identity.certDer));
  S.identity.fingerprint = fp;
  if (S.identity.key && S.identity.key.extractable) {
    try { S.identity.pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', S.identity.key)); } catch { }
  }
  await persistIdentity();
  renderIdentity();
  snack('身份已导入');
}

function base64ToBytes(pem) {
  const b64 = pem.split('\n').filter(l => l && !l.startsWith('-----')).join('').trim();
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function derToPem(der, label) {
  const b64 = btoa(String.fromCharCode.apply(null, der));
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

async function exportIdentityPart(part) {
  const id = S.identity;
  if (!id) return;
  if (part === 'key') {
    const der = id.pkcs8 || new Uint8Array(await crypto.subtle.exportKey('pkcs8', id.key));
    await saveBlob('private.pem', te.encode(derToPem(der, 'PRIVATE KEY')));
  } else if (part === 'cert') {
    await saveBlob('certificate.pem', te.encode(derToPem(id.certDer, 'CERTIFICATE')));
  } else if (part === 'pub') {
    await saveBlob('public.pem', te.encode(derToPem(id.pubDer, 'PUBLIC KEY')));
  } else {
    const files = [
      { name: 'private.pem', data: te.encode(derToPem(id.pkcs8 || new Uint8Array(await crypto.subtle.exportKey('pkcs8', id.key)), 'PRIVATE KEY')) },
      { name: 'certificate.pem', data: te.encode(derToPem(id.certDer, 'CERTIFICATE')) },
      { name: 'public.pem', data: te.encode(derToPem(id.pubDer, 'PUBLIC KEY')) },
      { name: 'readme.txt', data: te.encode(`CN: ${id.cn}\n有效: ${new Date(id.notBefore).toISOString()} → ${new Date(id.notAfter).toISOString()}\n\nopenssl pkcs12 -export -inkey private.pem -in certificate.pem -out key.p12\n`) },
    ];
    const zip = makeZip(files);
    await saveBlob('identity.zip', zip);
  }
}

/** 极简 STORE-only ZIP，用于身份包。 */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const f of files) {
    const name = te.encode(f.name);
    const crc = crc32(f.data);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    chunks.push(lh, f.data);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + f.data.length;
  }

  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

/* ---------- 载入与导出 ---------- */

async function loadFile(file, opts = {}) {
  if (S.busy) return;
  S.busy = true;
  showScrim('正在读取文件', file.name);

  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const t0 = performance.now();

    $('scrimText').textContent = '正在解析包结构';
    const pkg = await inspect(buf, p => {
      if (p.stage === 'verify') setScrimProgress(p.done, p.total, '校验文件摘要');
    });

    S.pkg = pkg;
    S.fileName = file.name;
    S.images = {};
    S.sizes = new Map();
    for (const u of S.urls.values()) URL.revokeObjectURL(u);
    S.urls.clear();
    S.stale = true;

    $('drop').classList.add('hidden');
    $('overviewBody').classList.remove('hidden');
    $('fileName').textContent = file.name;
    $('fileMeta').textContent = `${fmtSize(file.size)} · ${pkg.entries.length} 项 · ${pkg.manifest?.package || '未知包名'}`;

    hideScrim();
    renderForm();
    renderKV();
    renderVerify();
    renderNotice();
    renderDirty();
    setChip(pkg.verify && pkg.verify.rsaOk && pkg.verify.digestOk && pkg.verify.badFiles === 0 ? 'ok' : 'warn',
      pkg.verify ? '签名已校验' : '未签名');

    const v = pkg.verify;
    const ok = v && v.digestOk && v.rsaOk && v.badFiles === 0;
    if (!opts.fromHistory) {
      await addHistory({
        kind: 'load',
        file: file.name,
        pkg: pkg.manifest?.package || '',
        name: pkg.manifest?.name || '',
        version: pkg.manifest?.versionName || '',
        size: file.size,
        verified: Boolean(ok),
      }, S.settings.storeFiles ? buf : null);
    }
    snack(`解析完成 ${Math.round(performance.now() - t0)} ms · ${v ? (ok ? '签名有效' : '签名异常') : '未签名'}`);
  } catch (e) {
    setChip('bad', '无法解析');
    snack(String(e.message || e));
  } finally {
    hideScrim();
    S.busy = false;
    renderDirty();
  }
}

function updateFab() {
  const ready = Boolean(S.pkg && S.identity && !S.busy);
  const btn = $('exportBtn');
  if (btn) btn.disabled = !ready;
  const state = $('toolState');
  if (state) state.textContent = S.pkg ? '可用' : '载入包后可用';
}

async function doExport() {
  if (!S.pkg || S.busy) return;
  if (!S.identity) {
    expandSignature(true);
    snack('先设置签名身份');
    return;
  }
  const patch = collectPatch();
  const err = validate(patch.manifest);
  if (err) { snack(err); return; }

  S.busy = true;
  const btn = $('exportBtn');
  btn.classList.add('is-loading');
  btn.disabled = true;
  const before = S.pkg.bytes.length;
  showScrim('正在重新打包', '计算文件摘要');

  try {
    const out = await repack(S.pkg, patch, S.identity, p => {
      if (p.stage === 'digest') setScrimProgress(p.done, p.total, '计算文件摘要');
    });
    const outName = `${patch.manifest.package}.release.${patch.manifest.versionName}.rpk`;
    await saveBlob(outName, out);

    S.lastExport = { name: outName, bytes: out };
    $('recentCard').classList.remove('hidden');
    $('recentName').textContent = outName;

    const delta = out.length - before;
    const sign = `${delta >= 0 ? '+' : '-'}${fmtSize(Math.abs(delta))}`;
    hideScrim();

    let ok = null;
    if (S.settings.optVerify) {
      showScrim('正在自检导出的包', '重新解析刚生成的文件');
      const check = await inspect(out);
      ok = Boolean(check.verify.digestOk && check.verify.rsaOk && check.verify.badFiles === 0);
      hideScrim();
      snack(`已导出 ${fmtSize(out.length)}（${sign}）· ${ok ? '签名自检通过' : '签名自检失败'}`);
    } else {
      snack(`已导出 ${fmtSize(out.length)}（${sign}）`);
    }

    await addHistory({
      kind: 'export',
      file: outName,
      pkg: patch.manifest.package,
      name: patch.manifest.name,
      version: patch.manifest.versionName,
      size: out.length,
      verified: ok,
    }, S.settings.storeFiles ? out : null);
  } catch (e) {
    snack(`导出失败：${e.message || e}`);
  } finally {
    hideScrim();
    S.busy = false;
    btn.classList.remove('is-loading');
    renderDirty();
  }
}

/* ---------- 工具箱：应用伪装 ---------- */

async function loadCatalog() {
  if (S.tbCatalog) return S.tbCatalog;
  const res = await fetch('assets/icons/catalog.json', { cache: 'force-cache' });
  S.tbCatalog = await res.json();
  return S.tbCatalog;
}

async function renderToolbox() {
  const cat = await loadCatalog();
  const set = cat[S.tbOs];
  const grid = $('tbGrid');
  grid.textContent = '';
  for (const item of set) {
    const tile = el('div', 'md-tile');
    tile.dataset.name = item.id;
    const frame = el('div', 'md-tile__img');
    const im = new Image();
    im.src = `assets/icons/${S.tbOs}/${item.id}.png`;
    im.alt = item.name;
    im.loading = 'lazy';
    frame.appendChild(im);
    tile.append(frame,
      el('div', 'md-tile__name', item.name),
      el('div', 'md-tile__meta', item.id));
    tile.addEventListener('click', () => applyDisguise(item, S.tbOs));
    grid.appendChild(tile);
  }
}

async function applyDisguise(item, os) {
  if (!S.pkg) { snack('先载入一个包'); return; }
  try {
    const bytes = new Uint8Array(await (await fetch(`assets/icons/${os}/${item.id}.png`)).arrayBuffer());
    const name = iconName();
    const meta = imgMeta(name) || { w: 100, h: 100 };
    const out = await resizePng(bytes, meta.w || 100, meta.h || 100);

    S.images[name] = out;
    S.sizes.set(name, { w: meta.w || 100, h: meta.h || 100 });
    $('fName').value = item.name;

    closeLayer();
    goTo(1, true);
    renderIcon();
    updateTile(name);
    renderDirty();
    snack(`已套用「${item.name}」`);
  } catch (e) {
    snack(`套用失败：${e.message || e}`);
  }
}

function resizePng(bytes, w, h) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const img = new Image();
    img.onload = async () => {
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext('2d');
      const s = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      const dw = img.naturalWidth * s;
      const dh = img.naturalHeight * s;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      URL.revokeObjectURL(url);
      if (!blob) { reject(new Error('转换失败')); return; }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('解码失败')); };
    img.src = url;
  });
}

/* ---------- 设置 ---------- */

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = choice;
  try { localStorage.setItem('rpk-theme', choice); } catch { }
  for (const b of $('themeSeg').children) {
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  }
}

function renderSettingsPage() {
  $('updAuto').checked = S.settings.updAuto;
  $('updMirror').value = S.settings.updMirror;
  $('stRecord').checked = S.settings.record;
  $('stFiles').checked = S.settings.storeFiles;
  $('stIdentity').checked = S.settings.autoIdentity;
  $('optVerify').checked = S.settings.optVerify;
  $('optWatch').checked = S.settings.optWatch;
  updateStorageHint();
}

/* ---------- 更新检查 ---------- */

const UPDATE_URL = 'https://raw.githubusercontent.com/hrk666666/rpk-studio/main/version.json';

async function checkUpdate(manual = false) {
  const mirror = (S.settings.updMirror || '').trim();
  const url = mirror ? mirror.replace(/\/+$/, '') + '/' + UPDATE_URL : UPDATE_URL;
  if (manual) $('updState').textContent = '正在检查…';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    if (Number(info.versionCode) > VERSION.code) {
      $('updState').textContent = `发现 ${info.versionName}`;
      openSheet(`新版本 ${info.versionName}`, [
        {
          label: '前往下载',
          icon: 'M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4L11 12.2V3zM5 19h14v2H5z',
          onPick: () => window.open(info.url || 'https://github.com/hrk666666/rpk-studio/releases', '_blank', 'noopener'),
        },
        { label: '稍后', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v5.6l4 2.4-.9 1.5L11 13V7h2z', onPick: () => { } },
      ]);
      if (!manual) return;
    } else {
      $('updState').textContent = '已是最新';
      if (manual) snack('已是最新版本');
    }
  } catch (e) {
    if (manual) $('updState').textContent = `检查失败：${e.message || e}`;
  }
}

/* ---------- 条款 ---------- */

const CONSENT_KEY = 'rpk-consent-v2';
let gateMode = 'first';
let gateBound = false;
let gateRefresh = () => { };

function readConsent() {
  try { return JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null'); } catch { return null; }
}

function bindGate() {
  if (gateBound) return;
  gateBound = true;

  const scroll = $('gateScroll');
  const box = $('gateConsent').querySelector('input');
  const accept = $('gateAccept');

  gateRefresh = () => {
    const max = scroll.scrollHeight - scroll.clientHeight;
    const ratio = max <= 0 ? 1 : Math.min(1, scroll.scrollTop / max);
    $('gateBar').style.width = `${(ratio * 100).toFixed(1)}%`;

    if (gateMode === 'view') { accept.disabled = false; return; }

    const atEnd = ratio >= 0.999;
    if (atEnd && box.disabled) {
      box.disabled = false;
      $('gateConsent').classList.remove('is-locked');
    }
    accept.disabled = !(atEnd && box.checked);
  };

  scroll.addEventListener('scroll', gateRefresh, { passive: true });
  box.addEventListener('change', () => {
    $('gateConsent').classList.toggle('is-signed', box.checked);
    gateRefresh();
  });

  accept.addEventListener('click', () => {
    if (gateMode === 'first') {
      try {
        localStorage.setItem(CONSENT_KEY, JSON.stringify({ accepted: true, at: new Date().toISOString(), version: 2 }));
      } catch { }
      renderTermsHint();
    }
    closeGate();
  });
}

function closeGate() {
  const gate = $('consentGate');
  gate.classList.add('is-closing');
  document.body.classList.remove('is-busy');
  setTimeout(() => {
    gate.hidden = true;
    gate.classList.remove('is-closing');
  }, 220);
}

function openGate(mode) {
  bindGate();
  gateMode = mode;

  const gate = $('consentGate');
  const scroll = $('gateScroll');
  const box = $('gateConsent').querySelector('input');
  const label = $('gateConsent');
  const accept = $('gateAccept');

  gate.hidden = false;
  gate.classList.remove('is-closing');
  scroll.scrollTop = 0;

  if (mode === 'view') {
    box.checked = true;
    box.disabled = true;
    label.classList.add('is-signed');
    label.classList.remove('is-locked');
    accept.textContent = '关闭';
    $('gateBar').style.width = '100%';
  } else {
    box.checked = false;
    box.disabled = true;
    label.classList.remove('is-signed');
    label.classList.add('is-locked');
    accept.textContent = '继续';
    accept.disabled = true;
    $('gateBar').style.width = '0%';
    document.body.classList.add('is-busy');
  }

  requestAnimationFrame(gateRefresh);
}

function renderTermsHint() {
  const saved = readConsent();
  $('termsHint').textContent = saved?.accepted
    ? `已于 ${new Date(saved.at).toLocaleString('zh-CN', { hour12: false })} 同意`
    : '查看条款与隐私说明';
}

function initConsent() {
  const saved = readConsent();
  if (saved && saved.accepted) { renderTermsHint(); return; }
  openGate('first');
}

/* ---------- 签名区块展开 ---------- */

function expandSignature(open) {
  const body = $('sigBody');
  const toggle = $('sigToggle');
  body.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  $('sigBlock').classList.toggle('is-open', open);
  if (open) $('sigBlock').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ---------- 初始化 ---------- */

loadSettings();
buildNav();

const savedTheme = (() => { try { return localStorage.getItem('rpk-theme') || S.settings.theme; } catch { return S.settings.theme; } })();
applyTheme(savedTheme);
renderKV();
renderVerify();
renderImages();
renderForm();
renderIdentity();
renderSettingsPage();
renderHistory();
initConsent();
restoreIdentity().then(() => updateStorageHint());
$('topTitle').textContent = PAGES[0].label;
setTrack(0, false);

/* ---------- 事件绑定 ---------- */

$('drop').addEventListener('click', () => $('fileInput').click());
$('drop').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
});

document.addEventListener('dragover', e => {
  e.preventDefault();
  $('drop').classList.add('over');
});
document.addEventListener('dragleave', e => {
  if (!e.relatedTarget) $('drop').classList.remove('over');
});
document.addEventListener('drop', e => {
  e.preventDefault();
  $('drop').classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

$('fileInput').addEventListener('change', e => {
  const f = e.target.files?.[0];
  if (f) loadFile(f);
  e.target.value = '';
});

$('changeFile').addEventListener('click', () => $('fileInput').click());

for (const id of ['fName', 'fPackage', 'fVersionName', 'fVersionCode']) {
  $(id).addEventListener('input', renderDirty);
}

$('pickIcon').addEventListener('click', () => {
  S.pending = { name: iconName() };
  $('imageInput').click();
});

$('imageInput').addEventListener('change', e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  const target = S.pending?.name;
  if (!target) return;
  if (!Ed.name || Ed.name !== target) {
    const meta = imgMeta(target) || { w: 0, h: 0 };
    Ed.name = target;
    Ed.W = meta.w;
    Ed.H = meta.h;
    Ed.circle = false;
    Ed.lock = true;
    Ed.zoom = 1;
    Ed.dx = 0;
    Ed.dy = 0;
    $('edSub').textContent = target;
  }
  loadIntoEditor(f);
});

$('tabImages').addEventListener('click', () => setTab('images'));
$('tabFiles').addEventListener('click', () => setTab('files'));
$('search').addEventListener('input', () => { if (S.tab === 'files') renderFiles(); else renderImages(); });

$('exportImages').addEventListener('click', async () => {
  if (!S.pkg) return;
  const files = S.pkg.images.map(i => ({ name: i.name, data: imageBytes(i.name) })).filter(f => f.data);
  const out = makeZip(files);
  await saveBlob(`${S.pkg.manifest?.package || 'rpk'}-images.zip`, out);
  snack(`已导出 ${files.length} 张图片`);
});

/* 编辑器 */
for (const b of $('edModes').children) {
  b.addEventListener('click', () => setMode(b.dataset.mode));
}
$('edW').addEventListener('input', onWidthInput);
$('edH').addEventListener('input', onHeightInput);
$('edLock').addEventListener('click', () => {
  Ed.lock = !Ed.lock;
  $('edLock').setAttribute('aria-pressed', String(Ed.lock));
});
$('edZoom').addEventListener('input', e => {
  Ed.zoom = Number(e.target.value) / 100;
  $('edZoomVal').textContent = `${e.target.value}%`;
  draw();
});
$('edCircle').addEventListener('change', e => { Ed.circle = e.target.checked; draw(); });
$('edApply').addEventListener('click', applyEditor);
$('edPick').addEventListener('click', () => { S.pending = { name: Ed.name }; $('imageInput').click(); });

/* 拖动画布 */
let drag = null;
$('edCanvas').addEventListener('pointerdown', e => {
  if (Ed.mode !== 'cover') return;
  drag = { x: e.clientX, y: e.clientY, dx: Ed.dx, dy: Ed.dy };
  $('edCanvas').setPointerCapture(e.pointerId);
});
$('edCanvas').addEventListener('pointermove', e => {
  if (!drag) return;
  const k = $('edCanvas').width / Math.max(1, $('edCanvas').getBoundingClientRect().width);
  Ed.dx = drag.dx + (e.clientX - drag.x) * k;
  Ed.dy = drag.dy + (e.clientY - drag.y) * k;
  draw();
});
$('edCanvas').addEventListener('pointerup', () => { drag = null; });
$('edCanvas').addEventListener('pointercancel', () => { drag = null; });

/* 签名 */
$('sigToggle').addEventListener('click', () => expandSignature($('sigBody').hidden));
$('genId').addEventListener('click', generateIdentity);
$('loadKey').addEventListener('click', () => $('keyInput').click());
$('keyInput').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (files.length) await importIdentityFiles(files);
});
$('exportId').addEventListener('click', () => exportIdentityPart('key'));
$('exportCert').addEventListener('click', () => exportIdentityPart('cert'));
$('exportPub').addEventListener('click', () => exportIdentityPart('pub'));
$('exportZip').addEventListener('click', () => exportIdentityPart('zip'));
$('copyFingerprint').addEventListener('click', async () => {
  if (!S.identity) return;
  const text = fingerprint();
  try { await navigator.clipboard.writeText(text); snack('指纹已复制'); }
  catch { snack(text); }
});

for (const b of $('idMode').children) {
  b.addEventListener('click', () => {
    S.idMode = b.dataset.mode;
    for (const x of $('idMode').children) x.setAttribute('aria-pressed', String(x === b));
    $('idManual').hidden = S.idMode !== 'manual';
    if (S.idMode === 'auto' && !$('cnInput').value) $('cnInput').value = '';
  });
}

/* 导出 */
$('exportBtn').addEventListener('click', doExport);
$('recentShare').addEventListener('click', async () => {
  if (!S.lastExport) return;
  await shareBlob(S.lastExport.name, S.lastExport.bytes);
});
$('optVerify').addEventListener('change', e => { S.settings.optVerify = e.target.checked; saveSettings(); });
$('optWatch').addEventListener('change', e => { S.settings.optWatch = e.target.checked; saveSettings(); });

/* 工具箱 */
$('toolDisguise').addEventListener('click', async () => {
  if (!S.pkg) { snack('先载入一个包'); return; }
  openLayer('tb');
  await renderToolbox();
});
for (const b of $('tbTabs').children) {
  b.addEventListener('click', async () => {
    S.tbOs = b.dataset.os;
    for (const x of $('tbTabs').children) x.setAttribute('aria-pressed', String(x === b));
    await renderToolbox();
  });
}

/* 历史 */
$('clearHistory').addEventListener('click', () => {
  if (!S.history.length) return;
  openSheet('清空全部历史记录？', [
    {
      label: '清空，无法恢复',
      danger: true,
      icon: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
      onPick: async () => {
        await dbClear('history');
        await refreshHistory();
        snack('已清空');
      },
    },
  ]);
});

/* 设置 */
for (const b of $('themeSeg').children) {
  b.addEventListener('click', () => {
    S.settings.theme = b.dataset.themeChoice;
    applyTheme(S.settings.theme);
    saveSettings();
  });
}
$('openStorage').addEventListener('click', async () => {
  renderSettingsPage();
  await updateStorageHint();
  openLayer('storage');
});
$('openTerms').addEventListener('click', () => openGate('view'));

$('stRecord').addEventListener('change', e => { S.settings.record = e.target.checked; saveSettings(); });
$('stFiles').addEventListener('change', e => { S.settings.storeFiles = e.target.checked; saveSettings(); });
$('stIdentity').addEventListener('change', async e => {
  S.settings.autoIdentity = e.target.checked;
  saveSettings();
  if (S.settings.autoIdentity) await persistIdentity();
  else await dbDel('kv', 'identity');
  updateStorageHint();
});
$('stClearHistory').addEventListener('click', async () => {
  await dbClear('history');
  await refreshHistory();
  snack('历史已清空');
});
$('stClearIdentity').addEventListener('click', async () => {
  await dbDel('kv', 'identity');
  S.identity = null;
  renderIdentity();
  await updateStorageHint();
  snack('身份已删除');
});
$('updAuto').addEventListener('change', e => { S.settings.updAuto = e.target.checked; saveSettings(); });
$('updMirror').addEventListener('change', e => { S.settings.updMirror = e.target.value.trim(); saveSettings(); });
$('updCheck').addEventListener('click', () => checkUpdate(true));

$('aboutVersion').textContent = `${VERSION.name} · Material 3`;

/* 启动时的静默检查 */
if (S.settings.updAuto) setTimeout(() => checkUpdate(false), 2500);
