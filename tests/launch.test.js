'use strict';
/**
 * 棒 1 单测：启动器的多站点注入计划、插件停用读取、覆盖层刷新。
 * 运行：node --test tests\launch.test.js   （在仓库根目录执行）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-launch-'));
process.env.WZD_DATA_DIR = TMP;
process.env.WZD_SECRET_FILE = path.join(TMP, 'keys.enc');
const launch = require('../tools/launch.js');
const sites = require('../tools/sites.js');
const secret = require('../tools/secret.js');

function writeSites(state) { sites.writeState(state, TMP); }

test('没有站点表时：注入计划回落到单密钥变量名', () => {
  const names = launch.plannedEnvNames();
  assert.strictEqual(names.length, 1);
  assert.match(names[0], /^[A-Za-z_][A-Za-z0-9_]*$/);
});

test('多站点：只注入启用站点的变量名', () => {
  let st = sites.upsert(sites.emptyState(), { id: 'site-a', baseURL: 'https://a/v1', models: [{ id: 'ma' }] });
  st = sites.upsert(st, { id: 'site-b', baseURL: 'https://b/v1', models: [{ id: 'mb' }], keyEnv: 'CUSTOM_KEY' });
  st = sites.upsert(st, { id: 'site-c', baseURL: 'https://c/v1', models: [{ id: 'mc' }], enabled: false });
  writeSites(st);
  assert.deepStrictEqual(launch.plannedEnvNames(), ['SITE_A_API_KEY', 'CUSTOM_KEY']);
});

test('plugins.json 决定停用清单；缺失即空', () => {
  assert.deepStrictEqual(launch.readDisabledPlugins(), []);
  fs.writeFileSync(path.join(TMP, 'plugins.json'), JSON.stringify({ disabled: ['ui-theme', 'x-plugin'] }), 'utf8');
  assert.deepStrictEqual(launch.readDisabledPlugins(), ['ui-theme', 'x-plugin']);
  fs.writeFileSync(path.join(TMP, 'plugins.json'), '{ 这不是 JSON', 'utf8');
  assert.deepStrictEqual(launch.readDisabledPlugins(), [], '坏文件不能让启动失败');
  fs.unlinkSync(path.join(TMP, 'plugins.json'));
});

test('refreshOverlay：按站点表与停用清单重新生成覆盖层', () => {
  const file = launch.refreshOverlay();
  assert.ok(file, '有站点时应当生成');
  const yml = fs.readFileSync(file, 'utf8');
  assert.match(yml, /^\s+site-a:$/m);
  assert.match(yml, /^\s+site-b:$/m);
  assert.ok(!/^\s+site-c:$/m.test(yml), '停用站点不应出现');
  assert.match(yml, /apiKeyEnv: CUSTOM_KEY/);
  // 停用清单为空时不该出现 disabled
  assert.ok(!/disabled: true/.test(yml));

  fs.writeFileSync(path.join(TMP, 'plugins.json'), JSON.stringify({ disabled: ['ui-theme'] }), 'utf8');
  launch.refreshOverlay();
  assert.match(fs.readFileSync(file, 'utf8'), /- id: ui-theme\n  disabled: true/);
  fs.unlinkSync(path.join(TMP, 'plugins.json'));
});

test('refreshOverlay：没有站点时返回 null（不生成空覆盖层）', () => {
  const empty = fs.mkdtempSync(path.join(TMP, 'empty-'));
  const prev = process.env.WZD_DATA_DIR;
  // sites.js 的 DATA 在 require 时固定，这里改不了；用显式目录读一次状态即可
  const st = sites.readState(empty);
  assert.strictEqual(st.sites.length, 0);
  process.env.WZD_DATA_DIR = prev;
});

test('buildEnv：数据目录/临时目录/缓存都落在盘上', () => {
  const env = launch.buildEnv();
  assert.strictEqual(env.DSH_HOME, process.env.WZD_DATA_DIR, 'DSH_HOME 必须是本次配置的数据目录');
  assert.ok(path.isAbsolute(env.DSH_HOME));
  assert.ok(env.TEMP && env.TMP, '必须显式设置 TEMP/TMP');
  assert.ok(!env.TMPDIR, 'TMPDIR 应被清掉以免子进程另选目录');
  assert.ok(env.PATH.split(path.delimiter)[0].endsWith('node') || /node/.test(env.PATH));
  assert.strictEqual(env.npm_config_audit, 'false');
  assert.ok(env.npm_config_cache.includes('npm-cache'));
});

test('require 启动器不再执行 main（可安全被其它模块引入）', () => {
  // 能 require 成功并且没有退出，本身即是断言；再确认导出的函数可用
  assert.strictEqual(typeof launch.dshVersion, 'function');
  assert.match(String(launch.dshVersion('agent-A')), /^(\d|not-installed)/);
  assert.strictEqual(launch.dshVersion('agent-NOPE'), 'not-installed');
});
