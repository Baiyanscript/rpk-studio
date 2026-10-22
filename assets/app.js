import { inspect, repack, createIdentity, importPrivateKey, sha256, measureImage } from './rpk.js';
import { dataOf } from './zip.js';
import { Zip, ZipDeflate } from '../vendor/fflate.js';

const BUILD = __BUILD__;

// HTML 与脚本版本不一致时自愈：只强刷一次，避免循环
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

const VIEWS = [
  { id: 'overview', label: '概览', path: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z' },
  { id: 'assets', label: '资源', path: 'M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z' },
  { id: 'details', label: '信息', path: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z' },
  { id: 'signature', label: '签名', path: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z' },
  { id: 'settings', label: '设置', path: 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.38.12-.6l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.22-.07.46.12.6l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.38-.12.6l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.46-.12-.6l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z' },
];

const S = {
  pkg: null,
  identity: null,
  images: {},
  urls: new Map(),
  tab: 'files',
  view: 'overview',
  fileName: '',
  busy: false,
  pending: null,
  optVerify: true,
  optWatch: true,
  sizes: new Map(),
  dupes: null,
};

const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const hexUpper = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const te = new TextEncoder();

/* ---------- 调度工具 ---------- */

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
  document.body.classList.add('snack-open');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => {
    bar.classList.remove('is-open');
    document.body.classList.remove('snack-open');
  }, 3800);
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
  const box = $('scrim');
  $('scrimText').textContent = text;
  $('scrimSub').textContent = sub;
  const bar = $('scrimBar');
  bar.hidden = true;
  bar.firstElementChild.style.width = '0%';
  clearTimeout(scrimTimer);
  // 快操作不闪屏：超过 140ms 才显示
  scrimTimer = setTimeout(() => {
    box.hidden = false;
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

function updateFab() {
  const fab = $('fab');
  const ready = Boolean(S.pkg && S.identity && !S.busy);
  const visible = ready && S.view !== 'settings';
  fab.disabled = !ready;
  fab.classList.toggle('is-off', !visible);
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
  const html = VIEWS.map(v => `
    <button class="md-nav-item" type="button" data-view="${v.id}" aria-current="${v.id === 'overview' ? 'page' : 'false'}" aria-label="${v.label}">
      <span class="md-nav-item__icon">${icon(v.path)}</span>
      <span class="md-nav-item__label">${v.label}</span>
    </button>`).join('');
  $('rail').innerHTML = html;
  $('navBar').innerHTML = html;
  for (const root of [$('rail'), $('navBar')]) {
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-view]');
      if (b) go(b.dataset.view);
    });
  }
  for (const b of document.querySelectorAll('[data-goto]')) {
    b.addEventListener('click', () => go(b.dataset.goto));
  }
}

function go(view) {
  const target = document.querySelector(`.md-view[data-view="${view}"]`);
  // 版本不匹配兜底：目标视图不存在就退回概览，别把页面清空
  if (!target) {
    view = 'overview';
    reportMismatch();
  }
  if (S.view === view) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  S.view = view;
  for (const v of document.querySelectorAll('.md-view')) {
    v.classList.toggle('is-active', v.dataset.view === view);
  }
  for (const b of document.querySelectorAll('.md-nav-item')) {
    b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  }
  updateFab();
  if (view === 'assets') {
    if (S.tab === 'files') renderFiles(); else renderImages();
  } else if (view === 'details') {
    renderForm();
  } else if (view === 'signature') {
    renderIdentity();
  } else if (view === 'settings') {
    renderSettings();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let mismatchShown = false;
function reportMismatch() {
  if (mismatchShown) return;
  mismatchShown = true;
  const bar = $('fatal');
  if (!bar) return;
  bar.hidden = false;
  bar.textContent = '页面与脚本版本不一致，部分功能不可用。请强制刷新（Ctrl/Cmd + Shift + R）。';
}

/* ---------- 概览 ---------- */

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
  updateFab();
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
    const row = el('div', 'md-row md-verify__pending');
    row.append(el('span', 'md-spinner md-spinner--sm'), el('span', 'md-body-small md-muted', '正在校验签名…'));
    box.appendChild(row);
    setChip('warn', '校验中');
    return;
  }
  const v = pkg.verify;
  box.textContent = '';
  const line = (ok, label, right) => {
    const row = el('div', 'md-row');
    row.style.justifyContent = 'space-between';
    row.append(el('span', 'md-body-small md-muted', label), el('span', 'md-body-small', right));
    box.appendChild(row);
  };
  line(v.digestOk, '分段摘要', v.digestOk ? '一致' : '不一致');
  line(v.rsaOk, 'RSA 签名', v.rsaOk ? '有效' : '无效');
  line(v.badFiles === 0, '文件摘要', `${v.fileCount - v.badFiles} / ${v.fileCount}`);
  line(true, v.cert.cn || '证书', v.cert.notAfter ? v.cert.notAfter.toISOString().slice(0, 10) : '—');
  const ok = v.digestOk && v.rsaOk && v.badFiles === 0;
  setChip(ok ? 'ok' : 'bad', ok ? '签名有效' : '校验失败');
}

function renderNotice() {
  const box = $('notice');
  const pkg = S.pkg;
  if (!pkg?.embedded) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.textContent = pkg.embedded.jsc
    ? `包内 ${pkg.embedded.source} 是 JSC 字节码，其中另存了一份编译时的 manifest。改包名或版本只改外层 manifest.json，握手指令仍会读字节码里的旧值。`
    : `包内 ${pkg.embedded.source} 是未压缩脚本，manifest 副本与外层一致时无需处理。`;
}

/* ---------- 文件列表（分片渲染） ---------- */

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
  const all = S.pkg.entries;
  const entries = q ? all.filter(e => e.name.toLowerCase().includes(q)) : all;
  const showCount = () => { $('entryCount').textContent = q ? `${entries.length}/${all.length}` : `${entries.length} 项`; };

  const BATCH = 60;
  if (entries.length <= BATCH) {
    list.appendChild(fileFragment(entries, 0));
    showCount();
    return;
  }

  status.hidden = false;
  for (let i = 0; i < entries.length; i += BATCH) {
    if (token !== fileToken) return;
    list.appendChild(fileFragment(entries.slice(i, i + BATCH), i));
    status.textContent = `已显示 ${Math.min(i + BATCH, entries.length)} / ${entries.length}`;
    await yieldToUI();
  }
  if (token !== fileToken) return;
  status.hidden = true;
  showCount();
}

function fileFragment(entries) {
  const frag = document.createDocumentFragment();
  for (const e of entries) {
    const li = el('li', 'md-list-item');
    const name = el('span', 'md-list-item__name', e.name);
    if (e.isDir) name.style.opacity = '.55';
    li.append(name, el('span', 'md-list-item__meta', e.isDir ? '—' : fmtSize(e.usize)));
    if (!e.isDir) {
      const btn = el('button', 'md-btn md-btn--text', '取出');
      btn.type = 'button';
      btn.onclick = () => download(e.name.split('/').pop(), dataOf(e));
      li.appendChild(btn);
    }
    frag.appendChild(li);
  }
  return frag;
}

/* ---------- 图片网格（占位 + 懒加载） ---------- */

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
    }, { root: null, rootMargin: '300px 0px' })
  : null;

