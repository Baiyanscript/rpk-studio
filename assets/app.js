import { inspect, repack, createIdentity, importPrivateKey, sha256, measureImage } from './rpk.js';
import { dataOf } from './zip.js';
import { Zip, ZipDeflate } from '../vendor/fflate.js';

const BUILD = __BUILD__;

(function syncVersion() {
  if (window.__PAGE_VERSION__ === BUILD) return;
  try {
    const key = `rpk-reload-${BUILD}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {}
  const u = new URL(location.href);
  u.searchParams.set('v', BUILD);
  location.replace(u.toString());
})();

const $ = id => document.getElementById(id);

const PAGES = [
  { id: 'overview', label: '包', path: 'M12 2 3 6.5v11L12 22l9-4.5v-11L12 2zm0 2.2 6.5 3.2L12 10.6 5.5 7.4 12 4.2z' },
  { id: 'edit', label: '编辑', path: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z' },
  { id: 'export', label: '导出', path: 'M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4L11 12.2V3zM5 19h14v2H5z' },
];

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
  optVerify: true,
  optWatch: true,
  dupes: null,
  layer: null,
};

const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const hexUpper = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const te = new TextEncoder();

/* ---------- 调度 ---------- */

const yieldToUI = () => new Promise(resolve => {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    scheduler.yield().then(resolve, resolve);
    return;
  }
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
  ch.port2.postMessage(0);
});

const raf = () => new Promise(r => requestAnimationFrame(() => r()));

let snackTimer = null;
function snack(text) {
  const bar = $('snackbar');
  bar.textContent = text;
  bar.classList.add('is-open');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => bar.classList.remove('is-open'), 3600);
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- 忙碌遮罩 ---------- */

let scrimTimer = null;

function showScrim(text, sub = '') {
  $('scrimText').textContent = text;
  $('scrimSub').textContent = sub;
  const bar = $('scrimBar');
  bar.hidden = true;
  bar.firstElementChild.style.width = '0%';
  clearTimeout(scrimTimer);
  scrimTimer = setTimeout(() => {
    $('scrim').hidden = false;
    document.body.classList.add('is-busy');
  }, 140);
}

function setScrimProgress(done, total, label) {
  if (total <= 0) return;
  const bar = $('scrimBar');
  if (bar.hidden) bar.hidden = false;
  bar.firstElementChild.style.width = `${Math.round((done / total) * 100)}%`;
  if (label) $('scrimSub').textContent = `${label} ${done} / ${total}`;
}

function hideScrim() {
  clearTimeout(scrimTimer);
  $('scrim').hidden = true;
  document.body.classList.remove('is-busy');
}

/* ---------- 通用 ---------- */

function download(name, bytes) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const entryByName = n => S.pkg?.entries.find(e => e.name === n) || null;
const imageBytes = n => S.images[n] || (entryByName(n) ? dataOf(entryByName(n)) : null);
const iconName = () => (S.pkg?.manifest?.icon || '/common/icon.png').replace(/^\//, '');

function imgMeta(name) {
  const meta = S.pkg?.images.find(i => i.name === name);
  if (!meta) return null;
  if (!meta.w && meta.entry) {
    const size = measureImage(meta.entry) || S.sizes.get(name);
    if (size) { meta.w = size.w; meta.h = size.h; S.sizes.set(name, size); }
  }
  return meta;
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
  showNavBar();
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
    try { $('pager').setPointerCapture(e.pointerId); } catch {}
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

// 横向拖动结束后吞掉随之而来的 click，避免误开卡片
let suppressClick = false;
document.addEventListener('click', e => {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

/* ---------- 底栏收起 ---------- */

const navBar = $('navBar');
let navHidden = false;

function hideNavBar() {
  if (navHidden) return;
  navHidden = true;
  navBar.classList.add('is-hidden');
}

function showNavBar() {
  if (!navHidden) return;
  navHidden = false;
  navBar.classList.remove('is-hidden');
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
}

function hideLayer(name) {
  const el = layerEl(name);
  if (!el) return;
  el.classList.remove('is-open');
  el.setAttribute('aria-hidden', 'true');
  S.layer = null;
  setTimeout(() => { if (!S.layer) showNavBar(); }, 200);
}

function openLayer(name) {
  if (S.layer === name) return;
  history.pushState({ rpkLayer: name }, '');
  showLayer(name);
}

function closeLayer() {
  if (!S.layer) return;
  history.back();
}

window.addEventListener('popstate', () => {
  if (S.layer) hideLayer(S.layer);
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (sheetOpen) { closeSheet(); return; }
    if (S.layer) { closeLayer(); return; }
    return;
  }
  if (S.layer || sheetOpen) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') { goTo(S.page - 1, true); showNavBar(); }
  else if (e.key === 'ArrowRight') { goTo(S.page + 1, true); showNavBar(); }
});

/* ---------- 底部弹层 ---------- */

let sheetOpen = false;
let sheetTimer = null;

function openSheet(title, items) {
  document.body.classList.add('sheet-open');
  $('sheetTitle').textContent = title;
  const list = $('sheetList');
  list.textContent = '';
  for (const item of items) {
    const b = el('button', `md-sheet-item${item.danger ? ' is-danger' : ''}`);
    b.type = 'button';
    b.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${item.icon}"/></svg><span>${item.label}</span>`;
    b.addEventListener('click', () => {
      closeSheet();
      item.onPick?.();
    });
    list.appendChild(b);
  }
  $('sheetScrim').hidden = false;
  $('sheet').setAttribute('aria-hidden', 'false');
  clearTimeout(sheetTimer);
  requestAnimationFrame(() => {
    $('sheetScrim').classList.add('is-open');
    $('sheet').classList.add('is-open');
  });
  sheetOpen = true;
}

function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false;
  document.body.classList.remove('sheet-open');
  $('sheetScrim').classList.remove('is-open');
  $('sheet').classList.remove('is-open');
  $('sheet').setAttribute('aria-hidden', 'true');
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => { $('sheetScrim').hidden = true; }, 240);
}

