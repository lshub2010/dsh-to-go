# dsh-to-go 图形化改造蓝图（v2 界面）

目标：把「一个统一的 Web 入口」做成主要的操作面。首次引导之后，版本安装、站点、密钥、模型、升级、插件、诊断全部在浏览器里完成；`.cmd` 只作为备用入口与真正的冷启动引导。

本文档是**每一棒的自包含交接材料**：任何一棒只读本文档 + 相关源码即可开工。

---

## 0. 已冻结的设计决策

| 决定 | 结论 | 原因 |
|---|---|---|
| 口令模型 | 打开配置页时输入一次，**只存在于服务进程内存**，不落盘 | 盘丢了也解不开密钥；不做「记住口令」 |
| 首次引导 | `build.cmd` 只下载并校验便携 Node → 自动打开浏览器 → 其余全部在网页向导里 | 网页服务本身是 Node 程序，没有 Node 就起不了 |
| 插件维护 | 按 **profile**（`data\profiles\<名>`），不是按 A/B 槽：列条目 + 启停（`disabled` 覆盖）+ 安装/卸载（`dsh plugin … `） | A/B 是两套 dsh 代码，共享同一个 `data\`；插件条目挂在 profile 上 |
| 站点语义 | **多站点可同时启用**，每站点一个 provider；每站点独立密钥；变量名自动 `<站点ID>_API_KEY` | 用户拍板：模型列表多来源可接受 |
| 互斥 | dsh 运行中禁止升级/插件/换槽操作（页面明确提示） | 避免半装状态与文件占用 |
| 所有权边界 | `data\profiles\*\cordis.patch.yml` 永远归 dsh 与其 Web UI；我们的东西一律写到自己的覆盖层 | 已经被坑过一次（受管块被夹进 UI 设置里） |

## 1. 事实基础（实测，勿再猜）

- `dsh --profile web --dump-config` 组合出完整配置树；`--patch <file>` 在其后叠加，**同 `id` 的条目互相覆盖**（patch 的 `config` 是**整块替换**）。
- 条目 schema 含 **`disabled`** 字段（布尔或 `!!js` 表达式）→ 停用插件靠它。**已实测**：从 `--patch` 覆盖层写 `disabled: true` 生效，且能与 `config` 覆盖同时写；`--dump-config` 把它打印在 `config` 之后（看输出时别只截前几行）。
- **基础层没有 `providers:` 段**（`--dump-default-config` 里搜不到）→ provider 全部由我们的覆盖层定义，不存在「覆盖掉官方 provider」的风险。
- 一个覆盖层条目里可以放**多个站点**（`config.providers.<id>`），两个站点并存已实测。
- 插件包 = `@deepseek-ai/*`（当前树里 299 个），基础层来自 `dsh.profile.bundles`（`dsh-base`、`dsh-web-app`），每个 bundle 自带 `cordis.patch.yml`。
- `dsh plugin --profile <name> <pnpm 参数>` 把参数转发给 pnpm，作用目录是 profile 目录。
- 参数顺序坑：启动器标记不能放在裸命令名之前（`--patch f web` → `error: --profile <name> is required`）。
- 密钥注入只走**进程内**环境变量（`set`，绝不 `setx`）。
- `data\` 里的可统计状态：`sessions\<工作区>\session-*`、`storages\`、`logs\`、`profiles\`。
- 沙箱临时目录默认放宿主（盘上 ACL 缺 `WRITE_OWNER` 会让 `workspace-write` 失败）。
- **`secrets\key-name.txt` 这个「全局单名覆盖」在多站点下必须废弃**：它会盖掉每把密钥自己记的变量名，导致旧密钥以错误的变量名注入（实测踩到）。变量名的唯一来源是密钥自身的 `key_name`（回落到站点表的 `keyEnv`）。

## 2. 数据与文件布局

```
data\sites.json          多站点定义（本工具的，不是 dsh 的）
data\site-patch.yml      生成出来的覆盖层（N 个 provider + 默认模型 + 插件启停）
data\jobs\<id>.json      后台任务状态（安装/升级/卸载/插件操作）
data\jobs\<id>.log       后台任务日志（增量读取用）
secrets\keys.enc         多站点密钥（单文件、同一口令加密）+ 口令校验器
runtime\{current.txt,port.txt,npm-cache,agent-A,agent-B,node}
```

### sites.json

```json
{
  "version": 1,
  "default": { "siteId": "ibao", "model": "cn:deepseek-v4.1-flash" },
  "sites": [
    {
      "id": "ibao", "name": "朋友的网关", "baseURL": "https://wb2api.ibax.cn/v1",
      "api": "openai-completions", "enabled": true,
      "keyEnv": "IBAO_API_KEY",
      "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" },
      "models": [ { "id": "cn:deepseek-v4.1-flash", "image": false } ],
      "updated": "…"
    }
  ]
}
```

- `id` 唯一，正则 `^[a-z0-9][a-z0-9-]*$`；`keyEnv` 由 `id` 自动推导（大写、非字母数字转 `_`、数字开头补 `_`），可在界面里手动覆盖。
- 同一站点可有多模型，逐模型 `image` 开关（视觉能力）。

### keys.enc

```json
{
  "version": 2, "algo": "aes-256-gcm", "kdf": "scrypt", "kdf_params": { "N": 16384, "r": 8, "p": 1 },
  "verifier": { "salt": "…", "iv": "…", "tag": "…", "ct": "…" },
  "keys": { "ibao": { "key_name": "IBAO_API_KEY", "salt": "…", "iv": "…", "tag": "…", "ct": "…", "length": 47, "created": "…" } },
  "updated": "…"
}
```

- `verifier` 加密的是固定串 `dsh-to-go:verify`，用它判断口令对不对，**不必解密任何密钥**。
- 兼容旧文件 `secrets\model-key.enc` + `secrets\key-name.txt`：启动器/配置页拿到口令后自动迁移到 v2（迁移前旧文件照常可用）。

## 3. 接口清单（服务端，全部要令牌 + 已登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | 首次：设置口令（写 verifier）；之后：校验口令 → 建立会话（服务端内存里保存口令） |
| POST | `/api/logout` | 清掉内存中的口令 |
| GET | `/api/state` | 概览：槽位/版本/运行状态/端口/体积/磁盘/密钥与站点摘要/日志尾部 |
| GET/POST | `/api/sites` | 读全部站点 / 增改站点（含 `enabled`、模型列表、`image` 勾选、`keyEnv`） |
| POST | `/api/sites/delete` | 删除站点（连带其密钥） |
| POST | `/api/sites/probe` | 用给定 `baseURL+key+协议` 探测 `/models`，返回候选模型列表 |
| POST | `/api/models/default` | 设置默认（provider+model） |
| GET/POST | `/api/keys` | 列出站点密钥状态 / 写入某站点密钥（用会话口令加密） |
| POST | `/api/overlay/rebuild` | 重新生成覆盖层并跑 `--dump-config` 验收 |
| POST | `/api/jobs/install` | 后台安装/升级：`{slot, version}` |
| GET | `/api/jobs` | 任务列表与状态（含进度、阶段） |
| GET | `/api/jobs/log` | `?id=…&from=N` 增量日志 |
| POST | `/api/dsh/start` `/api/dsh/stop` | 启动/停止 dsh（口令从服务内存注入，不经命令行） |
| GET | `/api/dsh/status` | dsh 是否在跑、PID、端口、token URL |
| GET | `/api/plugins` | profile 条目列表（id/name/来源层/是否被禁用/是否第三方） |
| POST | `/api/plugins/toggle` | 启停某条目（写 `disabled` 覆盖） |
| POST | `/api/plugins/pnpm` | 安装/卸载（`dsh plugin --profile web add\|remove <pkg>`，走后台任务） |
| POST | `/api/doctor` | 自检（结果结构化返回，供表格渲染） |

## 4. 棒次与验收

补充两条引擎使用约定（棒 2 定下来的）：

- **取消不等于崩溃**：用户取消后 `reconcile()` 可能先看到进程没了，此时必须写成 `cancelled`（消息「被用户取消」）而不是 `interrupted`——否则界面会把用户自己点的取消报成事故。
- **命令行** `node tools/jobs.js run <kind>` 会**等任务跑完**才退出——因为收尾（写状态、清锁）由发起进程负责；命令行提前退出会把任务丢成「没人管」。
- **网页端**用模块的 `spawnJob()`（非阻塞，立刻返回任务 id），由长驻的服务进程负责收尾，界面用 `readLog(id, from)` 增量轮询。
- 日志开头会回显命令行；**密钥永远不进命令行**（这是硬规则），所以回显是安全的。
- 运行中互斥：`createJob` 直接回 `busy` 而不是排队，避免用户以为"点了没反应"。

| 棒 | 范围 | 交付物 | 验收（必须有真实输出） |
|---|---|---|---|
| 1 ✅ | 数据层：`tools/sites.js`（多站点 CRUD + 覆盖层生成 + `/models` 探测）、`tools/secret.js` v2（多密钥 + verifier + 迁移）、启动器多站点注入 | 三个模块 + 3 个测试文件 | **已完成**：27/27 单测；e2e「一次口令注入两个站点（含自定义变量名）」通过；「v2 缺的用旧文件补齐」回归通过；图形页密钥接口 9 项通过 |
| 2 ✅ | 后台任务引擎 `tools/jobs.js`：状态机、增量日志、互斥、失败回滚、取消、中断识别 | 模块 + 测试 | **已完成**：10/10 单测；集成验收 10/10——真安装任务跑通（退出码 0、槽内版本正确）；长任务期间从**别的进程**轮询 6/6 次看到「忙碌」且 status 调用最慢 179ms（不被卡住）、日志按批流式取到 6 个 tick；真失败任务（不存在的版本）退出码 1、正确判定「原本有安装 → 不删现场」 |
| 3 | 前端骨架 + 概览页（启动/停止/打开 dsh、状态统计、互斥提示） | `ui/app.html`（+ 拆分样式）、服务端 dsh 控制接口（✅ 服务端已落地，页面待做） | 真启动：装好的包起 dsh → 页面显示运行中 → 停止后端口释放 |
| 3 设计决定 | 网页服务把口令**只在内存里**留着（`/api/login` 之后）；点「启动 dsh」时用 `spawn` 起 `tools/launch.js web`，把口令经**子进程环境变量 `WZD_KEY_PASS`** 传给它（launch.js 已支持，不进命令行、不落盘）。「停止」用 `taskkill /F /T` 杀整棵树并确认端口释放。运行中禁用升级/插件（互斥），并在页面上明确提示。 | | |
| 4 | 站点与模型页（多站点 CRUD、探测 `/models`、逐模型视觉、启用开关、默认模型） | 页面 + 接口 | 真探测一个网关；`--dump-config` 里出现全部启用站点 |
| 5 | 升级页（快速升级 + A/B 各自版本） | 页面 + 接口 | 真装空闲槽 → 切指针 → 回滚可用 |
| 6 | 诊断页（结构化自检表格、复制/导出） | 页面 + 接口 | 表格字段与 doctor 输出逐项一致 |
| 7 | 插件页（列条目 + 启停 + 安装/卸载 + 运行中禁用） | 页面 + 接口 | 启停后 `--dump-config` 复验；装卸走真实 pnpm |
| 8 | 首启向导 + 视觉收口（按 ui-ux-pro-max 的 Dark OLED 设计）+ 文档 + 推送 | 向导 + 文档 | 空目录：引导 → 向导走完全流程 → 起 dsh → 200 |

每棒都必须：先写测试/先定义验收 → 实现 → 独立审查（找缺陷）→ 父代理实测（真启动或真安装，不看"代码看起来对"）。

## 4.5 独立审查与修复记录（棒 1+2 之后）

独立对抗性审查（子代理，只读）复现并确认了一批缺陷，已全部修掉并补了回归用例：

| 级别 | 问题 | 修法 |
|---|---|---|
| 高 | 执行锁实际不成立：`acquireLock` 抢锁失败后**无条件覆盖锁**；且 `queued` 对 `isBusy` 不可见 → 两个安装可同时写同一个槽（审查已复现「两个任务同时 running」） | 持有者活着就直接失败、绝不覆盖锁；`queued` 也算占用；新增两条回归用例（背靠背创建、并发抢锁） |
| 高 | `/api/key/clear` 缺 `siteId` 时**直接删掉整个密钥库**，无任何前置条件 | 删库必须显式 `confirm: "DELETE_ALL"` + 再验一次口令，否则 400；顺带让会话失效 |
| 中 | 两套站点事实来源（`site.js`/`site.json` vs `sites.js`/`sites.json`），网页里配的站点启动器看不到 | 站点接口全部改走 `sites.js`；旧的 `/api/site` 保留但同样写 `sites.json`（单一写入者） |
| 中 | 新代码仍在写已废弃的全局 `secrets\key-name.txt` | 去掉 `ui-server`/`site.js` 里的 `setKeyName` 调用 |
| 中 | `sites.js probe` 把密钥放在**命令行参数**里 | 改从环境变量 `WZD_PROBE_KEY` 读 |
| 中 | 后台安装会把用户设过的**网页端口悄悄改回 3180**（并覆盖构建记录） | 只在显式 `--port` 或首次时写端口；构建记录改为追加 |
| 中 | `migrateLegacy` 口令不一致时**抛异常**，且会静默覆盖同名站点密钥 | 先校验口令 → 返回 `{ok:false,reason:'badpass'}`；目标已存在 → `{ok:false,reason:'exists'}`（要覆盖得显式 `overwrite`） |
| 中 | 默认站点被停用后仍写出**悬空的** `agent-default-model` | 生成时校验「站点启用且模型存在」，否则跳过并留一行说明；`upsert`/`setDefault` 同步清空/拒绝 |
| 低 | `running` 与 `pid` 分两次落盘 → 中间窗口会被别的进程误判成中断 | spawn 拿到 pid 后**一次性**写 `running+pid` |
| 低 | PID 复用会让 `isBusy` 永远为真 | 加 3 小时兜底：跑太久按异常收掉；取消前用命令行核对 PID 身份 |
| 低 | 日志截断破坏增量偏移、可能切断多字节字符 | 截断对齐行首/字符边界 + 递增 `logEpoch`；`readLog` 越界时明确返回 `reset:true` |
| 低 | `pruneOld` 可能删掉还没跑的 `queued` 任务 | 排队中的永不删，且按实际删除数补足配额 |
| 低 | 停用清单里带我们自己的条目 id 会把 provider 覆盖层整块关掉 | 生成时过滤掉 `llm-pi-ai` / `agent-default-model` |
| 低 | `keyEnvFor` 碰撞（`a-b` 与 `a--b` 都得到 `A_B_API_KEY`） | `upsert` 时校验变量名唯一，撞了就明确报错要求改名 |
| 低 | 启动器回退匹配从变量名反推，含连字符的站点 id 永远对不上 | 改成按站点表的 `id↔keyEnv` 映射匹配 |
| 低 | 中断的安装任务不回滚，半装残留 | `reconcile` 对 interrupt 的安装任务同样触发回滚 |
| 低 | `WZD_ROOT` 不被 `install.js`/`config.js` 认 | 两个脚本统一从 `WZD_ROOT` 解析根目录 |
| 测试 | `tests/launch.test.js` 有一条**恒真的假测试**（名字叫 refreshOverlay，函数体没调用它） | 改成在独立进程 + 独立数据目录里真调用并断言返回 null |
| 测试 | `PATH` 断言用 `||` 几乎恒真 | 改成断言前两项分别是便携 Node 与活动槽的 `.bin` |

审查提出的「未验证假设」里，两条已由本次修复直接消除（悬空默认模型的真实行为、并发安装是否会写坏槽）；其余（PID 复用下 `process.kill(pid,0)` 的具体表现）保留了兜底而不是精确判定。

## 5. 视觉基线（ui-ux-pro-max 输出，实际采用部分）

- 风格：Dark Mode (OLED)，深色优先；浅色不做默认。
- 色板：底 `#0F172A`、卡片 `#1B2336`、主 `#1E293B`、边框 `#475569`、次要文字 `#94A3B8`、前景 `#F8FAFC`、强调/CTA `#22C55E`、危险 `#EF4444`。
- 字体：界面 `IBM Plex Sans`，代码/ID/日志 `JetBrains Mono`（本地不联网时回落系统等宽）。
- 动效：入场错落 300-450ms（`back.out(1.4)` 风格），必须尊重 `prefers-reduced-motion`。
- 硬要求：图标用 SVG（不用 emoji）、点击元素 `cursor:pointer`、悬停 150-300ms 过渡、键盘焦点可见、对比度 ≥ 4.5:1、375/768/1024/1440 四档可用。
- 弃用：该工具自动推荐的「FAQ 落地页版式」（与控制台无关）。

## 6. 风险与回退

- **装到一半拔盘**：任务状态在 `data\jobs\` 里，重开后可见失败原因；指针未切换即等于没升级。
- **覆盖层写坏**：每次写前备份到 `backups\overlay-<时间>.yml`，并提供「回滚到上一个覆盖层」。
- **口令遗忘**：无法找回（这是设计目标）；界面明确提示，并允许「删除全部密钥重设」。
- **旧包兼容**：`secret.js` 保持读取旧 `model-key.enc` 的能力，直到迁移完成。
