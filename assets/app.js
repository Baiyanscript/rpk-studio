import { inspect, repack, createIdentity, importPrivateKey, sha256 } from './rpk.js';
import { dataOf } from './zip.js';
import { zipSync } from '../vendor/fflate.js';

const $ = id => document.getElementById(id);

const S = {
  pkg: null,
  identity: null,
  images: {},        // name -> Uint8Array（改过的图）
  urls: new Map(),   // name -> objectURL
  tab: 'files',
  fileName: '',
  busy: false,
  pending: null,
};

/* ---------- 工具 ---------- */

const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const hexUpper = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function log(text, cls = '') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  $('log').appendChild(el);
  while ($('log').children.length > 14) $('log').firstChild.remove();
  $('log').scrollTop = $('log').scrollHeight;
}

const clearLog = () => { $('log').textContent = ''; };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function download(name, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const entryByName = name => S.pkg?.entries.find(e => e.name === name) || null;
const imageBytes = name => S.images[name] || (entryByName(name) ? dataOf(entryByName(name)) : null);
const iconName = () => (S.pkg?.manifest?.icon || '/common/icon.png').replace(/^\//, '');

/* ---------- 渲染 ---------- */

function setBadge(state, text) {
  const b = $('signBadge');
  b.className = `badge ${state}`;
  b.textContent = text;
}

function renderForm() {
  const m = S.pkg?.manifest;
  const on = Boolean(m);
  for (const id of ['fName', 'fPackage', 'fVersionName', 'fVersionCode']) $(id).disabled = !on;
  $('pickIcon').disabled = !on;
  $('exportBtn').disabled = !on || !S.identity || S.busy;
  $('exportJson').disabled = !on;
  if (!m) return;

  $('fName').value = m.name || '';
  $('fPackage').value = m.package || '';
  $('fVersionName').value = m.versionName || '';
  $('fVersionCode').value = m.versionCode ?? '';

  const icon = imageBytes(iconName()) || S.pkg.icon;
  const box = $('iconPreview');
  box.textContent = '';
  if (icon) {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([icon], { type: 'image/png' }));
    img.onload = () => { $('iconHint').textContent = `${img.naturalWidth} × ${img.naturalHeight} PNG`; };
    box.appendChild(img);
  } else {
    box.appendChild(el('span', null, '无'));
  }
}

function renderKV() {
  const kv = $('kv');
  kv.textContent = '';
  if (!S.pkg) {
    for (const k of ['包名', '应用名', '版本', '版本号', '页面', '文件', '体积', '平台版本']) {
      kv.appendChild(el('dt', null, k));
      kv.appendChild(el('dd', null, '—'));
    }
    return;
  }
  const { manifest, entries, bytes, sig } = S.pkg;
  const pages = manifest?.router?.pages ? Object.keys(manifest.router.pages).length : 0;
  const rows = [
    ['包名', manifest?.package || '—'],
    ['应用名', manifest?.name || '—'],
    ['版本', `${manifest?.versionName || '—'}`],
    ['版本号', String(manifest?.versionCode ?? '—')],
    ['页面', String(pages)],
    ['文件', String(entries.filter(e => !e.isDir).length)],
    ['体积', fmtSize(bytes.length)],
    ['平台版本', String(manifest?.minPlatformVersion ?? '—')],
  ];
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', null, k));
    kv.appendChild(el('dd', null, v));
  }
  kv.appendChild(el('dt', null, '签名'));
  kv.appendChild(el('dd', null, sig.present ? `RSA-${sig.signature.length * 8}` : '无'));
  kv.appendChild(el('dt', null, '摘要'));
  kv.appendChild(el('dd', null, sig.present ? 'SHA-256' : '—'));
}