$('sheetScrim').addEventListener('click', closeSheet);

/* ---------- 渲染：概览 ---------- */

function setChip(state, text) {
  const c = $('badge');
  c.className = `md-chip${state ? ' md-chip--' + state : ''}`;
  c.textContent = text;
}

function renderForm() {
  const m = S.pkg?.manifest;
  const on = Boolean(m);
  for (const id of ['fName', 'fPackage', 'fVersionName', 'fVersionCode']) $(id).disabled = !on;
  $('pickIcon').disabled = !on;
  $('search').disabled = !on;
  $('exportBtn').disabled = !on || !S.identity || S.busy;
  if (!m) {
    $('detailState').textContent = '载入包后可编辑';
    return;
  }
  $('fName').value = m.name || '';
  $('fPackage').value = m.package || '';
  $('fVersionName').value = m.versionName || '';
  $('fVersionCode').value = m.versionCode ?? '';

  const icon = imageBytes(iconName()) || S.pkg.icon;
  const box = $('iconPreview');
  if (box.dataset.url) { URL.revokeObjectURL(box.dataset.url); delete box.dataset.url; }
  box.textContent = '';
  if (icon) {
    const url = URL.createObjectURL(new Blob([icon], { type: 'image/png' }));
    box.dataset.url = url;
    const img = new Image();
    img.src = url;
    img.onload = () => { $('iconHint').textContent = `${img.naturalWidth} × ${img.naturalHeight} PNG`; };
    img.onerror = () => { $('iconHint').textContent = '图标解码失败'; };
    box.appendChild(img);
  }
}

function renderKV() {
  const kv = $('kv');
  kv.textContent = '';
  if (!S.pkg) {
    for (const k of ['包名', '应用名', '版本', '版本号', '页面', '文件', '体积', '平台版本']) {
      kv.append(el('dt', null, k), el('dd', null, '—'));
    }
    return;
  }
  const { manifest, entries, bytes, sig } = S.pkg;
  const rows = [
    ['包名', manifest?.package || '—'],
    ['应用名', manifest?.name || '—'],
    ['版本', manifest?.versionName || '—'],
    ['版本号', String(manifest?.versionCode ?? '—')],
    ['页面', String(manifest?.router?.pages ? Object.keys(manifest.router.pages).length : 0)],
    ['文件', String(entries.filter(e => !e.isDir).length)],
    ['体积', fmtSize(bytes.length)],
    ['平台版本', String(manifest?.minPlatformVersion ?? '—')],
  ];
  for (const [k, v] of rows) kv.append(el('dt', null, k), el('dd', null, v));
  kv.append(el('dt', null, '签名'), el('dd', null, sig.present ? `RSA-${sig.signature.length * 8}` : '无'));
  kv.append(el('dt', null, '摘要'), el('dd', null, sig.present ? 'SHA-256' : '—'));
}

