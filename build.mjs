import { execSync } from 'node:child_process';
import fs from 'node:fs';

const d = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

execSync(
  `npx esbuild assets/app.js --bundle --format=iife --minify ` +
  `--outfile=assets/bundle.js --define:__BUILD__="'${stamp}'" --log-level=warning`,
  { stdio: 'inherit' }
);

let html = fs.readFileSync('index.html', 'utf8');
html = html.replace(/\?v=[\w.-]+/g, `?v=${stamp}`);
html = html.replace(/window\.__PAGE_VERSION__ = '[^']*'/, `window.__PAGE_VERSION__ = '${stamp}'`);
fs.writeFileSync('index.html', html);

const size = (fs.statSync('assets/bundle.js').size / 1024).toFixed(1);
console.log(`build ${stamp} · bundle ${size} KB · html 已同步版本号`);