function renderVerify() {
  const box = $('verify');
  const pkg = S.pkg;
  if (!pkg || !pkg.sig?.present) {
    box.classList.add('hidden');
    setBadge('idle', pkg ? '未签名' : '等待文件');
    return;
  }
  const v = pkg.verify;
  box.classList.remove('hidden');
  box.textContent = '';

  const line = (label, ok, right) => {
    const row = el('div', 'verify-line');
    row.appendChild(el('span', `pill ${ok ? 'ok' : 'bad'}`));
    row.appendChild(el('span', null, label));
    row.appendChild(el('b', null, right));
    box.appendChild(row);
  };
  line('分段摘要', v.digestOk, v.digestOk ? '一致' : '不一致');
  line('RSA 签名', v.rsaOk, v.rsaOk ? '有效' : '无效');
  line('文件摘要', v.badFiles === 0, `${v.fileCount - v.badFiles} / ${v.fileCount}`);

  const cert = v.cert;
  const date = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—';
  const row = el('div', 'verify-line');
  row.appendChild(el('span', `pill ${v.rsaOk && v.digestOk ? 'ok' : 'warn'}`));
  row.appendChild(el('span', null, cert.cn || '证书'));
  row.appendChild(el('b', null, date(cert.notAfter)));
  box.appendChild(row);

  const allOk = v.digestOk && v.rsaOk && v.badFiles === 0;
  setBadge(allOk ? 'ok' : 'bad', allOk ? '签名有效' : '校验失败');
}

function renderEmbed() {
  const box = $('embedNotice');
  const pkg = S.pkg;
  if (!pkg?.embedded) { box.classList.add('hidden'); return; }

  const m = pkg.manifest;
  const text = pkg.embedded.text;
  const mCode = String(m?.versionCode ?? '');
  const embedCode = (text.match(/"versionCode":(\d+)/) || [])[1] || '';
  const embedPkg = (text.match(/"package":"([^"]*)"/) || [])[1] || '';

  box.classList.remove('hidden');
  box.textContent = '';
  if (pkg.embedded.jsc) {
    box.appendChild(el('div', null,
      `包内 ${pkg.embedded.source} 是 JSC 字节码，其中另存了一份编译时的 manifest。改包名或版本只改外层 manifest.json，握手指令仍会读字节码里的旧值。`));
    if (embedCode && mCode && embedCode !== mCode) {
      box.appendChild(el('div', null, `当前：外层 ${mCode}，字节码 ${embedCode}（${embedPkg}）`));
    }
  } else {
    box.appendChild(el('div', null,
      `包内 ${pkg.embedded.source} 是未压缩脚本，可以直接改源码重新打包；这里的 manifest 副本与外层一致时无需处理。`));
  }
}

function renderFiles() {
  const list = $('fileList');
  const q = ($('fileSearch').value || '').trim().toLowerCase();
  list.textContent = '';
  if (!S.pkg) {
    list.classList.add('is-empty');
    list.appendChild(el('div', 'list-empty', '—'));
    $('entryCount').textContent = '—';
    return;
  }
  list.classList.remove('is-empty');
  const entries = S.pkg.entries.filter(e => !q || e.name.toLowerCase().includes(q));
  $('entryCount').textContent = q ? `${entries.length} / ${S.pkg.entries.length} 项` : `${entries.length} 项`;

  const frag = document.createDocumentFragment();
  for (const e of entries) {
    const row = el('div', 'entry');
    row.appendChild(el('span', `entry-name${e.isDir ? ' entry-dim' : ''}`, e.name));
    row.appendChild(el('span', 'entry-size', e.isDir ? '—' : fmtSize(dataOf(e).length)));
    if (!e.isDir) {
      const btn = el('button', null, '取出');
      btn.type = 'button';
      btn.onclick = () => download(e.name.split('/').pop(), dataOf(e));
      row.appendChild(btn);
    } else {
      row.appendChild(el('span', 'entry-size', ''));
    }
    frag.appendChild(row);
  }
  list.appendChild(frag);
}

