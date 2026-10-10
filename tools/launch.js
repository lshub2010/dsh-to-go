'use strict';
/**
 * Portable DeepSeek Harness launcher.
 *
 * Responsibilities (all in-process, nothing persists to the host):
 *   1. resolve the active runtime slot (A/B) from runtime/current.txt
 *   2. inject every path so dsh keeps ALL user data on this drive
 *   3. unlock the A2 encrypted key store and hand the plaintext key to the child
 *      process environment only (never to a file, never to a command line)
 *   4. exec the dsh CLI of the active slot with inherited stdio
 *
 * Usage:
 *   node tools/launch.js web [-- extra dsh args]      # Web UI (default port 3180)
 *   node tools/launch.js cli <dsh args...>            # any dsh profile / headless run
 *   node tools/launch.js raw <dsh args...>            # pass args straight through
 *   node tools/launch.js selftest                     # preflight report, no agent
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const secretLib = require('./secret.js');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const NODE_DIR = path.join(RUNTIME, 'node');
const NODE_EXE = path.join(NODE_DIR, 'node.exe');
const DATA = path.join(ROOT, 'data');
const AGENTS_HOME = path.join(DATA, 'agents');
const TMP = path.join(RUNTIME, 'tmp');
const PORT_FILE = path.join(RUNTIME, 'port.txt');
const OVERLAY = path.join(DATA, 'site-patch.yml');
const SLOT_FILE = path.join(RUNTIME, 'current.txt');
const LOG_DIR = path.join(DATA, 'logs');

function readSlot() {
  try {
    const v = fs.readFileSync(SLOT_FILE, 'utf8').trim();
    if (/^agent-[AB]$/.test(v)) return v;
  } catch (e) { /* default below */ }
  return 'agent-A';
}

function readPort() {
  try {
    const v = parseInt(fs.readFileSync(PORT_FILE, 'utf8').trim(), 10);
    if (v >= 1 && v <= 65535) return v;
  } catch (e) { /* default below */ }
  return 3180;
}

