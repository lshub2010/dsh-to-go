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

test('migrateLegacy：口令不一致时给出可处理的结果，而不是抛异常', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'mig-badpass-'));
  const oldFile = path.join(dir, 'model-key.enc');
  const okFile = path.join(dir, 'model-key-ok.enc');
  const newFile = path.join(dir, 'keys.enc');
  fs.writeFileSync(oldFile, JSON.stringify(Sec.encrypt('sk-legacy-value', 'old-pass')), 'utf8');
  fs.writeFileSync(okFile, JSON.stringify(Sec.encrypt('sk-legacy-value', 'new-pass')), 'utf8');
  // 先用另一把口令建立 v2 库
  Sec.setKey('some-site', 'sk-existing', 'new-pass', { file: newFile });

  // 旧文件口令与库口令不一致 → 可处理的结果（badpass），不是抛异常
  const r = Sec.migrateLegacy('old-pass', null, { legacyFile: oldFile, file: newFile });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'badpass', '不该抛异常，也不该把旧密钥硬塞进另一把口令的库里');

  // 口令一致时才允许迁移
  const ok = Sec.migrateLegacy('new-pass', null, { legacyFile: okFile, file: newFile });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.siteId, 'default');
});

test('migrateLegacy：目标站点已有密钥时不静默覆盖', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'mig-exists-'));
  const oldFile = path.join(dir, 'model-key.enc');
  const newFile = path.join(dir, 'keys.enc');
  const blob = Sec.encrypt('sk-from-legacy', PASS);
  blob.key_name = 'IBAO_API_KEY';
  fs.writeFileSync(oldFile, JSON.stringify(blob), 'utf8');
  Sec.setKey('ibao', 'sk-already-in-v2', PASS, { file: newFile });

  const r = Sec.migrateLegacy(PASS, null, { legacyFile: oldFile, file: newFile });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'exists');
  assert.strictEqual(Sec.unlockAll(PASS, newFile).keys['ibao'], 'sk-already-in-v2', '原有密钥必须原封不动');

  const ow = Sec.migrateLegacy(PASS, null, { legacyFile: oldFile, file: newFile, overwrite: true });
  assert.strictEqual(ow.ok, true);
  assert.strictEqual(Sec.unlockAll(PASS, newFile).keys['ibao'], 'sk-from-legacy');
});

test('密钥库损坏：绝不能被当成「还没有库」而覆盖', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'corrupt-'));
  const f = path.join(dir, 'keys.enc');
  fs.writeFileSync(f, '{ 这不是 JSON', 'utf8');
  assert.strictEqual(Sec.storeState(f).state, 'corrupt');
  assert.throws(() => Sec.ensurePass(PASS, f), /读不出来|损坏/);
  assert.throws(() => Sec.setKey('x', 'sk-x', PASS, { file: f }), /读不出来|损坏/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{ 这不是 JSON', '损坏的文件必须原封不动');
  const un = Sec.unlockAll(PASS, f);
  assert.strictEqual(un.ok, false);
  assert.strictEqual(un.reason, 'corrupt');

  // 版本不对也算损坏
  const f2 = path.join(dir, 'keys2.enc');
  fs.writeFileSync(f2, JSON.stringify({ version: 1, ct: 'x' }), 'utf8');
  assert.strictEqual(Sec.storeState(f2).state, 'corrupt');
});

test('有密钥却没有口令校验器：拒绝用新口令重建（否则旧密钥永远解不开）', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'noverif-'));
  const f = path.join(dir, 'keys.enc');
  // 先正常建库，再手工删掉 verifier 模拟损坏
  Sec.setKey('a', 'sk-a', PASS, { file: f });
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete j.verifier;
  fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');
  assert.throws(() => Sec.ensurePass('别的口令', f), /校验器/);
  assert.throws(() => Sec.ensurePass(PASS, f), /校验器/);
  const keysNow = JSON.parse(fs.readFileSync(f, 'utf8')).keys;
  assert.ok(keysNow.a, '原有密钥必须还在');
});

test('unlockAll：单条记录损坏时能解多少算多少，并回报 failed', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'partial-'));
  const f = path.join(dir, 'keys.enc');
  Sec.setKey('good', 'sk-good-value', PASS, { file: f });
  Sec.setKey('bad', 'sk-bad-value', PASS, { file: f });
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.keys.bad.ct = Buffer.from('corrupted-not-a-real-ciphertext').toString('base64');
  fs.writeFileSync(f, JSON.stringify(j, null, 2), 'utf8');

  const un = Sec.unlockAll(PASS, f);
  assert.strictEqual(un.ok, true, '还有能解开的密钥就应算成功');
  assert.strictEqual(un.keys.good, 'sk-good-value');
  assert.deepStrictEqual(un.failed, ['bad'], '坏掉的那条要单独报出来');
});

test('setKey：非法变量名必须当场拒绝', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'badenv-'));
  const f = path.join(dir, 'keys.enc');
  assert.throws(() => Sec.setKey('ok-id', 'sk-x', PASS, { file: f, keyName: '1BAD' }), /环境变量名/);
  assert.throws(() => Sec.setKey('ok-id', 'sk-x', PASS, { file: f, keyName: 'has space' }), /环境变量名/);
  assert.strictEqual(fs.existsSync(f), false, '被拒的写入不该留下文件');
});

test('写锁：正常写入后不留 .lock 残留', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'lock-'));
  const f = path.join(dir, 'keys.enc');
  Sec.setKey('a', 'sk-a', PASS, { file: f });
  assert.strictEqual(fs.existsSync(f + '.lock'), false, '.lock 应当被释放');
});

test('CLI selftest 退出码为 0', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'secret.js'), 'selftest'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env),
  });
  assert.strictEqual(r.status, 0, String(r.stdout || '') + String(r.stderr || ''));
  assert.match(String(r.stdout), /文件里没有明文/);
});