function makeThumb(img) {
  const changed = Boolean(S.images[img.name]);
  const bytes = imageBytes(img.name);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  S.urls.set(img.name, url);

  const box = el('article', `thumb${changed ? ' is-changed' : ''}`);
  box.dataset.name = img.name;

  const frame = el('div', 'thumb-img');
  const im = new Image();
  im.src = url;
  im.alt = '';
  im.loading = 'lazy';
  frame.appendChild(im);

  box.append(frame,
    el('div', 'thumb-name', img.name.split('/').pop()),
    el('div', 'thumb-meta', img.w ? `${img.w}×${img.h}` : fmtSize(img.bytes)));

  if (changed) box.appendChild(el('span', 'thumb-dot'));

  const ops = el('div', 'thumb-ops');
  const mk = (act, label) => {
    const b = el('button', null, label);
    b.type = 'button';
    b.dataset.act = act;
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
  box.appendChild(ops);

  box.onclick = () => openEditor(img.name);
  return box;
}

function renderImages() {
  const grid = $('imageGrid');
  const pkg = S.pkg;
  const q = ($('fileSearch').value || '').trim().toLowerCase();
  grid.textContent = '';
  $('imgCount').textContent = pkg ? String(pkg.images.length) : '';

  if (!pkg || !pkg.images.length) {
    grid.classList.add('is-empty');
    grid.appendChild(el('div', 'list-empty', pkg ? '包内没有图片资源' : '—'));
    return;
  }
  grid.classList.remove('is-empty');

  const list = q ? pkg.images.filter(i => i.name.toLowerCase().includes(q)) : pkg.images;
  if (!list.length) {
    grid.appendChild(el('div', 'list-empty', '没有匹配的图片'));
    return;
  }

  for (const url of S.urls.values()) URL.revokeObjectURL(url);
  S.urls.clear();

  const frag = document.createDocumentFragment();
  for (const img of list) frag.appendChild(makeThumb(img));
  grid.appendChild(frag);
}

function updateThumb(name) {
  const grid = $('imageGrid');
  const meta = S.pkg.images.find(i => i.name === name);
  if (!meta) return;
  const old = grid.querySelector(`.thumb[data-name="${CSS.escape(name)}"]`);
  if (!old) { renderImages(); return; }
  const url = S.urls.get(name);
  if (url) URL.revokeObjectURL(url);
  const fresh = makeThumb(meta);
  old.replaceWith(fresh);
  if (meta.name === iconName()) renderForm();
}

function renderDirty() {
  const m = S.pkg?.manifest;
  if (!m) { $('editState').textContent = '未载入'; return; }
  const n = Object.keys(S.images).length;
  const diff =
    $('fName').value !== (m.name || '') ||
    $('fPackage').value !== (m.package || '') ||
    $('fVersionName').value !== (m.versionName || '') ||
    Number($('fVersionCode').value) !== Number(m.versionCode) ||
    n > 0;
  $('editState').textContent = diff ? (n ? `已修改 · ${n} 张图` : '已修改') : '未修改';
  $('exportBtn').disabled = !S.identity || !S.pkg || S.busy;
}

function renderIdentity() {
  const box = $('idDetail');
  if (!S.identity) {
    $('idState').textContent = '未设置';
    box.textContent = '生成一对 RSA-2048 密钥并自签证书，或用 openssl 生成的 private.pem。导出前必须设置。';
    $('exportBtn').disabled = true;
    return;
  }
  const id = S.identity;
  $('idState').textContent = '就绪';
  const fp = hexUpper(id.fingerprint.subarray(0, 8)).match(/../g).join(' ');
  const date = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  box.textContent = `${id.cn || '未命名'} · RSA-2048 · 有效期至 ${date(id.notAfter)} · 指纹 ${fp}`;
  $('exportBtn').disabled = !S.pkg;
}

function setTab(tab) {
  S.tab = tab;
  const files = tab === 'files';
  $('tabFiles').classList.toggle('is-on', files);
  $('tabImages').classList.toggle('is-on', !files);
  $('tabFiles').setAttribute('aria-selected', String(files));
  $('tabImages').setAttribute('aria-selected', String(!files));
  $('fileList').classList.toggle('hidden', !files);
  $('imageGrid').classList.toggle('hidden', files);
  $('exportImages').classList.toggle('hidden', files || !S.pkg);
  $('fileSearch').placeholder = files ? '筛选路径' : '筛选图片';
  if (files) {
    renderFiles();
  } else {
    $('entryCount').textContent = '';
    renderImages();
  }
}

/* ---------- 图片编辑器 ---------- */

const Ed = {
  name: '', img: null, iw: 0, ih: 0, W: 0, H: 0,
  mode: 'fit', zoom: 1, dx: 0, dy: 0, drag: null, file: null,
};

const HINTS = {
  fit: '整张图缩放到目标尺寸内，四周补透明。',
  cover: '等比放大铺满目标尺寸，拖动选位置。',
  stretch: '直接拉伸到目标尺寸，比例会变形。',
  raw: '保留原始像素，不缩放不裁剪；尺寸与目标不同时由设备拉伸。',
};

function openEditor(name) {
  const meta = S.pkg?.images.find(i => i.name === name);
  if (!meta) return;
  const bytes = imageBytes(name);
  const blob = new Blob([bytes], { type: 'image/png' });
  const url = URL.createObjectURL(blob);

  Ed.name = name;
  Ed.W = meta.w || 0;
  Ed.H = meta.h || 0;
  Ed.file = null;
  Ed.mode = 'fit';
  Ed.zoom = 1;

  const img = new Image();
  img.onload = () => {
    Ed.img = img;
    Ed.iw = img.naturalWidth;
    Ed.ih = img.naturalHeight;
    if (!Ed.W) { Ed.W = Ed.iw; Ed.H = Ed.ih; }
    $('mSub').textContent = name;
    $('mTitle').textContent = '调整图片';
    setMode('fit');
    $('modal').hidden = false;
    document.body.style.overflow = 'hidden';
    $('mClose').focus();
  };
  img.onerror = () => log('图片解码失败', 'err');
  img.src = url;
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function pickForImage(name) {
  S.pending = { type: 'image', name };
  $('imageInput').click();
}

function revertImage(name) {
  if (!S.images[name]) return;
  delete S.images[name];
  log(`已还原 ${name}`);
  updateThumb(name);
  renderDirty();
}

function setMode(mode) {
  Ed.mode = mode;
  for (const b of $('mModes').children) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('mHint').textContent = HINTS[mode];
  $('mZoomRow').style.display = (mode === 'stretch' || mode === 'raw') ? 'none' : '';
  $('mTip').textContent = mode === 'cover' ? '按住拖动可调整位置' : (mode === 'raw' ? '保持原始像素' : '');
  $('mZoom').min = mode === 'fit' ? 10 : 100;
  $('mZoom').max = mode === 'fit' ? 100 : 400;
  Ed.zoom = mode === 'fit' ? 1 : Math.max(1, Ed.zoom);
  $('mZoom').value = Math.round(Ed.zoom * 100);
  $('mZoomVal').textContent = `${Math.round(Ed.zoom * 100)}%`;
  Ed.dx = 0;
  Ed.dy = 0;
  draw();
}

function draw() {
  const cv = $('mCanvas');
  if (!Ed.img) return;
  const W = Ed.W, H = Ed.H;
  const raw = Ed.mode === 'raw';
  cv.width = raw ? Ed.iw : W;
  cv.height = raw ? Ed.ih : H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);

  if (raw) {
    ctx.drawImage(Ed.img, 0, 0);
    updateInfo(cv.width, cv.height, Ed.iw, Ed.ih);
    scaleCanvas();
    return;
  }

  if (Ed.mode === 'stretch') {
    ctx.drawImage(Ed.img, 0, 0, W, H);
    updateInfo(W, H, Ed.iw, Ed.ih);
    scaleCanvas();
    return;
  }

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
  updateInfo(W, H, Ed.iw, Ed.ih);
  scaleCanvas();
}

function scaleCanvas() {
  const cv = $('mCanvas');
  const stage = $('mStage');
  const availW = stage.clientWidth - 32;
  const availH = stage.clientHeight - 32;
  if (!availW || !availH || !cv.width) return;
  const k = Math.min(availW / cv.width, availH / cv.height, 6);
  cv.style.width = `${Math.round(cv.width * k)}px`;
  cv.style.height = `${Math.round(cv.height * k)}px`;
  cv.style.imageRendering = k >= 3 ? 'pixelated' : 'auto';
}

function updateInfo(outW, outH, srcW, srcH) {
  const kv = $('mInfo');
  kv.textContent = '';
  const rows = [
    ['目标', `${Ed.W} × ${Ed.H}`],
    ['原图', `${srcW} × ${srcH}`],
    ['输出', `${outW} × ${outH}`],
  ];
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', null, k));
    kv.appendChild(el('dd', null, v));
  }
}

