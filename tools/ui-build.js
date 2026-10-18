'use strict';
/**
 * ui-build.js —— 把 src/ 合成**单文件** ui/app.html
 *
 *   node tools/ui-build.js [--check]
 *
 * 源：
 *   src/head.html            头（含 <!--{{CSS}}--> 占位）
 *   src/legacy.css           原有视觉层（保留，作为兜底）
 *   src/fluent-overrides.css Fluent 2 覆盖层（把老类名映射到 Fluent 观感）
 *   src/partials/*.html       各分区结构（一个分区一个文件，便于并行维护）
 *   src/app.js               前端逻辑
 *   third_party/fluent/fluent.min.js      Fluent UI Web Components 离线 bundle（可缺）
 *   third_party/fluent/fluent-theme.css   Fluent 2 深色主题变量（可缺）
 *
 * 产物仍然是零外链单文件：所有 CSS/JS 都内联，不新增请求。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'ui', 'app.html');
const FLUENT_DIR = path.join(ROOT, 'third_party', 'fluent');

const read = (p, dflt) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (dflt !== undefined) return dflt; throw new Error('缺少文件：' + path.relative(ROOT, p)); } };
const SECTIONS = ['overview', 'sites', 'upgrade', 'diag', 'plugins'];

function build() {
  const head = read(path.join(SRC, 'head.html'));
  const css = [
    '/* ===== 原有视觉层（src/legacy.css）===== */',
    read(path.join(SRC, 'legacy.css')),
    '/* ===== Fluent 2 主题（third_party/fluent/fluent-theme.css）===== */',
    read(path.join(FLUENT_DIR, 'fluent-theme.css'), '/* 未提供主题文件，使用 src/fluent-overrides.css 里的兜底变量 */'),
    '/* ===== Fluent 2 覆盖层（src/fluent-overrides.css）===== */',
    read(path.join(SRC, 'fluent-overrides.css'), ''),
    '/* ===== 外观层（src/appearance.css）：流体背景 / 主色 / 动效 ===== */',
    read(path.join(SRC, 'appearance.css'), ''),
  ].join('\n');

  if (!head.includes('<!--{{CSS}}-->')) throw new Error('src/head.html 缺少 CSS 占位 <!--{{CSS}}-->');
  const html = [head.replace('<!--{{CSS}}-->', '<style>\n' + css + '\n</style>'), '', '<body>',
    read(path.join(SRC, 'partials', 'header.html')).trimEnd(), '',
    '<main>',
    ...SECTIONS.map((s) => read(path.join(SRC, 'partials', s + '.html')).trimEnd()),
    '</main>', '',
    read(path.join(SRC, 'partials', 'login.html')).trimEnd(), ''];

  // Fluent 组件库：有就内联（浏览器端 IIFE），没有就跳过（页面仍能跑，只是控件是原生的）
  const fluentJs = read(path.join(FLUENT_DIR, 'fluent.min.js'), '');
  if (fluentJs) html.push('<script>/*{{FLUENT_BUNDLE_BEGIN}}*/' + fluentJs + '/*{{FLUENT_BUNDLE_END}}*/</script>');
  html.push('<script>', read(path.join(SRC, 'app.js')), '</script>', '</body>', '</html>', '');

  const out = '<!-- 生成物：由 tools/ui-build.js 从 src/ 合成，请改 src/ 不要改这里 -->\n' + html.join('\n');
  return out;
}

const out = build();

// 自检：单文件 + 零外链
const bad = [];
const ext = /(?:src|href)\s*=\s*["'](https?:|\/\/)/gi;
let m;
while ((m = ext.exec(out))) bad.push(m[0]);
if (/<link[^>]+href=["'](?!data:)/i.test(out)) bad.push('<link> 外链');
if (/<script[^>]+src=/i.test(out)) bad.push('<script src=> 外链');

if (process.argv.includes('--check')) {
  if (bad.length) { console.error('外部资源检查失败：' + bad.join(', ')); process.exit(1); }
  console.log('单文件/零外链检查通过；体积 ' + out.length + ' 字节');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');
const sha = crypto.createHash('sha256').update(out).digest('hex').slice(0, 16);
console.log('已生成 ui/app.html：' + out.length + ' 字节，sha256:' + sha);
console.log('  分区：' + SECTIONS.join(' / ') + '；Fluent bundle：' + (fs.existsSync(path.join(FLUENT_DIR, 'fluent.min.js')) ? '内联' : '未提供（跳过）'));
if (bad.length) {
  console.error('警告：产物里出现外部资源引用 → ' + bad.join(', '));
  process.exit(1);
}
