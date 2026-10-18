'use strict';
/**
 * make-icon.js —— 从 assets/app-icon.svg 生成 assets/app.ico（多尺寸，PNG 帧）
 *
 *   runtime\node\node.exe tools\launcher\make-icon.js
 *
 * 为什么要脚本而不是手放一个 .ico：图标要的是「可复现」。改 SVG 之后重跑一次，
 * 16/24/32/48/64/128/256 七个尺寸的 .ico 就重新生成，不用再手工拼。
 *
 * 渲染方式：用系统的 Edge 无头模式把 SVG 以精确像素栅格化（透明背景），
 * 再把 PNG 直接塞进 ICO 容器（Vista 起 ICO 允许 PNG 帧）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SVG = path.join(ROOT, 'assets', 'app-icon.svg');
const OUT = path.join(ROOT, 'assets', 'app.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge/Chrome，无法栅格化 SVG');
}

function renderIt(browser, svg, size, outPng, workDir) {
  const html = path.join(workDir, 'icon-' + size + '.html');
  fs.writeFileSync(html,
    '<!doctype html><meta charset=utf-8><style>html,body{margin:0;padding:0;background:transparent}'
    + 'svg{display:block}</style>' + svg.replace('<svg ', '<svg width="' + size + '" height="' + size + '" '), 'utf8');
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--default-background-color=00000000',
    '--force-device-scale-factor=1',
    '--window-size=' + size + ',' + size,
    '--screenshot=' + outPng,
    'file:///' + html.replace(/\\/g, '/'),
  ];
  const r = spawnSync(browser, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (!fs.existsSync(outPng)) throw new Error('渲染失败（' + size + 'px）：' + (r.stderr || '').slice(0, 300));
  const buf = fs.readFileSync(outPng);
  if (buf.slice(1, 4).toString() !== 'PNG') throw new Error('输出不是 PNG：' + outPng);
  return buf;
}

function buildIco(frames) {
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = icon
  header.writeUInt16LE(count, 4);
  const entries = [];
  let offset = 6 + count * 16;
  for (const f of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 0);   // 0 表示 256
    e.writeUInt8(f.size >= 256 ? 0 : f.size, 1);
    e.writeUInt8(0, 2);                            // color count
    e.writeUInt8(0, 3);                            // reserved
    e.writeUInt16LE(1, 4);                         // planes
    e.writeUInt16LE(32, 6);                        // bpp
    e.writeUInt32LE(f.png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += f.png.length;
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

const svg = fs.readFileSync(SVG, 'utf8');
const browser = findBrowser();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-icon-'));
const frames = [];
for (const size of SIZES) {
  const png = path.join(workDir, 'icon-' + size + '.png');
  frames.push({ size, png: renderIt(browser, svg, size, png, workDir) });
  console.log('  ' + size + 'px  ' + frames[frames.length - 1].png.length + ' bytes');
}
const ico = buildIco(frames);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);
console.log('已生成 ' + path.relative(ROOT, OUT) + '：' + ico.length + ' 字节（' + frames.length + ' 帧）');
