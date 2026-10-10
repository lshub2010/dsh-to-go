'use strict';
/**
 * 棒 1 单测：多站点密钥库 + 口令校验器 + 旧文件迁移。
 * 运行：node --test tests\secret.test.js   （在仓库根目录执行）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-to-go-secret-'));
const KEYS = path.join(TMP, 'keys.enc');
const LEGACY = path.join(TMP, 'model-key.enc');
process.env.WZD_SECRET_FILE = KEYS;
process.env.WZD_LEGACY_FILE = LEGACY;
process.env.WZD_SELFTEST_DIR = TMP;
const Sec = require('../tools/secret.js');

const PASS = 'unit-test-pass';

test('未建立密钥库时：unlockAll 报 missing，verifyPass 为假', () => {
  assert.strictEqual(Sec.verifyPass(PASS), false);
  const r = Sec.unlockAll(PASS);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'missing');
});

test('ensurePass 建立口令校验器，verifyPass 分辨对错', () => {
  const store = Sec.ensurePass(PASS);
  assert.ok(store.verifier, '应写入 verifier');
  assert.strictEqual(Sec.verifyPass(PASS), true);
  assert.strictEqual(Sec.verifyPass('wrong'), false);
  assert.strictEqual(Sec.verifyPass(''), false);
  // 再次调用不应覆盖已有校验器
  const again = Sec.ensurePass('another-pass');
  assert.deepStrictEqual(again.verifier, store.verifier);
});

test('setKey：多站点并存、清单正确、可解锁', () => {
  const a = Sec.setKey('site-a', 'sk-aaa-123456', PASS, { keyName: 'SITE_A_API_KEY' });
  assert.strictEqual(a.siteId, 'site-a');
  assert.strictEqual(a.keyName, 'SITE_A_API_KEY');
  assert.strictEqual(a.length, 13);
  Sec.setKey('site-b', 'sk-bbb-abcdef', PASS, { keyName: 'SITE_B_API_KEY' });

  const list = Sec.listKeys();
  assert.deepStrictEqual(list.map((x) => x.siteId), ['site-a', 'site-b']);
  assert.strictEqual(list[0].length, 13);

  const un = Sec.unlockAll(PASS);
  assert.strictEqual(un.ok, true);
  assert.strictEqual(un.keys['site-a'], 'sk-aaa-123456');
  assert.strictEqual(un.keys['site-b'], 'sk-bbb-abcdef');
});

test('密文里不出现明文口令或密钥', () => {
  const raw = fs.readFileSync(KEYS, 'utf8');
  assert.ok(!raw.includes('sk-aaa'), '不应出现密钥明文');
  assert.ok(!raw.includes('sk-bbb'), '不应出现密钥明文');
  assert.ok(!raw.includes(PASS), '不应出现口令明文');
  const j = JSON.parse(raw);
  assert.strictEqual(j.version, 2);
  assert.strictEqual(j.algo, 'aes-256-gcm');
  assert.ok(j.keys['site-a'].tag && j.keys['site-a'].iv && j.keys['site-a'].ct);
});

test('错口令：写入被拒、解锁被拒', () => {
  assert.throws(() => Sec.setKey('site-c', 'sk-ccc', 'not-the-pass'), /校验器/);
  const un = Sec.unlockAll('not-the-pass');
  assert.strictEqual(un.ok, false);
  assert.strictEqual(un.reason, 'badpass');
  assert.ok(!Sec.listKeys().some((x) => x.siteId === 'site-c'), '被拒的写入不应留下痕迹');
});

test('站点 ID 与空密钥的校验', () => {
  assert.throws(() => Sec.setKey('Bad_ID', 'sk-x', PASS), /站点 ID/);
  assert.throws(() => Sec.setKey('ok-id', '', PASS), /不能为空/);
});

test('unlock() 兼容旧调用：返回主密钥', () => {
  const r = Sec.unlock({ pass: PASS });
  assert.strictEqual(r.ok, true);
  assert.ok(['sk-aaa-123456', 'sk-bbb-abcdef'].includes(r.secret));
  assert.ok(r.siteId, '应回报选中了哪个站点');
  assert.strictEqual(Object.keys(r.keys).length, 2);
});

test('unlock() 没有口令时返回 noprompt，不抛异常', () => {
  const r = Sec.unlock({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'noprompt');
});

test('removeKey 与 destroyStore', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'rm-'));
  const f = path.join(dir, 'keys.enc');
  Sec.setKey('x', 'sk-x', PASS, { file: f });
  assert.strictEqual(Sec.listKeys(f).length, 1);
  assert.strictEqual(Sec.removeKey('x', f), true);
  assert.strictEqual(Sec.listKeys(f).length, 0);
  assert.strictEqual(Sec.removeKey('不存在', f), false);
  assert.strictEqual(Sec.destroyStore(f), true);
  assert.ok(!fs.existsSync(f));
  assert.strictEqual(Sec.destroyStore(f), false, '已删除再删应返回 false');
});

test('migrateLegacy：旧单密钥导入 v2，旧文件保留', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'mig-'));
  const oldFile = path.join(dir, 'model-key.enc');
  const newFile = path.join(dir, 'keys.enc');
  // 造一个 v1 旧文件（key_name 记录成 IBAO_API_KEY）
  const blob = Sec.encrypt('sk-legacy-47chars-xxxxxxxxxxxxxxxxxxxxxxxxxxx', PASS);
  blob.key_name = 'IBAO_API_KEY';
  fs.writeFileSync(oldFile, JSON.stringify(blob, null, 2), 'utf8');

  const r = Sec.migrateLegacy(PASS, null, { legacyFile: oldFile, file: newFile });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.siteId, 'ibao', '站点 ID 应由变量名推出来');
  assert.strictEqual(r.keyName, 'IBAO_API_KEY');
  assert.ok(fs.existsSync(oldFile), '旧文件必须保留（可回退）');

  const un = Sec.unlockAll(PASS, newFile);
  assert.strictEqual(un.keys['ibao'], 'sk-legacy-47chars-xxxxxxxxxxxxxxxxxxxxxxxxxxx');

  // 口令不对则拒绝迁移
  const bad = Sec.migrateLegacy('wrong-pass', null, { legacyFile: oldFile, file: path.join(dir, 'k2.enc') });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.reason, 'badpass');

  // 旧文件不存在
  const missing = Sec.migrateLegacy(PASS, null, { legacyFile: path.join(dir, 'nope.enc'), file: path.join(dir, 'k3.enc') });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, 'missing');
});

test('CLI selftest 退出码为 0', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'secret.js'), 'selftest'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env),
  });
  assert.strictEqual(r.status, 0, String(r.stdout || '') + String(r.stderr || ''));
  assert.match(String(r.stdout), /文件里没有明文/);
});