function renderVerify() {
  const box = $('verify');
  const pkg = S.pkg;
  if (!pkg) {
    box.textContent = '';
    setChip('', '等待文件');
    return;
  }
  if (!pkg.sig?.present) {
    box.textContent = '';
    box.appendChild(el('p', 'md-body-small md-muted', '这个包没有 META-INF 签名块。'));
    setChip('', '未签名');
    return;
  }
  if (!pkg.verify) {
    box.textContent = '';
    const row = el('div', 'md-verify__pending');
    row.append(el('span', 'md-spinner md-spinner--sm'), el('span', 'md-body-small md-muted', '正在校验签名…'));
    box.appendChild(row);
    setChip('warn', '校验中');
    return;
  }
  const v = pkg.verify;
  box.textContent = '';
  const line = (label, right) => {
    const row = el('div', 'md-row');
    row.append(el('span', 'md-body-small md-muted', label), el('span', 'md-body-small', right));
    box.appendChild(row);
  };
  line('分段摘要', v.digestOk ? '一致' : '不一致');
  line('RSA 签名', v.rsaOk ? '有效' : '无效');
  line('文件摘要', `${v.fileCount - v.badFiles} / ${v.fileCount}`);
  line(v.cert.cn || '证书', v.cert.notAfter ? v.cert.notAfter.toISOString().slice(0, 10) : '—');
  const ok = v.digestOk && v.rsaOk && v.badFiles === 0;
  setChip(ok ? 'ok' : 'bad', ok ? '签名有效' : '校验失败');
}

function renderNotice() {
  const box = $('notice');
  const pkg = S.pkg;
  if (!pkg?.embedded) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.textContent = pkg.embedded.jsc
    ? `包内 ${pkg.embedded.source} 是 JSC 字节码，其中另存了一份编译时的 manifest。改包名或版本只改外层 JSON，握手指令仍会读字节码里的旧值。`
    : `包内 ${pkg.embedded.source} 是未压缩脚本，manifest 副本与外层一致时无需处理。`;
}

/* ---------- 文件列表 ---------- */

let fileToken = 0;

async function renderFiles() {
  const token = ++fileToken;
  const list = $('fileList');
  const status = $('listStatus');
  const q = ($('search').value || '').trim().toLowerCase();
  list.textContent = '';
  status.hidden = true;

  if (!S.pkg) {
    list.appendChild(el('li', 'md-list-item md-muted', '载入包后显示'));
    $('entryCount').textContent = '';
    return;
  }
  const all = S.pkg.entries.filter(e => !e.isDir);
  const entries = q ? all.filter(e => e.name.toLowerCase().includes(q)) : all;
  $('entryCount').textContent = String(entries.length);

  const BATCH = 50;
  for (let i = 0; i < entries.length; i += BATCH) {
    if (token !== fileToken) return;
    const frag = document.createDocumentFragment();
    for (const e of entries.slice(i, i + BATCH)) {
      const li = el('li', 'md-list-item');
      const name = el('span', 'md-list-item__name', e.name);
      li.append(name, el('span', 'md-list-item__meta', fmtSize(e.usize)));
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => openFileSheet(e));
      frag.appendChild(li);
    }
    list.appendChild(frag);
    if (entries.length > BATCH) {
      status.hidden = false;
      status.textContent = `已显示 ${Math.min(i + BATCH, entries.length)} / ${entries.length}`;
      await yieldToUI();
    }
  }
  if (token !== fileToken) return;
  status.hidden = true;
}

function openFileSheet(entry) {
  openSheet(entry.name.split('/').pop(), [
    {
      label: '取出这个文件',
      icon: 'M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4L11 12.2V3zM5 19h14v2H5z',
      onPick: () => download(entry.name.split('/').pop(), dataOf(entry)),
    },
    {
      label: '复制包内路径',
      icon: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
      onPick: async () => {
        try { await navigator.clipboard.writeText(entry.name); snack('已复制路径'); }
        catch { snack(entry.name); }
      },
    },
  ]);
}

/* ---------- 图片网格 ---------- */

let imgToken = 0;
const hydration = [];
let pumping = false;

