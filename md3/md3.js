import { inspect, repack, createIdentity, importPrivateKey, sha256 } from '../assets/rpk.js';
import { dataOf } from '../assets/zip.js';
import { zipSync } from '../vendor/fflate.js';

const $ = id => document.getElementById(id);

const S = {
  pkg: null,
  identity: null,
  images: {},
  urls: new Map(),
  tab: 'files',
  fileName: '',
  busy: false,
  pending: null,
};

const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const hexUpper = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let snackTimer = null;
function snack(text) {
  const bar = $('m3-snackbar');
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

/* ---------- 渲染 ---------- */

function setChip(state, text) {
  const c = $('m3-badge');
  c.className = `md-chip${state ? ' md-chip--' + state : ''}`;
  c.textContent = text;
}

function renderForm() {
  const m = S.pkg?.manifest;
  const on = Boolean(m);
  for (const id of ['m3-fName', 'm3-fPackage', 'm3-fVersionName', 'm3-fVersionCode']) $(id).disabled = !on;
  $('m3-pickIcon').disabled = !on;
  $('m3-exportBtn').disabled = !on || !S.identity || S.busy;
  $('m3-exportJson').disabled = !on;
  if (!m) return;

  $('m3-fName').value = m.name || '';
  $('m3-fPackage').value = m.package || '';
  $('m3-fVersionName').value = m.versionName || '';
  $('m3-fVersionCode').value = m.versionCode ?? '';

  const icon = imageBytes(iconName()) || S.pkg.icon;
  const box = $('m3-iconPreview');
  box.textContent = '';
  if (icon) {
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([icon], { type: 'image/png' }));
    img.onload = () => { $('m3-iconHint').textContent = `${img.naturalWidth} × ${img.naturalHeight} PNG`; };
    box.appendChild(img);
  }
}