async function pumpHydration() {
  if (pumping) return;
  pumping = true;
  let n = 0;
  while (hydration.length) {
    const tile = hydration.shift();
    if (tile.isConnected) hydrateTile(tile);
    if (++n % 6 === 0) await yieldToUI();
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

function tileMeta(img) {
  const base = img.name.split('/').pop();
  if (S.dupes?.has(base)) {
    const dir = subLabel(img.name);
    return dir ? `${dir} · ${img.bytes ? fmtSize(img.bytes) : ''}`.replace(/ · $/, '') : fmtSize(img.bytes);
  }
  return fmtSize(img.bytes);
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
    el('div', 'md-tile__meta', tileMeta(img)));
  return tile;
}

function hydrateTile(tile) {
  const name = tile.dataset.name;
  const meta = S.pkg?.images.find(i => i.name === name);
  if (!meta) return;
  const full = makeTile(meta);
  full.style.animation = 'md-item-in .22s cubic-bezier(.2,0,0,1)';
  tile.replaceWith(full);
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

  const ops = el('div', 'md-tile__ops');
  const mk = (act, label) => {
    const b = el('button', 'md-btn md-btn--text', label);
    b.type = 'button';
    b.onclick = ev => {
      ev.stopPropagation();
      if (act === 'replace') pickForImage(img.name);
      else if (act === 'adjust') openEditor(img.name);
      else revertImage(img.name);
    };
    return b;
  };
  ops.append(mk('replace', '替换'), mk('adjust', '调整'));
  if (changed) ops.append(mk('revert', '还原'));
  tile.appendChild(ops);

  tile.onclick = () => openEditor(img.name);
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

  const BATCH = 30;
  for (let i = 0; i < list.length; i += BATCH) {
    if (token !== imgToken) return;
    const frag = document.createDocumentFragment();
    for (let k = i; k < Math.min(i + BATCH, list.length); k++) {
      const tile = skeletonTile(list[k], k);
      frag.appendChild(tile);
    }
    grid.appendChild(frag);
    const fresh = [...grid.querySelectorAll('.md-tile.is-skeleton')];
    for (const t of fresh) {
      if (io) io.observe(t); else hydration.push(t);
    }
    if (!io) pumpHydration();
    if (list.length > BATCH) {
      status.hidden = false;
      status.textContent = `已加载 ${Math.min(i + BATCH, list.length)} / ${list.length}`;
      await yieldToUI();
    }
  }
  if (token !== imgToken) return;
  status.hidden = true;
}

function updateTile(name) {
  const meta = S.pkg?.images.find(i => i.name === name);
  const old = $('imageGrid').querySelector(`.md-tile[data-name="${CSS.escape(name)}"]`);
  if (!meta) return;
  if (old) {
    const urls = S.urls.get(name);
    if (urls) { URL.revokeObjectURL(urls); S.urls.delete(name); }
    old.replaceWith(makeTile(meta));
  }
  if (name === iconName()) renderForm();
}

function renderDirty() {
  const m = S.pkg?.manifest;
  if (!m) {
    $('detailState').textContent = '载入包后可编辑';
    updateFab();
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
  updateFab();
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
    updateFab();
    return;
  }

  const id = S.identity;
  const fp = hexUpper(id.fingerprint).match(/../g).join(' ');
  name.textContent = id.cn || '未命名';
  chip.className = 'md-chip md-chip--ok';
  chip.textContent = '就绪';

  const rows = [
    ['算法', 'RSA-2048 / SHA-256'],
    ['有效期', `${id.notBefore.toISOString().slice(0, 10)} → ${id.notAfter.toISOString().slice(0, 10)}`],
    ['指纹', fp],
    ['来源', id.imported ? '导入的私钥' : '页面生成'],
  ];
  for (const [k, v] of rows) info.append(el('dt', null, k), el('dd', null, v));

  $('exportId').disabled = !id.pkcs8;
  $('copyFingerprint').disabled = false;
  updateFab();
}

function setTab(tab) {
  S.tab = tab;
  const files = tab === 'files';
  $('tabFiles').setAttribute('aria-selected', String(files));
  $('tabImages').setAttribute('aria-selected', String(!files));
  $('fileList').classList.toggle('hidden', !files);
  $('imageGrid').classList.toggle('hidden', files);
  $('exportImages').classList.toggle('hidden', files || !S.pkg);
  if (files) {
    $('gridStatus').hidden = true;
    renderFiles();
  } else {
    $('listStatus').hidden = true;
    $('entryCount').textContent = S.pkg ? `${S.pkg.images.length} 张` : '';
    renderImages();
  }
}

/* ---------- 图片编辑器 ---------- */

const Ed = { name: '', img: null, iw: 0, ih: 0, W: 0, H: 0, mode: 'fit', zoom: 1, dx: 0, dy: 0, drag: null, file: null };

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
  Ed.file = null;

  const img = new Image();
  img.onload = () => {
    Ed.img = img;
    Ed.iw = img.naturalWidth;
    Ed.ih = img.naturalHeight;
    if (!Ed.W || !Ed.H) { Ed.W = Ed.iw; Ed.H = Ed.ih; }
    $('dTitle').textContent = '调整图片';
    $('dSub').textContent = name;
    $('editor').showModal();
    setMode('fit');
  };
  img.onerror = () => snack('图片解码失败');
  img.src = url;
  setTimeout(() => URL.revokeObjectURL(url), 10000);
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
  for (const b of $('modes').children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  $('dHint').textContent = HINTS[mode];
  $('zoomRow').style.display = (mode === 'stretch' || mode === 'raw') ? 'none' : '';
  $('zoom').min = mode === 'fit' ? 10 : 100;
  $('zoom').max = mode === 'fit' ? 100 : 400;
  Ed.zoom = mode === 'fit' ? 1 : Math.max(1, Ed.zoom);
  $('zoom').value = Math.round(Ed.zoom * 100);
  $('zoomVal').textContent = `${Math.round(Ed.zoom * 100)}%`;
  Ed.dx = 0;
  Ed.dy = 0;
  draw();
}

function draw() {
  const cv = $('canvas');
  if (!Ed.img) return;
  const W = Ed.W, H = Ed.H;
  const raw = Ed.mode === 'raw';
  cv.width = raw ? Ed.iw : W;
  cv.height = raw ? Ed.ih : H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);

  if (raw) {
    ctx.drawImage(Ed.img, 0, 0);
  } else if (Ed.mode === 'stretch') {
    ctx.drawImage(Ed.img, 0, 0, W, H);
  } else {
    const base = Ed.mode === 'fit' ? Math.min(W / Ed.iw, H / Ed.ih) : Math.max(W / Ed.iw, H / Ed.ih);
    const s = base * Ed.zoom;
    const dw = Ed.iw * s, dh = Ed.ih * s;
    let dx = (W - dw) / 2 + Ed.dx;
    let dy = (H - dh) / 2 + Ed.dy;
    if (Ed.mode === 'cover') {
      dx = clamp(dx, W - dw, 0);
      dy = clamp(dy, H - dh, 0);
      Ed.dx = dx - (W - dw) / 2;
      Ed.dy = dy - (H - dh) / 2;
    }
    ctx.drawImage(Ed.img, dx, dy, dw, dh);
  }
  scaleCanvas();
  updateInfo(cv.width, cv.height);
}