const io = 'IntersectionObserver' in window
  ? new IntersectionObserver(list => {
      for (const item of list) {
        if (!item.isIntersecting) continue;
        io.unobserve(item.target);
        hydration.push(item.target);
      }
      pumpHydration();
    }, { root: null, rootMargin: '320px 0px' })
  : null;

async function pumpHydration() {
  if (pumping) return;
  pumping = true;
  let n = 0;
  while (hydration.length) {
    const tile = hydration.shift();
    if (tile.isConnected) hydrateTile(tile);
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
  tile.style.animationDelay = `${Math.min(index, 12) * 8}ms`;
  const frame = el('div', 'md-tile__img');
  frame.appendChild(el('span', 'md-tile__ph'));
  tile.append(frame,
    el('div', 'md-tile__name', img.name.split('/').pop()),
    el('div', 'md-tile__meta', fmtSize(img.bytes)));
  return tile;
}

async function hydrateTile(tile) {
  const name = tile.dataset.name;
  const meta = S.pkg?.images.find(i => i.name === name);
  if (!meta) return;
  const full = makeTile(meta);
  full.style.opacity = '0';
  tile.replaceWith(full);
  await raf();
  full.style.transition = 'opacity .2s ease';
  full.style.opacity = '1';
}

function makeTile(img) {
  const changed = Boolean(S.images[img.name]);
  const bytes = imageBytes(img.name);
  const tile = el('div', `md-tile${changed ? ' is-changed' : ''}`);
  tile.dataset.name = img.name;
  tile.title = img.name;

  const frame = el('div', 'md-tile__img');
  if (bytes) {
    const old = S.urls.get(img.name);
    if (old) URL.revokeObjectURL(old);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    S.urls.set(img.name, url);
    const im = new Image();
    im.src = url;
    im.loading = 'lazy';
    im.decoding = 'async';
    im.alt = '';
    frame.appendChild(im);
  } else {
    frame.appendChild(el('span', 'md-tile__ph'));
  }

  const meta = imgMeta(img.name);
  const dim = meta?.w ? `${meta.w}×${meta.h}` : fmtSize(img.bytes);
  const base = img.name.split('/').pop();
  const dir = S.dupes?.has(base) ? subLabel(img.name) : '';
  tile.append(frame,
    el('div', 'md-tile__name', base),
    el('div', 'md-tile__meta', dir ? `${dir} · ${dim}` : dim));

  if (changed) tile.appendChild(el('span', 'md-tile__dot'));

  tile.addEventListener('click', () => openImageSheet(img.name));
  return tile;
}

async function renderImages() {
  const token = ++imgToken;
  const grid = $('imageGrid');
  const status = $('gridStatus');
  const q = ($('search').value || '').trim().toLowerCase();
  grid.textContent = '';
  status.hidden = true;
  $('imgCount').textContent = S.pkg ? String(S.pkg.images.length) : '0';

  if (io) io.disconnect();
  hydration.length = 0;
  for (const u of S.urls.values()) URL.revokeObjectURL(u);
  S.urls.clear();

  if (!S.pkg || !S.pkg.images.length) {
    grid.appendChild(el('p', 'md-body-small md-muted', S.pkg ? '包内没有图片资源' : '载入包后显示'));
    return;
  }

  const list = q ? S.pkg.images.filter(i => i.name.toLowerCase().includes(q)) : S.pkg.images;
  if (!list.length) {
    grid.appendChild(el('p', 'md-body-small md-muted', '没有匹配的图片'));
    return;
  }
  S.dupes = duplicateBases(list);

  const BATCH = 20;
  for (let i = 0; i < list.length; i += BATCH) {
    if (token !== imgToken) return;
    const frag = document.createDocumentFragment();
    const fresh = [];
    for (let k = i; k < Math.min(i + BATCH, list.length); k++) {
      const tile = skeletonTile(list[k], k);
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
  if (token !== imgToken) return;
  status.hidden = true;
}

function updateTile(name) {
  const meta = S.pkg?.images.find(i => i.name === name);
  if (!meta) return;
  const old = $('imageGrid').querySelector(`.md-tile[data-name="${CSS.escape(name)}"]`);
  if (old) {
    const url = S.urls.get(name);
    if (url) { URL.revokeObjectURL(url); S.urls.delete(name); }
    old.replaceWith(makeTile(meta));
  }
  if (name === iconName()) renderForm();
}

function openImageSheet(name) {
  const changed = Boolean(S.images[name]);
  const items = [
    {
      label: '调整尺寸与裁剪',
      icon: 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
      onPick: () => openEditor(name),
    },
    {
      label: '替换图片',
      icon: 'M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4L11 12.2V3zM5 19h14v2H5z',
      onPick: () => pickForImage(name),
    },
  ];
  if (changed) {
    items.push({
      label: '还原原图',
      icon: 'M12 5V2L7 7l5 5V9a5 5 0 1 1-5 5H5a7 7 0 1 0 7-9z',
      danger: true,
      onPick: () => revertImage(name),
    });
  }
  openSheet(name.split('/').pop(), items);
}

/* ---------- 状态 ---------- */

function renderDirty() {
  const m = S.pkg?.manifest;
  if (!m) {
    $('detailState').textContent = '载入包后可编辑';
    $('exportBtn').disabled = true;
    return;
  }
  const n = Object.keys(S.images).length;
  const diff =
    $('fName').value !== (m.name || '') ||
    $('fPackage').value !== (m.package || '') ||
    $('fVersionName').value !== (m.versionName || '') ||
    Number($('fVersionCode').value) !== Number(m.versionCode) ||
    n > 0;
  $('detailState').textContent = diff
    ? `已修改${n ? ` · ${n} 张图` : ''}，导出时生效`
    : '与包内一致';
  $('exportBtn').disabled = !S.identity || !S.pkg || S.busy;
}

function renderIdentity() {
  const name = $('idName');
  const chip = $('idChip');
  const info = $('idInfo');
  info.textContent = '';

  if (!S.identity) {
    name.textContent = '未设置';
    chip.className = 'md-chip';
    chip.textContent = '待生成';
    info.append(el('dt', null, '说明'), el('dd', null, '生成或导入后，导出时会用这张证书重签。'));
    $('exportId').disabled = true;
    $('copyFingerprint').disabled = true;
    $('exportBtn').disabled = true;
    return;
  }

  const id = S.identity;
  const fp = hexUpper(id.fingerprint).match(/../g).join(' ');
  name.textContent = id.cn || '未命名';
  chip.className = 'md-chip md-chip--ok';
  chip.textContent = '就绪';

  for (const [k, v] of [
    ['算法', 'RSA-2048 / SHA-256'],
    ['有效期', `${id.notBefore.toISOString().slice(0, 10)} → ${id.notAfter.toISOString().slice(0, 10)}`],
    ['指纹', fp],
    ['来源', id.imported ? '导入的私钥' : '页面生成'],
  ]) info.append(el('dt', null, k), el('dd', null, v));

  $('exportId').disabled = !id.pkcs8;
  $('copyFingerprint').disabled = false;
  $('exportBtn').disabled = !S.pkg || S.busy;
}

function setTab(tab) {
  S.tab = tab;
  const images = tab === 'images';
  $('tabImages').setAttribute('aria-selected', String(images));
  $('tabFiles').setAttribute('aria-selected', String(!images));
  $('imageGrid').hidden = !images;
  $('fileList').hidden = images;
  $('exportImages').classList.toggle('hidden', !images || !S.pkg);
  $('gridStatus').hidden = true;
  $('listStatus').hidden = true;
  if (images) renderImages(); else renderFiles();
}

/* ---------- 图片编辑器 ---------- */

const Ed = {
  name: '', img: null, iw: 0, ih: 0,
  W: 0, H: 0, targetW: 0, targetH: 0,
  mode: 'fit', zoom: 1, dx: 0, dy: 0,
  drag: null, file: null, circle: false, lock: true,
};

const HINTS = {
  fit: '整张图缩放到目标尺寸内，四周补透明。',
  cover: '等比放大铺满目标尺寸，拖动选位置。',
  stretch: '直接拉伸到目标尺寸，比例会变形。',
  raw: '保留原始像素，不缩放不裁剪。',
};

function openEditor(name) {
  const meta = imgMeta(name);
  if (!meta) return;
  const bytes = imageBytes(name);
  if (!bytes) { snack('这张图读不出来'); return; }

  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  Ed.name = name;
  Ed.W = meta.w || 0;
  Ed.H = meta.h || 0;
  Ed.targetW = Ed.W;
  Ed.targetH = Ed.H;
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
    requestAnimationFrame(() => {
      setMode('fit');
      scaleCanvas();
    });
  };
  img.onerror = () => snack('图片解码失败');
  img.src = url;
  setTimeout(() => URL.revokeObjectURL(url), 12000);
}

function pickForImage(name) {
  S.pending = { name };
  $('imageInput').click();
}

function revertImage(name) {
  if (!S.images[name]) return;
  delete S.images[name];
  snack(`已还原 ${name.split('/').pop()}`);
  updateTile(name);
  renderDirty();
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
  if (Ed.lock && Ed.iw && Ed.ih) {
    $('edH').value = Math.max(1, Math.round(w * (Ed.ih / Ed.iw)));
  }
  applySize();
}

function onHeightInput() {
  const h = clamp(Math.round(Number($('edH').value) || 1), 1, 8192);
  if (Ed.lock && Ed.iw && Ed.ih) {
    $('edW').value = Math.max(1, Math.round(h * (Ed.iw / Ed.ih)));
  }
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
  cv.style.imageRendering = 'auto';
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
    if (meta) {
      meta.w = cv.width;
      meta.h = cv.height;
      S.sizes.set(Ed.name, { w: cv.width, h: cv.height });
    }

    closeLayer();
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

/* ---------- 流式 zip ---------- */

async function zipAsync(files, onProgress) {
  const chunks = [];
  let failure = null;
  const zip = new Zip((err, chunk) => {
    if (err) { failure = err; return; }
    if (chunk) chunks.push(chunk);
  });
  const names = Object.keys(files);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(files[name], true);
    if (i % 6 === 5 || i === names.length - 1) {
      onProgress?.(i + 1, names.length);
      await yieldToUI();
    }
  }
  zip.end();
  if (failure) throw failure;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/* ---------- 身份导出 ---------- */

function derToPem(der, label) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < der.length; i += chunk) {
    bin += String.fromCharCode.apply(null, der.subarray(i, i + chunk));
  }
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

async function exportIdentity() {
  const id = S.identity;
  if (!id?.pkcs8) { snack('当前身份没有可导出的私钥'); return; }
  const btn = $('exportId');
  btn.disabled = true;
  try {
    const priv = derToPem(id.pkcs8, 'PRIVATE KEY');
    const cert = derToPem(id.certDer, 'CERTIFICATE');
    const readme = [
      'RPK Studio 导出的签名身份',
      '',
      `CN: ${id.cn}`,
      `有效期至: ${id.notAfter.toISOString()}`,
      `SHA-256 指纹: ${hexUpper(id.fingerprint).match(/../g).join(':')}`,
      '',
      'private.pem      PKCS#8 私钥，务必保密',
      'certificate.pem  X.509 自签证书',
      '',
      '转成 keystore：',
      'openssl pkcs12 -export -inkey private.pem -in certificate.pem -out key.p12',
    ].join('\n');

    const zipped = await zipAsync({
      'private.pem': te.encode(priv),
      'certificate.pem': te.encode(cert),
      'README.txt': te.encode(readme),
    });
    const safe = (id.cn || 'identity').replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
    download(`${safe}-identity.zip`, zipped);
    snack('身份已导出：private.pem + certificate.pem');
  } catch (e) {
    snack(`导出失败：${e.message || e}`);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 读写 ---------- */

async function loadFile(file) {
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

    $('drop').classList.add('hidden');
    $('overviewBody').classList.remove('hidden');
    $('fileName').textContent = file.name;
    $('fileMeta').textContent = `${fmtSize(file.size)} · ${pkg.entries.length} 项 · ${pkg.manifest?.package || '未知包名'}`;

    hideScrim();
    renderForm();
    renderKV();
    renderVerify();
    renderNotice();
    if (S.tab === 'images') renderImages(); else renderFiles();
    renderDirty();

    const v = pkg.verify;
    const ok = v && v.digestOk && v.rsaOk && v.badFiles === 0;
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

function collectPatch() {
  const m = { ...S.pkg.manifest };
  m.name = $('fName').value.trim();
  m.package = $('fPackage').value.trim();
  m.versionName = $('fVersionName').value.trim();
  m.versionCode = Number($('fVersionCode').value);

  const watch = S.pkg.watch
    ? { ...S.pkg.watch, name: m.name, package: m.package, versionName: m.versionName, versionCode: m.versionCode }
    : null;
  const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

  return {
    manifestText: changed(S.pkg.manifest, m) ? JSON.stringify(m, null, 2) + '\n' : null,
    watchText: (S.optWatch && watch && changed(S.pkg.watch, watch)) ? JSON.stringify(watch, null, 2) + '\n' : null,
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

async function doExport() {
  if (!S.pkg || !S.identity || S.busy) return;
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
    download(`${patch.manifest.package}.release.${patch.manifest.versionName}.rpk`, out);

    const delta = out.length - before;
    const sign = `${delta >= 0 ? '+' : '-'}${fmtSize(Math.abs(delta))}`;
    hideScrim();

    if (S.optVerify) {
      showScrim('正在自检导出的包', '重新解析刚生成的文件');
      const check = await inspect(out);
      const ok = check.verify.digestOk && check.verify.rsaOk && check.verify.badFiles === 0;
      hideScrim();
      snack(`已导出 ${fmtSize(out.length)}（${sign}）· ${ok ? '签名自检通过' : '签名自检失败'}`);
    } else {
      snack(`已导出 ${fmtSize(out.length)}（${sign}）`);
    }
  } catch (e) {
    snack(`导出失败：${e.message || e}`);
  } finally {
    hideScrim();
    S.busy = false;
    btn.classList.remove('is-loading');
    renderDirty();
  }
}

/* ---------- 事件 ---------- */

buildNav();

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
  e.target.value = '';
  if (f) loadFile(f);
});
$('changeFile').addEventListener('click', () => $('fileInput').click());

for (const id of ['fName', 'fPackage', 'fVersionName', 'fVersionCode']) {
  $(id).addEventListener('input', renderDirty);
}

$('tabImages').addEventListener('click', () => setTab('images'));
$('tabFiles').addEventListener('click', () => setTab('files'));

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (S.tab === 'images') renderImages(); else renderFiles();
  }, 180);
});