function agentDir(slot) { return path.join(RUNTIME, slot || readSlot()); }
function dshBin(slot) { return path.join(agentDir(slot), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'); }

function dshVersion(slot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(agentDir(slot), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch (e) {
    return 'not-installed';
  }
}

function tempRoot(env) {
  // Where the harness process keeps its temp files.
  //
  // DEFAULT = the host user temp. The Windows ACL sandbox creates its private temp
  // directory under os.tmpdir() and then applies a security descriptor that also needs
  // WRITE_OWNER (it writes an integrity label). A data/removable volume whose root
  // grants the signed-in user only Modify (Authenticated Users:(M) with a non-elevated
  // token) makes that call fail with Win32 5 = ACCESS_DENIED, which aborts the whole
  // workspace-write policy. Opting back onto the drive is possible, but only when the
  // drive's ACL grants the user WRITE_OWNER: create runtime\usb-temp.txt.
  if (fs.existsSync(path.join(RUNTIME, 'usb-temp.txt'))) return TMP;
  const local = env.LOCALAPPDATA || process.env.LOCALAPPDATA;
  return local ? path.join(local, 'Temp') : 'C:\\Windows\\Temp';
}

function buildEnv(extra) {
  const slot = readSlot();
  const env = Object.assign({}, process.env, extra || {});
  env.DSH_HOME = DATA;
  env.DSH_AGENTS_HOME = AGENTS_HOME;
  env.DSH_RESOURCE_CACHE = path.join(DATA, 'cache', 'resources');
  env.npm_config_cache = path.join(RUNTIME, 'npm-cache');
  env.npm_config_prefix = path.join(RUNTIME, 'npm-global');
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  const tmp = tempRoot(env);
  env.TEMP = tmp;
  env.TMP = tmp;
  delete env.TMPDIR;
  env.PATH = [NODE_DIR, path.join(agentDir(slot), 'node_modules', '.bin'), process.env.PATH || ''].join(path.delimiter);
  return env;
}

function log(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'launcher.log'), '[' + new Date().toISOString() + '] ' + line + '\n', 'utf8');
  } catch (e) { /* logging must never break a launch */ }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function fail(msg) {
  console.error('\n【启动器】' + msg + '\n');
  process.exit(1);
}

async function resolveKey(env, opts) {
  if (opts.noKey) return env;
  if (process.env.WZD_KEY) {
    env[process.env.WZD_KEY_NAME || secretLib.keyName()] = process.env.WZD_KEY;
    console.log('【启动器】密钥来自 WZD_KEY 环境变量');
    return env;
  }
  const file = secretLib.secretFile();
  if (!fs.existsSync(file)) {
    console.log('\n【启动器】还没有配置加密密钥：' + file);
    console.log('【启动器】dsh 仍会启动，但模型请求会以 MISSING_CREDENTIAL 失败。');
    console.log('【启动器】请运行 dsh-config.cmd → 5) key 设置/更换密钥。');
    const a = (await ask('无密钥继续启动？[Y/n] ')).toLowerCase();
    if (a === 'n' || a === 'no') process.exit(0);
    return env;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = secretLib.unlock({ file });
    if (r.ok) {
      env[r.keyName] = r.secret;
      console.log('【启动器】密钥已解锁（' + r.keyName + '，' + r.secret.length + ' 字符，仅存在于内存）');
      log('key unlocked name=' + r.keyName);
      return env;
    }
    if (r.reason === 'missing') return env;
    if (r.reason === 'noprompt') {
      fail(r.error + '\n【启动器】提示：请从 cmd 窗口双击运行 dsh.cmd，掩码口令提示才会出现。');
    }
    console.log('\n【启动器】口令错误（' + attempt + '/3）');
  }
  fail('连续 3 次口令错误，已中止启动。');
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = (argv[0] || 'web').toLowerCase();
  let dshArgs;

  if (mode === 'keycheck') {
    const env = await resolveKey(buildEnv(), {});
    const name = secretLib.keyName();
    const probe = 'console.log(process.env[' + JSON.stringify(name) + '] ? ("子进程已收到 " + ' + JSON.stringify(name) + ' + "（长度 " + process.env[' + JSON.stringify(name) + '].length + "）") : "子进程未收到 ' + name + '")';
    const r = require('child_process').spawnSync(NODE_EXE, ['-e', probe], { env, encoding: 'utf8' });
    process.stdout.write(String(r.stdout || ''));
    return r.status === 0 ? 0 : 1;
  }

  if (mode === 'selftest') {
    const slot = readSlot();
    const key = secretLib.secretFile();
    console.log('U 盘根目录 : ' + ROOT);
    console.log('活动槽     : ' + slot + '  (dsh ' + dshVersion(slot) + ')');
    console.log('另一槽     : ' + (slot === 'agent-A' ? 'agent-B' : 'agent-A') + '  (dsh ' + dshVersion(slot === 'agent-A' ? 'agent-B' : 'agent-A') + ')');
    console.log('便携 Node  : ' + NODE_EXE + '  ' + (fs.existsSync(NODE_EXE) ? '（存在）' : '（缺失！）'));
    console.log('数据目录   : ' + DATA);
    console.log('网页端口   : ' + readPort());
    console.log('密钥文件   : ' + (fs.existsSync(key) ? key + '（已配置）' : key + '（未配置）'));
    console.log('密钥变量名 : ' + secretLib.keyName());
    console.log('站点覆盖层 : ' + (fs.existsSync(OVERLAY) ? OVERLAY + '（会作为 --patch 传给 dsh）' : '未配置'));
    console.log('临时目录   : ' + tempRoot(process.env) + (fs.existsSync(path.join(RUNTIME, 'usb-temp.txt')) ? '（在 U 盘上：ACL 沙箱可能失败）' : '（宿主，推荐）'));
    return 0;
  }

  // The relay/self-hosted site overlay goes in through dsh's own --patch flag.
  // Argument order matters: the profile must be given as `--profile <name>` (or as
  // argv[0]); a launcher flag placed *before* a bare command name makes dsh answer
  // "error: --profile <name> is required". Verified working orders:
  //   --profile web --patch <f> <app args>     (used for web mode)
  //   <command> --patch <f> <rest>             (used when the user passed a command)
  //   --patch <f> --version                    (flag-only invocations)
  const withPatch = (args) => {
    if (!fs.existsSync(OVERLAY)) return args;
    const a = args.slice();
    if (a[0] === '--profile' && a[1]) return a.slice(0, 2).concat(['--patch', OVERLAY], a.slice(2));
    if (a[0] && !a[0].startsWith('-')) return [a[0], '--patch', OVERLAY].concat(a.slice(1));
    return ['--patch', OVERLAY].concat(a);
  };
  if (mode === 'web') dshArgs = withPatch(['--profile', 'web'].concat(['--port', String(readPort())], argv.slice(1)));
  else if (mode === 'cli') dshArgs = withPatch(argv.slice(1).length ? argv.slice(1) : ['--help']);
  else dshArgs = withPatch(argv.slice(1));

  const slot = readSlot();
  const bin = dshBin(slot);
  if (!fs.existsSync(NODE_EXE)) fail('未找到便携 Node：' + NODE_EXE);
  if (!fs.existsSync(bin)) fail('活动槽 ' + slot + ' 里没有 dsh（' + bin + '）');

  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const env = await resolveKey(buildEnv(), { noKey: argv.includes('--no-key') });
  const label = '活动槽 ' + slot + ' ｜ dsh ' + dshVersion(slot) + ' ｜ 数据目录 ' + DATA;
  console.log('【启动器】' + label);
  log('launch slot=' + slot + ' version=' + dshVersion(slot) + ' args=' + dshArgs.join(' '));

  const child = spawn(NODE_EXE, [bin].concat(dshArgs.filter((a) => a !== '--no-key')), {
    env,
    stdio: 'inherit',
    cwd: process.cwd(),
    windowsHide: false,
  });
  child.on('exit', (code, signal) => {
    log('exit code=' + code + ' signal=' + signal);
    process.exit(code === null ? 1 : code);
  });
  return -1; // keep the event loop alive until the child exits
}

main().then((rc) => { if (rc >= 0) process.exit(rc); }).catch((e) => fail(e.message));