function renderKV() {
  const kv = $('m3-kv');
  kv.textContent = '';
  if (!S.pkg) {
    for (const k of ['包名', '应用名', '版本', '版本号', '页面', '文件', '体积', '平台版本']) {
      kv.appendChild(el('dt', null, k));
      kv.appendChild(el('dd', null, '—'));
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
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', null, k));
    kv.appendChild(el('dd', null, v));
  }
  kv.appendChild(el('dt', null, '签名'));
  kv.appendChild(el('dd', null, sig.present ? `RSA-${sig.signature.length * 8}` : '无'));
}

function renderVerify() {
  const box = $('m3-verify');
  const pkg = S.pkg;
  if (!pkg || !pkg.sig?.present) {
    box.classList.add('hidden');
    setChip('', pkg ? '未签名' : '等待文件');
    return;
  }
  const v = pkg.verify;
  box.classList.remove('hidden');
  box.textContent = '';

  const line = (ok, label, right) => {
    const row = el('div', 'md-row');
    row.style.cssText = 'justify-content:space-between;padding:4px 0';
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
  const box = $('m3-notice');
  const pkg = S.pkg;
  if (!pkg?.embedded) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.className = 'md-notice md-card';
  box.style.cssText = 'margin-top:12px;padding:12px 14px;background:var(--md-sys-color-tertiary-container);color:var(--md-sys-color-on-tertiary-container);border-radius:12px';
  box.textContent = '';
  box.appendChild(el('div', 'md-body-small', pkg.embedded.jsc
    ? `包内 ${pkg.embedded.source} 是 JSC 字节码，其中另存了一份编译时的 manifest。改包名或版本只改外层 manifest.json，握手指令仍会读字节码里的旧值。`
    : `包内 ${pkg.embedded.source} 是未压缩脚本，manifest 副本与外层一致时无需处理。`));
}

function renderFiles() {
  const list = $('m3-fileList');
  const q = ($('m3-search').value || '').trim().toLowerCase();
  list.textContent = '';
  if (!S.pkg) {
    list.appendChild(el('li', 'md-list-item md-muted', '选择一个 RPK 文件后显示'));
    return;
  }
  const entries = S.pkg.entries.filter(e => !q || e.name.toLowerCase().includes(q));
  for (const e of entries) {
    const li = el('li', 'md-list-item');
    const name = el('span', 'md-list-item__name', e.name);
    if (e.isDir) name.style.opacity = '.55';
    li.append(name, el('span', 'md-list-item__meta', e.isDir ? '—' : fmtSize(dataOf(e).length)));
    if (!e.isDir) {
      const btn = el('button', 'md-btn md-btn--text', '取出');
      btn.type = 'button';
      btn.onclick = () => download(e.name.split('/').pop(), dataOf(e));
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

function makeTile(img) {
  const changed = Boolean(S.images[img.name]);
  const bytes = imageBytes(img.name);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  S.urls.set(img.name, url);

  const tile = el('div', `md-tile${changed ? ' is-changed' : ''}`);
  tile.dataset.name = img.name;

  const frame = el('div', 'md-tile__img');
  const im = new Image();
  im.src = url;
  im.loading = 'lazy';
  im.alt = '';
  frame.appendChild(im);

  tile.append(frame,
    el('div', 'md-tile__name', img.name.split('/').pop()),
    el('div', 'md-tile__meta', img.w ? `${img.w}×${img.h}` : fmtSize(img.bytes)));

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

function renderImages() {
  const grid = $('m3-imageGrid');
  const pkg = S.pkg;
  const q = ($('m3-search').value || '').trim().toLowerCase();
  grid.textContent = '';
  $('m3-imgCount').textContent = pkg ? String(pkg.images.length) : '0';

  if (!pkg || !pkg.images.length) {
    grid.appendChild(el('div', 'md-body-small md-muted', pkg ? '包内没有图片资源' : '—'));
    return;
  }
  for (const url of S.urls.values()) URL.revokeObjectURL(url);
  S.urls.clear();

  const list = q ? pkg.images.filter(i => i.name.toLowerCase().includes(q)) : pkg.images;
  for (const img of list) grid.appendChild(makeTile(img));
}

function updateTile(name) {
  const meta = S.pkg.images.find(i => i.name === name);
  const old = $('m3-imageGrid').querySelector(`.md-tile[data-name="${CSS.escape(name)}"]`);
  if (!meta || !old) { renderImages(); return; }
  const url = S.urls.get(name);
  if (url) URL.revokeObjectURL(url);
  old.replaceWith(makeTile(meta));
  if (name === iconName()) renderForm();
}

function renderDirty() {
  const m = S.pkg?.manifest;
  if (!m) { $('m3-editState').textContent = '未载入'; return; }
  const n = Object.keys(S.images).length;
  const diff =
    $('m3-fName').value !== (m.name || '') ||
    $('m3-fPackage').value !== (m.package || '') ||
    $('m3-fVersionName').value !== (m.versionName || '') ||
    Number($('m3-fVersionCode').value) !== Number(m.versionCode) ||
    n > 0;
  $('m3-editState').textContent = diff ? (n ? `已修改 · ${n} 张图` : '已修改') : '未修改';
  $('m3-exportBtn').disabled = !S.identity || !S.pkg || S.busy;
}

function renderIdentity() {
  if (!S.identity) {
    $('m3-idState').textContent = '未设置';
    $('m3-idDetail').textContent = '生成一对 RSA-2048 密钥并自签证书，或用 openssl 生成的 private.pem。导出前必须设置。';
    $('m3-exportBtn').disabled = true;
    return;
  }
  const id = S.identity;
  $('m3-idState').textContent = '就绪';
  const fp = hexUpper(id.fingerprint.subarray(0, 8)).match(/../g).join(' ');
  $('m3-idDetail').textContent = `${id.cn} · RSA-2048 · 有效期至 ${id.notAfter.toISOString().slice(0, 10)} · 指纹 ${fp}`;
  $('m3-exportBtn').disabled = !S.pkg;
}

function setTab(tab) {
  S.tab = tab;
  const files = tab === 'files';
  $('m3-tabFiles').setAttribute('aria-selected', String(files));
  $('m3-tabImages').setAttribute('aria-selected', String(!files));
  $('m3-fileList').classList.toggle('hidden', !files);
  $('m3-imageGrid').classList.toggle('hidden', files);
  $('m3-exportImages').classList.toggle('hidden', files || !S.pkg);
  if (files) renderFiles(); else renderImages();
}

/* ---------- 编辑器 ---------- */

const Ed = { name: '', img: null, iw: 0, ih: 0, W: 0, H: 0, mode: 'fit', zoom: 1, dx: 0, dy: 0, drag: null, file: null };

const HINTS = {
  fit: '整张图缩放到目标尺寸内，四周补透明。',
  cover: '等比放大铺满目标尺寸，拖动选位置。',
  stretch: '直接拉伸到目标尺寸，比例会变形。',
  raw: '保留原始像素，不缩放不裁剪。',
};

function openEditor(name) {
  const meta = S.pkg?.images.find(i => i.name === name);
  if (!meta) return;
  const url = URL.createObjectURL(new Blob([imageBytes(name)], { type: 'image/png' }));
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
    $('m3-dTitle').textContent = '调整图片';
    $('m3-dSub').textContent = name;
    $('m3-dialog').showModal();
    setMode('fit');
    $('m3-dClose').focus();
  };
  img.onerror = () => snack('图片解码失败');
  img.src = url;
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function pickForImage(name) {
  S.pending = { name };
  $('m3-imageInput').click();
}

function revertImage(name) {
  if (!S.images[name]) return;
  delete S.images[name];
  snack(`已还原 ${name}`);
  updateTile(name);
  renderDirty();
}

function setMode(mode) {
  Ed.mode = mode;
  for (const b of $('m3-modes').children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  $('m3-dHint').textContent = HINTS[mode];
  $('m3-zoomRow').style.display = (mode === 'stretch' || mode === 'raw') ? 'none' : '';
  $('m3-zoom').min = mode === 'fit' ? 10 : 100;
  $('m3-zoom').max = mode === 'fit' ? 100 : 400;
  Ed.zoom = mode === 'fit' ? 1 : Math.max(1, Ed.zoom);
  $('m3-zoom').value = Math.round(Ed.zoom * 100);
  $('m3-zoomVal').textContent = `${Math.round(Ed.zoom * 100)}%`;
  Ed.dx = 0;
  Ed.dy = 0;
  draw();
}

function draw() {
  const cv = $('m3-canvas');
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
  const cv = $('m3-canvas');
  const stage = $('m3-stage');
  const aw = stage.clientWidth - 32, ah = stage.clientHeight - 32;
  if (!aw || !ah || !cv.width) return;
  const k = Math.min(aw / cv.width, ah / cv.height, 6);
  cv.style.width = `${Math.round(cv.width * k)}px`;
  cv.style.height = `${Math.round(cv.height * k)}px`;
  cv.style.imageRendering = k >= 3 ? 'pixelated' : 'auto';
}

function updateInfo(outW, outH) {
  const kv = $('m3-dInfo');
  kv.textContent = '';
  const rows = [['目标', `${Ed.W} × ${Ed.H}`], ['原图', `${Ed.iw} × ${Ed.ih}`], ['输出', `${outW} × ${outH}`]];
  for (const [k, v] of rows) {
    kv.appendChild(el('dt', null, k));
    kv.appendChild(el('dd', null, v));
  }
}

async function applyEditor() {
  if (!Ed.img) return;
  const btn = $('m3-dApply');
  btn.disabled = true;
  await new Promise(r => setTimeout(r, 16));
  try {
    let bytes;
    const cv = $('m3-canvas');
    if (Ed.mode === 'raw' && Ed.file && Ed.file.type === 'image/png') {
      bytes = new Uint8Array(await Ed.file.arrayBuffer());
    } else {
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      bytes = new Uint8Array(await blob.arrayBuffer());
    }
    const before = imageBytes(Ed.name)?.length || 0;
    S.images[Ed.name] = bytes;
    $('m3-dialog').close();
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
    $('m3-dTitle').textContent = '调整图片';
    $('m3-dSub').textContent = `${Ed.name} · 新图 ${Ed.iw}×${Ed.ih}`;
    if (!$('m3-dialog').open) $('m3-dialog').showModal();
    const same = Math.abs(Ed.ih / Ed.iw - Ed.W / Ed.H) < 0.02;
    setMode(same ? 'fit' : 'cover');
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  img.onerror = () => { snack('无法解码这张图片'); URL.revokeObjectURL(url); };
  img.src = url;
}

/* 舞台交互 */
(function bindStage() {
  const stage = $('m3-stage');
  const cv = $('m3-canvas');

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

  $('m3-zoom').addEventListener('input', e => {
    Ed.zoom = Number(e.target.value) / 100;
    $('m3-zoomVal').textContent = `${Math.round(Ed.zoom * 100)}%`;
    draw();
  });

  $('m3-modes').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  $('m3-dClose').onclick = () => $('m3-dialog').close();
  $('m3-dCancel').onclick = () => $('m3-dialog').close();
  $('m3-dApply').onclick = applyEditor;
  $('m3-dPick').onclick = () => {
    S.pending = { name: Ed.name };
    $('m3-imageInput').click();
  };
})();

/* ---------- 读写 ---------- */

async function loadFile(file) {
  if (S.busy) return;
  S.busy = true;
  $('m3-srcState').textContent = '读取中';
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const t0 = performance.now();
    const pkg = await inspect(buf);
    S.pkg = pkg;
    S.fileName = file.name;
    S.images = {};
    for (const u of S.urls.values()) URL.revokeObjectURL(u);
    S.urls.clear();

    $('m3-drop').classList.add('hidden');
    $('m3-fileRow').classList.remove('hidden');
    $('m3-fileName').textContent = file.name;
    $('m3-fileMeta').textContent = `${fmtSize(file.size)} · ${pkg.entries.length} 项`;
    $('m3-srcState').textContent = '已载入';
    $('m3-search').disabled = false;

    renderForm();
    renderKV();
    renderVerify();
    renderNotice();
    setTab('files');
    renderDirty();

    const v = pkg.verify;
    snack(`解析完成 ${Math.round(performance.now() - t0)} ms · ${v ? (v.digestOk && v.rsaOk && v.badFiles === 0 ? '签名有效' : '签名异常') : '未签名'}`);
  } catch (e) {
    $('m3-srcState').textContent = '读取失败';
    setChip('bad', '无法解析');
    snack(String(e.message || e));
  } finally {
    S.busy = false;
    renderDirty();
  }
}

function collectPatch() {
  const m = { ...S.pkg.manifest };
  m.name = $('m3-fName').value.trim();
  m.package = $('m3-fPackage').value.trim();
  m.versionName = $('m3-fVersionName').value.trim();
  m.versionCode = Number($('m3-fVersionCode').value);
  const watch = S.pkg.watch
    ? { ...S.pkg.watch, name: m.name, package: m.package, versionName: m.versionName, versionCode: m.versionCode }
    : null;
  const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  return {
    manifestText: changed(S.pkg.manifest, m) ? JSON.stringify(m, null, 2) + '\n' : null,
    watchText: watch && changed(S.pkg.watch, watch) ? JSON.stringify(watch, null, 2) + '\n' : null,
    images: S.images,
    manifest: m,
  };
}

function validate(m) {
  if (!m.name) return '应用名称不能为空';
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(m.package)) return '包名格式不对';
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
  $('m3-exportBtn').disabled = true;
  const before = S.pkg.bytes.length;
  try {
    const out = await repack(S.pkg, patch, S.identity);
    download(`${patch.manifest.package}.release.${patch.manifest.versionName}.rpk`, out);
    const check = await inspect(out);
    const ok = check.verify.digestOk && check.verify.rsaOk && check.verify.badFiles === 0;
    const delta = out.length - before;
    snack(`已导出 ${fmtSize(out.length)}（${delta >= 0 ? '+' : '-'}${fmtSize(Math.abs(delta))}）· ${ok ? '签名自检通过' : '自检失败'}`);
  } catch (e) {
    snack(`导出失败：${e.message || e}`);
  } finally {
    S.busy = false;
    renderDirty();
  }
}

/* ---------- 事件 ---------- */

$('m3-drop').addEventListener('click', () => $('m3-fileInput').click());
$('m3-drop').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('m3-fileInput').click(); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

$('m3-fileInput').addEventListener('change', e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) loadFile(f);
});
$('m3-changeFile').addEventListener('click', () => $('m3-fileInput').click());

for (const id of ['m3-fName', 'm3-fPackage', 'm3-fVersionName', 'm3-fVersionCode']) {
  $(id).addEventListener('input', renderDirty);
}

$('m3-tabFiles').addEventListener('click', () => setTab('files'));
$('m3-tabImages').addEventListener('click', () => setTab('images'));
$('m3-search').addEventListener('input', () => { if (S.tab === 'files') renderFiles(); else renderImages(); });

$('m3-pickIcon').addEventListener('click', () => pickForImage(iconName()));

$('m3-imageInput').addEventListener('change', async e => {
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

$('m3-exportImages').addEventListener('click', () => {
  if (!S.pkg) return;
  const files = {};
  for (const img of S.pkg.images) files[img.name] = imageBytes(img.name);
  const zipped = zipSync(files, { level: 6 });
  download(`${S.pkg.manifest?.package || 'rpk'}-images.zip`, zipped);
  snack(`导出 ${S.pkg.images.length} 张图片 · ${fmtSize(zipped.length)}`);
});

$('m3-genId').addEventListener('click', async () => {
  const cn = $('m3-cnInput').value.trim() || 'Vela App';
  const btn = $('m3-genId');
  btn.disabled = true;
  try {
    const id = await createIdentity(cn, 3650);
    S.identity = { ...id, fingerprint: new Uint8Array(await sha256(id.certDer)) };
    renderIdentity();
    snack(`已生成自签证书：${cn}`);
  } catch (e) {
    snack(`生成失败：${e.message || e}`);
  } finally {
    btn.disabled = false;
  }
});

$('m3-loadKey').addEventListener('click', () => $('m3-keyInput').click());
$('m3-keyInput').addEventListener('change', async e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const { key, pubDer } = await importPrivateKey(await f.text());
    const cn = $('m3-cnInput').value.trim() || 'Imported Key';
    const cert = await createIdentity(cn, 3650, { key, pubDer });
    S.identity = { ...cert, cn, fingerprint: new Uint8Array(await sha256(cert.certDer)) };
    renderIdentity();
    snack(`已载入私钥：${cn}`);
  } catch (err) {
    snack(`私钥载入失败：${err.message || err}`);
  }
});

$('m3-exportBtn').addEventListener('click', doExport);

$('m3-exportJson').addEventListener('click', () => {
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

/* 主题 */
$('themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  snack(dark ? '已切换到浅色' : '已切换到深色');
});

renderKV();
renderFiles();
renderImages();
setTab('files');
renderDirty();
renderIdentity();