$('optVerify').addEventListener('change', e => { S.optVerify = e.target.checked; });
$('optWatch').addEventListener('change', e => { S.optWatch = e.target.checked; });

$('pickIcon').addEventListener('click', () => pickForImage(iconName()));

$('imageInput').addEventListener('change', async e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  const pending = S.pending;
  S.pending = null;
  if (!f || !pending) return;
  const meta = S.pkg.images.find(i => i.name === pending.name);
  if (!meta) return;
  Ed.name = pending.name;
  Ed.W = meta.w || 0;
  Ed.H = meta.h || 0;
  Ed.targetW = Ed.W;
  Ed.targetH = Ed.H;
  await loadIntoEditor(f);
});

$('exportImages').addEventListener('click', async () => {
  if (!S.pkg) return;
  const btn = $('exportImages');
  if (btn.classList.contains('is-loading')) return;
  btn.classList.add('is-loading');
  btn.disabled = true;
  const list = S.pkg.images;
  showScrim('正在打包图片', `0 / ${list.length}`);
  try {
    const files = {};
    for (let i = 0; i < list.length; i++) {
      files[list[i].name] = imageBytes(list[i].name);
      if (i % 12 === 11) {
        setScrimProgress(i + 1, list.length, '读取图片');
        await yieldToUI();
      }
    }
    const zipped = await zipAsync(files, (done, total) => setScrimProgress(done, total, '压缩'));
    download(`${S.pkg.manifest?.package || 'rpk'}-images.zip`, zipped);
    hideScrim();
    snack(`导出 ${list.length} 张图片 · ${fmtSize(zipped.length)}`);
  } catch (e) {
    hideScrim();
    snack(`导出失败：${e.message || e}`);
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
});

$('genId').addEventListener('click', async () => {
  const cn = $('cnInput').value.trim() || 'Vela App';
  const btn = $('genId');
  btn.disabled = true;
  btn.classList.add('is-loading');
  await raf();
  try {
    const id = await createIdentity(cn, 3650);
    S.identity = { ...id, fingerprint: new Uint8Array(await sha256(id.certDer)) };
    renderIdentity();
    renderDirty();
    snack(`已生成自签证书：${cn}`);
  } catch (e) {
    snack(`生成失败：${e.message || e}`);
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
});

$('loadKey').addEventListener('click', () => $('keyInput').click());
$('keyInput').addEventListener('change', async e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { key, pubDer } = await importPrivateKey(await f.text());
    const cn = $('cnInput').value.trim() || 'Imported Key';
    const cert = await createIdentity(cn, 3650, { key, pubDer });
    S.identity = { ...cert, cn, fingerprint: new Uint8Array(await sha256(cert.certDer)), imported: true };
    renderIdentity();
    renderDirty();
    snack(`已载入私钥：${cn}`);
  } catch (err) {
    snack(`私钥载入失败：${err.message || err}`);
  }
});

