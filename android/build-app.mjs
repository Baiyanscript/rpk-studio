// 把网页资产复制到 android/dist，作为 Tauri 的 frontendDist。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(import.meta.dirname, 'dist');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copy = (rel) => {
  const src = path.join(root, rel);
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
};

for (const rel of ['index.html', 'assets/bundle.js', 'assets/md3.css', 'docs/rpk-format.md']) {
  if (fs.existsSync(path.join(root, rel))) copy(rel);
}

fs.writeFileSync(
  path.join(out, 'assets', 'bundle.js'),
  fs.readFileSync(path.join(out, 'assets', 'bundle.js'), 'utf8').replace(/\?v=[\w.-]+/g, '')
);

const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8')
  .replace(/\?v=[\w.-]+/g, '');
fs.writeFileSync(path.join(out, 'index.html'), html);

console.log('android/dist 就绪');
