// 跑 tests/ 下所有单测：node --test 一把过，失败时按文件列出来
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const DIR = path.join(ROOT, 'tests');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(DIR, f));

const r = spawnSync(NODE, ['--test'].concat(files), { encoding: 'utf8', timeout: 900000, cwd: ROOT });
const out = String(r.stdout || '') + String(r.stderr || '');
process.stdout.write(out);
process.exit(r.status === 0 ? 0 : 1);