$('exportId').addEventListener('click', exportIdentity);
$('copyFingerprint').addEventListener('click', async () => {
  if (!S.identity) return;
  const fp = hexUpper(S.identity.fingerprint).match(/../g).join(':');
  try {
    await navigator.clipboard.writeText(fp);
    snack('指纹已复制');
  } catch {
    snack(fp);
  }
});

$('exportBtn').addEventListener('click', doExport);

/* 编辑器 */

$('edModes').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

$('edZoom').addEventListener('input', e => {
  Ed.zoom = Number(e.target.value) / 100;
  $('edZoomVal').textContent = `${Math.round(Ed.zoom * 100)}%`;
  draw();
});

$('edW').addEventListener('input', onWidthInput);
$('edH').addEventListener('input', onHeightInput);
$('edW').addEventListener('blur', () => { if (Ed.mode !== 'raw') $('edW').value = Ed.W; });
$('edH').addEventListener('blur', () => { if (Ed.mode !== 'raw') $('edH').value = Ed.H; });

$('edLock').addEventListener('click', () => {
  Ed.lock = !Ed.lock;
  $('edLock').setAttribute('aria-pressed', String(Ed.lock));
  if (Ed.lock && Ed.iw && Ed.ih) {
    const { w } = readSize();
    $('edH').value = Math.max(1, Math.round(w * (Ed.ih / Ed.iw)));
    applySize();
  }
});

