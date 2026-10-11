'use strict';
/**
 * 棒 1 单测：多站点存储 + 覆盖层生成 + 模型探测。
 * 运行：node --test tests\sites.test.js   （在仓库根目录执行）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 让模块把写入落到临时目录（模块在 require 时读环境变量）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-sites-'));
process.env.WZD_DATA_DIR = TMP;
const S = require('../tools/sites.js');

test('keyEnvFor：站点 ID → 环境变量名', () => {
  assert.strictEqual(S.keyEnvFor('my-relay'), 'MY_RELAY_API_KEY');
  assert.strictEqual(S.keyEnvFor('ibao'), 'IBAO_API_KEY');
  assert.strictEqual(S.keyEnvFor('a.b-c'), 'A_B_C_API_KEY');
  assert.strictEqual(S.keyEnvFor('1x'), '_1X_API_KEY');
  assert.strictEqual(S.keyEnvFor(''), 'SITE_API_KEY');
});

test('normalizeSite：校验与补全', () => {
  const s = S.normalizeSite({ id: 'ibao', baseURL: 'https://x.example/v1', models: [{ id: 'm1' }, { id: 'm2', image: true }] });
  assert.strictEqual(s.keyEnv, 'IBAO_API_KEY');
  assert.strictEqual(s.api, 'openai-completions');
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.models.length, 2);
  assert.strictEqual(s.models[1].image, true);
  assert.ok(s.compat, '默认应当带兼容修正');

  assert.throws(() => S.normalizeSite({ id: 'Bad_ID', baseURL: 'https://x/v1', models: [{ id: 'm' }] }), /站点 ID/);
  assert.throws(() => S.normalizeSite({ id: 'ok', baseURL: 'ftp://x', models: [{ id: 'm' }] }), /http/);
  assert.throws(() => S.normalizeSite({ id: 'ok', baseURL: 'https://x', models: [] }), /模型/);
  assert.throws(() => S.normalizeSite({ id: 'ok', baseURL: 'https://x', models: [{ id: 'm' }], api: 'nope' }), /协议/);
  assert.throws(() => S.normalizeSite({ id: 'ok', baseURL: 'https://x', models: [{ id: 'm' }], keyEnv: '1bad' }), /变量名/);
});

test('readState：老的 data\\site.json 自动读成多站点', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'legacy-'));
  fs.writeFileSync(path.join(dir, 'site.json'), JSON.stringify({
    id: 'ibao', baseURL: 'https://wb.example/v1', api: 'openai-completions',
    keyEnv: 'IBAO_API_KEY', models: [{ id: 'cn:deepseek-v4.1-flash', image: false }],
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  }), 'utf8');
  const st = S.readState(dir);
  assert.strictEqual(st.sites.length, 1);
  assert.strictEqual(st.sites[0].id, 'ibao');
  assert.strictEqual(st.sites[0].enabled, true);
  assert.deepStrictEqual(st.default, { siteId: 'ibao', model: 'cn:deepseek-v4.1-flash' });
  assert.ok(!fs.existsSync(path.join(dir, 'sites.json')), '读取不应写盘');
});

test('upsert / removeSite / setDefault', () => {
  let st = S.emptyState();
  assert.strictEqual(st.sites.length, 0);
  st = S.upsert(st, { id: 'a', baseURL: 'https://a/v1', models: [{ id: 'ma' }] });
  st = S.upsert(st, { id: 'b', baseURL: 'https://b/v1', models: [{ id: 'mb' }, { id: 'mb2' }] });
  assert.strictEqual(st.sites.length, 2);
  st = S.upsert(st, { id: 'a', baseURL: 'https://a2/v1', models: [{ id: 'ma' }], name: '改过的' });
  assert.strictEqual(st.sites.length, 2, '同 id 是更新不是新增');
  assert.strictEqual(st.sites.find((s) => s.id === 'a').baseURL, 'https://a2/v1');
  assert.strictEqual(st.sites.find((s) => s.id === 'a').name, '改过的');

  st = S.setDefault(st, 'b', 'mb2');
  assert.deepStrictEqual(st.default, { siteId: 'b', model: 'mb2' });
  assert.throws(() => S.setDefault(st, 'b', '不存在'), /没有这个模型/);
  assert.throws(() => S.setDefault(st, 'zzz', 'mb'), /没有这个站点/);

  st = S.removeSite(st, 'b');
  assert.strictEqual(st.sites.length, 1);
  assert.strictEqual(st.default, null, '默认站点被删后应清空');
});

test('writeState / readState 往返', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'rt-'));
  let st = S.upsert(S.emptyState(), { id: 'a', baseURL: 'https://a/v1', models: [{ id: 'm', image: true }] });
  st = S.setDefault(st, 'a', 'm');
  const file = S.writeState(st, dir);
  assert.ok(fs.existsSync(file));
  const back = S.readState(dir);
  assert.strictEqual(back.sites[0].models[0].image, true);
  assert.deepStrictEqual(back.default, { siteId: 'a', model: 'm' });
});

test('buildOverlay：多站点 + 停用插件 + 默认模型', () => {
  let st = S.upsert(S.emptyState(), {
    id: 'site-a', name: 'A 网关', baseURL: 'https://a.example/v1', api: 'openai-completions',
    models: [{ id: 'ma' }, { id: 'ma-vision', image: true }],
  });
  st = S.upsert(st, { id: 'site-b', baseURL: 'https://b.example/v1', api: 'anthropic-messages', models: [{ id: 'mb' }] });
  st = S.upsert(st, { id: 'site-c', baseURL: 'https://c.example/v1', models: [{ id: 'mc' }], enabled: false });
  st = S.setDefault(st, 'site-a', 'ma-vision');
  const yml = S.buildOverlay(st, { disabled: ['ui-theme', 'some-plugin'] });

  assert.match(yml, /- id: llm-pi-ai/);
  assert.match(yml, /^\s+site-a:$/m);
  assert.match(yml, /^\s+site-b:$/m);
  assert.ok(!/^\s+site-c:$/m.test(yml), '停用的站点不应生成 provider');
  assert.match(yml, /apiKeyEnv: SITE_A_API_KEY/);
  assert.match(yml, /baseURL: https:\/\/a\.example\/v1/);
  assert.match(yml, /input: \[text, image\]/);
  assert.match(yml, /- id: agent-default-model/);
  assert.match(yml, /provider: site-a/);
  assert.match(yml, /model: ma-vision/);
  assert.match(yml, /- id: some-plugin\n  disabled: true/);
  assert.match(yml, /- id: ui-theme\n  disabled: true/);
  // 停用条目按 id 排序，输出稳定（便于 diff）
  assert.ok(yml.indexOf('some-plugin') < yml.indexOf('ui-theme'));
});

test('keyEnv 碰撞：两个不同站点 ID 推导出同一个变量名时必须被拦住', () => {
  let st = S.upsert(S.emptyState(), { id: 'a-b', baseURL: 'https://a/v1', models: [{ id: 'm' }] });
  assert.strictEqual(st.sites[0].keyEnv, 'A_B_API_KEY');
  assert.throws(() => S.upsert(st, { id: 'a--b', baseURL: 'https://b/v1', models: [{ id: 'm' }] }), /已被站点 a-b 占用/);
  // 显式给一个不同名字就可以
  const ok = S.upsert(st, { id: 'a--b', baseURL: 'https://b/v1', models: [{ id: 'm' }], keyEnv: 'A__B_API_KEY' });
  assert.strictEqual(ok.sites.length, 2);
});

test('默认站点被停用 / 模型被删：默认清空且不再写出悬空的 agent-default-model', () => {
  let st = S.upsert(S.emptyState(), { id: 'a', baseURL: 'https://a/v1', models: [{ id: 'ma' }] });
  st = S.upsert(st, { id: 'b', baseURL: 'https://b/v1', models: [{ id: 'mb' }] });
  st = S.setDefault(st, 'a', 'ma');
  assert.deepStrictEqual(st.default, { siteId: 'a', model: 'ma' });
  assert.throws(() => S.setDefault(st, 'a', '不存在'), /没有这个模型/);

  // 停用默认站点 → default 自动清空
  st = S.upsert(st, { id: 'a', baseURL: 'https://a/v1', models: [{ id: 'ma' }], enabled: false });
  assert.strictEqual(st.default, null, '默认站点被停用后不能继续当默认');
  const yml = S.buildOverlay(st);
  assert.ok(!/agent-default-model/.test(yml), '不该写出默认模型条目');
  assert.ok(!/^\s+a:$/m.test(yml), '停用站点不该出现在 providers 里');

  // 就算硬把 default 塞回来，生成时也会跳过并留一行说明
  const forced = { version: 1, default: { siteId: 'a', model: 'ma' }, sites: st.sites };
  const yml2 = S.buildOverlay(forced);
  assert.ok(!/- id: agent-default-model/.test(yml2));
  assert.match(yml2, /默认模型指向的站点已停用或该模型已删除/);
});

test('停用清单里带我们自己的条目 id：必须过滤掉（否则会把 provider 覆盖层整块关掉）', () => {
  const st = S.upsert(S.emptyState(), { id: 'a', baseURL: 'https://a/v1', models: [{ id: 'ma' }] });
  const yml = S.buildOverlay(st, { disabled: ['llm-pi-ai', 'agent-default-model', 'ui-theme'] });
  const providerEntries = yml.split('\n').filter((l) => l.trim() === '- id: llm-pi-ai').length;
  assert.strictEqual(providerEntries, 1, 'provider 条目只应出现一次（作为我们自己的 providers 条目）');
  const full = S.buildOverlay(S.setDefault(st, 'a', 'ma'), { disabled: ['agent-default-model'] });
  assert.strictEqual(full.split('\n').filter((l) => l.trim() === '- id: agent-default-model').length, 1);
  assert.match(yml, /- id: ui-theme\n  disabled: true/);
});

test('writeOverlay：写文件并回报路径', () => {
  const st = S.upsert(S.emptyState(), { id: 'w', baseURL: 'https://w/v1', models: [{ id: 'm' }] });
  const r = S.writeOverlay(st);
  assert.strictEqual(r.overlay, path.join(TMP, 'site-patch.yml'));
  assert.ok(fs.existsSync(r.overlay));
  assert.match(fs.readFileSync(r.overlay, 'utf8'), /^\s+w:$/m);
});

test('probeModels：两种返回形状 + 错误处理', async () => {
  const openai = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'm-1' }, { id: 'm-2' }] }));
  });
  const anthropic = http.createServer((req, res) => {
    if (!req.headers['x-api-key']) { res.writeHead(401); return res.end('no key'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ id: 'claude-x' }, { name: 'claude-y' }] }));
  });
  const bad = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
  await Promise.all([openai, anthropic, bad].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const url = (s) => 'http://127.0.0.1:' + s.address().port;

  const r1 = await S.probeModels({ baseURL: url(openai) });
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r1.models, ['m-1', 'm-2']);

  const r2 = await S.probeModels({ baseURL: url(anthropic), api: 'anthropic-messages', key: 'sk-x' });
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(r2.models, ['claude-x', 'claude-y'], 'id 与 name 两种字段都认');

  const r3 = await S.probeModels({ baseURL: url(bad) });
  assert.strictEqual(r3.ok, false);
  assert.match(r3.error, /HTTP 500/);

  const r4 = await S.probeModels({ baseURL: 'not-a-url' });
  assert.strictEqual(r4.ok, false);

  await Promise.all([openai, anthropic, bad].map((s) => new Promise((r) => s.close(r))));
});

test('probeModels：超时会返回失败而不是挂住', async () => {
  const slow = http.createServer(() => { /* 永不响应 */ });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const r = await S.probeModels({ baseURL: 'http://127.0.0.1:' + slow.address().port, timeoutMs: 300 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /超时/);
  await new Promise((r2) => slow.close(r2));
});