function scaleCanvas() {
  const cv = $('canvas');
  const stage = $('stage');
  const aw = stage.clientWidth - 32, ah = stage.clientHeight - 32;
  if (!aw || !ah || !cv.width) return;
  const k = Math.min(aw / cv.width, ah / cv.height, 6);
  cv.style.width = `${Math.round(cv.width * k)}px`;
  cv.style.height = `${Math.round(cv.height * k)}px`;
  cv.style.imageRendering = k >= 3 ? 'pixelated' : 'auto';
}

function updateInfo(outW, outH) {
  const kv = $('dInfo');
  kv.textContent = '';
  for (const [k, v] of [['目标', `${Ed.W} × ${Ed.H}`], ['原图', `${Ed.iw} × ${Ed.ih}`], ['输出', `${outW} × ${outH}`]]) {
    kv.append(el('dt', null, k), el('dd', null, v));
  }
}

async function applyEditor() {
  if (!Ed.img) return;
  const btn = $('dApply');
  btn.disabled = true;
  await raf();
  try {
    let bytes;
    const cv = $('canvas');
    if (Ed.mode === 'raw' && Ed.file && Ed.file.type === 'image/png') {
      bytes = new Uint8Array(await Ed.file.arrayBuffer());
    } else {
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    const before = imageBytes(Ed.name)?.length || 0;
    S.images[Ed.name] = bytes;
    $('editor').close();
    updateTile(Ed.name);
    renderDirty();
    snack(`已应用 · ${fmtSize(before)} → ${fmtSize(bytes.length)}`);
  } catch (e) {
    snack(`处理失败：${e.message || e}`);
  } finally {
    btn.disabled = false;
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
    $('dTitle').textContent = '调整图片';
    $('dSub').textContent = `${Ed.name} · 新图 ${Ed.iw}×${Ed.ih}`;
    if (!$('editor').open) $('editor').showModal();
    setMode(Math.abs(Ed.ih / Ed.iw - Ed.W / Ed.H) < 0.02 ? 'fit' : 'cover');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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
    renderFiles();
    renderImages();
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
  const fab = $('fab');
  fab.classList.add('is-loading');
  fab.disabled = true;
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
      $('scrimText').textContent = '正在自检导出的包';
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
    fab.classList.remove('is-loading');
    renderDirty();
  }
}

/* ---------- 事件 ---------- */

buildNav();

$('drop').addEventListener('click', () => $('fileInput').click());
$('drop').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
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

$('tabFiles').addEventListener('click', () => setTab('files'));
$('tabImages').addEventListener('click', () => setTab('images'));

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (S.tab === 'files') renderFiles(); else renderImages();
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

$('fab').addEventListener('click', doExport);

/* 编辑器交互 */
(function bindEditor() {
  const stage = $('stage');
  const cv = $('canvas');

  stage.addEventListener('pointerdown', e => {
    if (Ed.mode !== 'cover' || !Ed.img) return;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
    Ed.drag = { x: e.clientX, y: e.clientY, dx: Ed.dx, dy: Ed.dy };
  });
  stage.addEventListener('pointermove', e => {
    if (!Ed.drag) return;
    const k = cv.width / cv.getBoundingClientRect().width;
    Ed.dx = Ed.drag.dx + (e.clientX - Ed.drag.x) * k;
    Ed.dy = Ed.drag.dy + (e.clientY - Ed.drag.y) * k;
    draw();
  });
  const end = e => {
    if (!Ed.drag) return;
    Ed.drag = null;
    stage.classList.remove('is-dragging');
    if (e && stage.hasPointerCapture?.(e.pointerId)) stage.releasePointerCapture(e.pointerId);
    draw();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  $('zoom').addEventListener('input', e => {
    Ed.zoom = Number(e.target.value) / 100;
    $('zoomVal').textContent = `${Math.round(Ed.zoom * 100)}%`;
    draw();
  });
  $('modes').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('dClose').onclick = () => $('editor').close();
  $('dCancel').onclick = () => $('editor').close();
  $('dApply').onclick = applyEditor;
  $('dPick').onclick = () => { S.pending = { name: Ed.name }; $('imageInput').click(); };
})();

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

function renderSettings() {
  let saved = 'auto';
  try { saved = localStorage.getItem(THEME_KEY) || 'auto'; } catch {}
  applyTheme(saved);
  $('optVerify').checked = S.optVerify;
  $('optWatch').checked = S.optWatch;
}

$('themeSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-theme-choice]');
  if (b) applyTheme(b.dataset.themeChoice);
});

/* 版本契约自检 */
(function checkContract() {
  const views = document.querySelectorAll('.md-view').length;
  if (views !== VIEWS.length) {
    reportMismatch();
  }
  if (!('showModal' in HTMLDialogElement.prototype)) {
    snack('浏览器版本偏旧，部分功能不可用');
  }
})();

/* 初始化 */
try { applyTheme(localStorage.getItem(THEME_KEY) || 'auto'); } catch { applyTheme('auto'); }
renderKV();
renderFiles();
renderForm();
renderIdentity();
renderSettings();
renderDirty();