$('edCircle').addEventListener('change', e => {
  Ed.circle = e.target.checked;
  draw();
});

$('edApply').addEventListener('click', applyEditor);
$('edPick').addEventListener('click', () => { S.pending = { name: Ed.name }; $('imageInput').click(); });

(function bindStage() {
  const stage = $('edStage');
  const cv = $('edCanvas');

  stage.addEventListener('pointerdown', e => {
    if (Ed.mode !== 'cover' || !Ed.img) return;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
    Ed.drag = { x: e.clientX, y: e.clientY, dx: Ed.dx, dy: Ed.dy };
  });

  stage.addEventListener('pointermove', e => {
    if (!Ed.drag) return;
    const rect = cv.getBoundingClientRect();
    const k = cv.width / Math.max(1, rect.width);
    Ed.dx = Ed.drag.dx + (e.clientX - Ed.drag.x) * k;
    Ed.dy = Ed.drag.dy + (e.clientY - Ed.drag.y) * k;
    draw();
  });

  const end = e => {
    if (!Ed.drag) return;
    Ed.drag = null;
    stage.classList.remove('is-dragging');
    if (e && stage.hasPointerCapture?.(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
})();

for (const b of document.querySelectorAll('[data-back]')) {
  b.addEventListener('click', closeLayer);
}

window.addEventListener('resize', () => {
  setTrack(-S.page * pageWidth(), false);
  if (S.layer === 'editor') scaleCanvas();
});

/* 主题 */

const THEME_KEY = 'rpk-theme';

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = choice;
  try { localStorage.setItem(THEME_KEY, choice); } catch {}
  const seg = $('themeSeg');
  if (seg) {
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  }
  const hint = $('themeHint');
  if (hint) {
    hint.textContent = choice === 'auto'
      ? '跟随系统设置自动切换。'
      : choice === 'light' ? '固定浅色，忽略系统设置。' : '固定深色，忽略系统设置。';
  }
}

$('settingsBtn').addEventListener('click', () => openLayer('settings'));

$('themeSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-theme-choice]');
  if (b) applyTheme(b.dataset.themeChoice);
});

/* 版本契约 */
(function checkContract() {
  if (document.querySelectorAll('.md-page').length !== PAGES.length) {
    const bar = $('fatal');
    if (bar) {
      bar.hidden = false;
      bar.textContent = '页面与脚本版本不一致，部分功能不可用。请强制刷新（Ctrl/Cmd + Shift + R）。';
    }
  }
})();

/* 初始化 */

try { applyTheme(localStorage.getItem(THEME_KEY) || 'auto'); } catch { applyTheme('auto'); }
renderKV();
renderForm();
renderIdentity();
renderDirty();
renderImages();
setTrack(0, false);