async function applyEditor() {
  if (!Ed.img) return;
  const btn = $('mApply');
  btn.classList.add('is-loading');
  btn.disabled = true;
  await new Promise(r => setTimeout(r, 16));

  try {
    let bytes;
    const cv = $('mCanvas');
    if (Ed.mode === 'raw' && Ed.file && Ed.file.type === 'image/png') {
      bytes = new Uint8Array(await Ed.file.arrayBuffer());
    } else {
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    const before = imageBytes(Ed.name)?.length || 0;
    S.images[Ed.name] = bytes;
    log(`应用 ${Ed.name} · ${Ed.mode} · ${cv.width}×${cv.height} · ${fmtSize(before)} → ${fmtSize(bytes.length)}`, 'done');
    closeEditor();
    updateThumb(Ed.name);
    renderDirty();
  } catch (e) {
    log(`处理失败：${e.message || e}`, 'err');
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

function closeEditor() {
  $('modal').hidden = true;
  document.body.style.overflow = '';
  Ed.img = null;
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
    $('mTitle').textContent = '调整图片';
    $('mSub').textContent = `${Ed.name} · 新图 ${Ed.iw}×${Ed.ih}`;
    $('modal').hidden = false;
    document.body.style.overflow = 'hidden';
    const ratio = Ed.ih / Ed.iw;
    const target = Ed.W / Ed.H;
    setMode(Math.abs(ratio - target) < 0.02 ? 'fit' : 'cover');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  img.onerror = () => { log('无法解码这张图片', 'err'); URL.revokeObjectURL(url); };
  img.src = url;
}

/* 拖动 / 缩放 */
(function bindStage() {
  const stage = $('mStage');
  const cv = $('mCanvas');

  const pos = e => ({ x: e.clientX, y: e.clientY });

  stage.addEventListener('pointerdown', e => {
    if (Ed.mode !== 'cover' || !Ed.img) return;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('is-dragging');
    Ed.drag = { ...pos(e), dx: Ed.dx, dy: Ed.dy };
  });

  stage.addEventListener('pointermove', e => {
    if (!Ed.drag) return;
    const p = pos(e);
    const scale = cv.width / cv.getBoundingClientRect().width;
    Ed.dx = Ed.drag.dx + (p.x - Ed.drag.x) * scale;
    Ed.dy = Ed.drag.dy + (p.y - Ed.drag.y) * scale;
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

  stage.addEventListener('wheel', e => {
    if (Ed.mode !== 'cover' && Ed.mode !== 'fit') return;
    e.preventDefault();
    $('mZoom').value = clamp(Number($('mZoom').value) - Math.sign(e.deltaY) * 5, Number($('mZoom').min), Number($('mZoom').max));
    $('mZoom').dispatchEvent(new Event('input'));
  }, { passive: false });

  $('mZoom').addEventListener('input', e => {
    Ed.zoom = Number(e.target.value) / 100;
    $('mZoomVal').textContent = `${Math.round(Ed.zoom * 100)}%`;
    draw();
  });

  $('mModes').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  $('mClose').onclick = closeEditor;
  $('mCancel').onclick = closeEditor;
  $('mApply').onclick = applyEditor;

  $('mPick').onclick = () => {
    S.pending = { type: 'image', name: Ed.name, fromEditor: true };
    $('imageInput').click();
  };

  $('modal').addEventListener('click', e => {
    if (e.target === $('modal')) closeEditor();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('modal').hidden) closeEditor();
  });
})();

/* ---------- 读文件 ---------- */

async function loadFile(file) {
  if (S.busy) return;
  clearLog();
  S.busy = true;
  $('srcState').textContent = '读取中';
  log(`读取 ${file.name} · ${fmtSize(file.size)}`);

  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const t0 = performance.now();
    const pkg = await inspect(buf);
    S.pkg = pkg;
    S.fileName = file.name;
    S.images = {};
    for (const url of S.urls.values()) URL.revokeObjectURL(url);
    S.urls.clear();

    $('drop').classList.add('hidden');
    $('fileRow').classList.remove('hidden');
    $('fileName').textContent = file.name;
    $('fileMeta').textContent = `${fmtSize(file.size)} · ${pkg.entries.length} 项 · ${pkg.manifest?.package || '未知包名'}`;
    $('srcState').textContent = '已载入';
    $('fileSearch').disabled = false;
    $('fileSearch').value = '';

    renderForm();
    renderKV();
    renderVerify();
    renderEmbed();
    setTab('files');
    renderDirty();

    const v = pkg.verify;
    log(`解析完成 ${Math.round(performance.now() - t0)} ms`, 'done');
    if (v) log(`签名 ${v.digestOk && v.rsaOk && v.badFiles === 0 ? '校验通过' : '校验未通过'} · ${v.fileCount} 个文件摘要`);
    if (pkg.images.length) log(`图片资源 ${pkg.images.length} 张`);
    if (pkg.embedded?.jsc) log('检测到 JSC 字节码内嵌 manifest');
  } catch (err) {
    $('srcState').textContent = '读取失败';
    setBadge('bad', '无法解析');
    log(String(err.message || err), 'err');
  } finally {
    S.busy = false;
    renderDirty();
  }
}

/* ---------- 导出 ---------- */

function collectPatch() {
  const m = { ...S.pkg.manifest };
  m.name = $('fName').value.trim();
  m.package = $('fPackage').value.trim();
  m.versionName = $('fVersionName').value.trim();
  m.versionCode = Number($('fVersionCode').value);

  const watch = S.pkg.watch
    ? { ...S.pkg.watch, name: m.name, package: m.package, versionName: m.versionName, versionCode: m.versionCode }
    : null;

  const changed = (x, y) => JSON.stringify(x) !== JSON.stringify(y);
  return {
    manifestText: changed(S.pkg.manifest, m) ? JSON.stringify(m, null, 2) + '\n' : null,
    watchText: watch && changed(S.pkg.watch, watch) ? JSON.stringify(watch, null, 2) + '\n' : null,
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
  if (err) { log(err, 'err'); return; }

  S.busy = true;
  const btn = $('exportBtn');
  btn.classList.add('is-loading');
  btn.disabled = true;
  const t0 = performance.now();
  const before = S.pkg.bytes.length;

  try {
    log(`重算摘要并签名 · ${patch.manifest.package}`);
    const out = await repack(S.pkg, patch, S.identity);
    const name = `${patch.manifest.package}.release.${patch.manifest.versionName}.rpk`;
    download(name, out);

    const delta = out.length - before;
    const sign = delta === 0 ? '±0' : `${delta > 0 ? '+' : '-'}${fmtSize(Math.abs(delta))}`;
    const check = await inspect(out);
    const ok = check.verify.digestOk && check.verify.rsaOk && check.verify.badFiles === 0;
    log(`导出 ${name} · ${fmtSize(out.length)}（${sign}）· ${ok ? '签名自检通过' : '签名自检失败'}`, ok ? 'done' : 'err');
    log(`用时 ${Math.round(performance.now() - t0)} ms`);
    if (check.embedded?.jsc) {
      const code = (check.embedded.text.match(/"versionCode":(\d+)/) || [])[1];
      if (code && code !== String(patch.manifest.versionCode)) log(`注意：app.jsc 内版本号仍为 ${code}`, 'err');
    }
  } catch (e) {
    log(`导出失败：${e.message || e}`, 'err');
  } finally {
    S.busy = false;
    btn.classList.remove('is-loading');
    renderDirty();
    renderForm();
  }
}

/* ---------- 事件 ---------- */

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

$('tabFiles').addEventListener('click', () => setTab('files'));
$('tabImages').addEventListener('click', () => setTab('images'));
$('fileSearch').addEventListener('input', () => {
  if (S.tab === 'files') renderFiles(); else renderImages();
});

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
  if (!Ed.W) { log('该文件没有可识别的尺寸，按原样写入', 'err'); }
  await loadIntoEditor(f);
});

$('exportImages').addEventListener('click', () => {
  if (!S.pkg) return;
  const files = {};
  for (const img of S.pkg.images) files[img.name] = imageBytes(img.name);
  const zipped = zipSync(files, { level: 6 });
  download(`${S.pkg.manifest?.package || 'rpk'}-images.zip`, zipped);
  log(`导出 ${S.pkg.images.length} 张图片 · ${fmtSize(zipped.length)}`);
});

$('genId').addEventListener('click', async () => {
  const cn = $('cnInput').value.trim() || 'Vela App';
  const btn = $('genId');
  btn.disabled = true;
  btn.classList.add('is-loading');
  $('idState').textContent = '生成中';
  try {
    const id = await createIdentity(cn, 3650);
    const fingerprint = new Uint8Array(await sha256(id.certDer));
    S.identity = { ...id, fingerprint };
    renderIdentity();
    log(`已生成自签证书：${cn}`, 'done');
  } catch (e) {
    log(`生成失败：${e.message || e}`, 'err');
    $('idState').textContent = '未设置';
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
});

$('loadKey').addEventListener('click', () => $('keyInput').click());

$('keyInput').addEventListener('change', async e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const pem = await f.text();
    const { key, pubDer } = await importPrivateKey(pem);
    const cn = $('cnInput').value.trim() || 'Imported Key';
    const cert = await createIdentity(cn, 3650, { key, pubDer });
    const fingerprint = new Uint8Array(await sha256(cert.certDer));
    S.identity = { ...cert, cn, fingerprint, imported: true };
    renderIdentity();
    log(`已载入私钥，并用它自签了证书：${cn}`, 'done');
  } catch (err) {
    log(`私钥载入失败：${err.message || err}`, 'err');
  }
});

$('exportBtn').addEventListener('click', doExport);

$('exportJson').addEventListener('click', () => {
  if (!S.pkg) return;
  const { manifest, watch, entries, bytes, sig, verify, images } = S.pkg;
  const info = {
    file: S.fileName,
    size: bytes.length,
    manifest,
    manifestWatch: watch,
    signature: sig.present ? {
      algorithm: `RSA-${sig.signature.length * 8}`,
      digest: 'SHA-256',
      certSubject: verify?.cert?.cn || '',
      certNotAfter: verify?.cert?.notAfter?.toISOString() || '',
      fileDigests: verify?.fileCount ?? 0,
      valid: Boolean(verify?.digestOk && verify?.rsaOk && verify?.badFiles === 0),
    } : null,
    entries: entries.map(e => ({ name: e.name, size: e.isDir ? 0 : dataOf(e).length })),
    images,
    modifiedImages: Object.keys(S.images),
  };
  download('rpk-info.json', new TextEncoder().encode(JSON.stringify(info, null, 2)));
});

renderKV();
renderFiles();
renderImages();
setTab('files');
renderDirty();
renderIdentity();
