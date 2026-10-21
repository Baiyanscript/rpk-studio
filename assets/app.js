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
  pendingImage: null,
};

/* ---------- 工具 ---------- */

const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const hexUpper = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

function log(text, cls = '') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  $('log').appendChild(el);
  while ($('log').children.length > 14) $('log').firstChild.remove();
}

function clearLog() { $('log').textContent = ''; }

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

function entryByName(name) {
  return S.pkg?.entries.find(e => e.name === name) || null;
}

function imageBytes(name) {
  if (S.images[name]) return S.images[name];
  const e = entryByName(name);
  return e ? dataOf(e) : null;
}

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
  $('exportBtn').disabled = !on || !S.identity;
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
  const files = entries.filter(e => !e.isDir).length;

  const rows = [
    ['包名', manifest?.package || '—'],
    ['应用名', manifest?.name || '—'],
    ['版本', `${manifest?.versionName || '—'}`],
    ['版本号', String(manifest?.versionCode ?? '—')],
    ['页面', String(pages)],
    ['文件', String(files)],
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
  box.innerHTML = '';

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
    row.appendChild(el('span', `entry-name${e.isDir ? ' entry-dir' : ''}`, e.name));
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
  for (const img of list) {
    const bytes = imageBytes(img.name);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    S.urls.set(img.name, url);

    const box = el('div', 'thumb');
    const frame = el('div', 'thumb-img');
    const im = new Image();
    im.src = url;
    im.loading = 'lazy';
    im.alt = '';
    frame.appendChild(im);

    box.appendChild(frame);
    box.appendChild(el('div', 'thumb-name', img.name.split('/').pop()));
    box.appendChild(el('div', 'thumb-meta', img.w ? `${img.w}×${img.h}` : fmtSize(img.bytes)));

    if (S.images[img.name]) box.appendChild(el('span', 'thumb-dot'));
    box.title = `${img.name} · 点击替换`;
    box.onclick = () => { S.pendingImage = img.name; $('imageInput').click(); };

    const acts = el('div', 'thumb-acts');
    const btn = el('button', null, '替换');
    btn.type = 'button';
    btn.onclick = e => { e.stopPropagation(); S.pendingImage = img.name; $('imageInput').click(); };
    acts.appendChild(btn);

    if (S.images[img.name]) {
      const back = el('button', null, '还原');
      back.type = 'button';
      back.onclick = e => {
        e.stopPropagation();
        delete S.images[img.name];
        log(`已还原 ${img.name}`);
        renderImages();
        renderForm();
        renderDirty();
      };
      acts.appendChild(back);
    }
    box.appendChild(acts);
    frag.appendChild(box);
  }
  grid.appendChild(frag);
}

function renderDirty() {
  const m = S.pkg?.manifest;
  if (!m) { $('editState').textContent = '未载入'; return; }
  const changedImages = Object.keys(S.images).length;
  const diff =
    $('fName').value !== (m.name || '') ||
    $('fPackage').value !== (m.package || '') ||
    $('fVersionName').value !== (m.versionName || '') ||
    Number($('fVersionCode').value) !== Number(m.versionCode) ||
    changedImages > 0;
  $('editState').textContent = diff
    ? (changedImages ? `已修改 · ${changedImages} 张图` : '已修改')
    : '未修改';
  $('exportBtn').disabled = !S.identity || !S.pkg;
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

/* ---------- 图片替换 ---------- */

async function rasterize(file, W, H) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const s = Math.min(W / bmp.width, H / bmp.height);
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  ctx.drawImage(bmp, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), srcW: bmp.width, srcH: bmp.height };
}

async function replaceImage(name, file) {
  const target = S.pkg.images.find(i => i.name === name);
  const W = target?.w || 0;
  const H = target?.h || 0;

  try {
    let bytes;
    let note;
    if (file.type === 'image/png' && W && H) {
      const bmp = await createImageBitmap(file);
      if (bmp.width === W && bmp.height === H) {
        bytes = new Uint8Array(await file.arrayBuffer());
        note = `${W}×${H} 原样写入`;
      } else {
        const r = await rasterize(file, W, H);
        bytes = r.bytes;
        note = `${r.srcW}×${r.srcH} → ${W}×${H} 等比缩放`;
      }
    } else if (W && H) {
      const r = await rasterize(file, W, H);
      bytes = r.bytes;
      note = `${r.srcW}×${r.srcH} → ${W}×${H} 等比缩放（转 PNG）`;
    } else {
      bytes = new Uint8Array(await file.arrayBuffer());
      note = '无原始尺寸，按原字节写入';
    }

    const before = imageBytes(name)?.length || 0;
    S.images[name] = bytes;
    log(`替换 ${name} · ${note} · ${fmtSize(before)} → ${fmtSize(bytes.length)}`, 'done');
    renderImages();
    renderForm();
    renderDirty();
  } catch (err) {
    log(`图片处理失败：${err.message || err}`, 'err');
  }
}

/* ---------- 读文件 ---------- */

async function loadFile(file) {
  clearLog();
  $('srcState').textContent = '读取中';
  log(`读取 ${file.name} · ${fmtSize(file.size)}`);
  const buf = new Uint8Array(await file.arrayBuffer());

  try {
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
  if (!S.pkg || !S.identity) return;
  const patch = collectPatch();
  const err = validate(patch.manifest);
  if (err) { log(err, 'err'); return; }

  $('exportBtn').disabled = true;
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
    $('exportBtn').disabled = false;
  }
}

/* ---------- 事件 ---------- */

$('drop').addEventListener('click', () => $('fileInput').click());
$('drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') $('fileInput').click(); });

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

$('tabFiles').addEventListener('click', () => setTab('files'));
$('tabImages').addEventListener('click', () => setTab('images'));
$('fileSearch').addEventListener('input', () => {
  if (S.tab === 'files') renderFiles();
  else renderImages();
});

$('pickIcon').addEventListener('click', () => {
  S.pendingImage = iconName();
  $('imageInput').click();
});

$('imageInput').addEventListener('change', async e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  const name = S.pendingImage;
  S.pendingImage = null;
  if (!f || !name) return;
  await replaceImage(name, f);
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
  $('genId').disabled = true;
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
    $('genId').disabled = false;
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
