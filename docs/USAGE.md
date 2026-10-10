# 便携版 DeepSeek Harness（dsh）

一块盘就是一个完整的 Agent：**代码层（runtime）可整层替换升级，数据层（data）随身携带**。
插到任意 Windows 10/11 x64 机器上双击即用，**不在宿主机装 Node、不写注册表、不碰 `C:\Users\<你>\.dsh`**。

---

## 1. 目录结构

```
deepseek-harness\
├─ dsh.cmd            ← 日常入口：启动 Web UI（默认端口 3180）并打开浏览器
├─ dsh-cli.cmd        ← 命令行入口：dsh-cli.cmd headless "任务" / --version / --profile xxx
├─ dsh-config.cmd     ← 维护台：自检 / 升级 / 切换槽位 / 备份 / 设置密钥
├─ dsh-doctor.cmd     ← 一键自检
├─ dsh-ui.cmd         ← 图形配置页（浏览器里配置，推荐）
├─ runtime\           【代码层】升级时整体替换，删掉不影响数据
│   ├─ node\          便携 Node v26.7.0（官方 win-x64 发行版解压版）
│   ├─ agent-A\       dsh 0.2.0-rc.2（当前空闲槽＝回滚目标）
│   ├─ agent-B\       dsh 0.2.1-alpha.2（当前活动槽）
│   ├─ npm-cache\     npm 缓存（留在盘上，升级可复用 tarball，275MB，删了只影响升级速度）
│   ├─ current.txt    活动槽指针：写 agent-A 或 agent-B，一行搞定回滚
│   └─ port.txt       Web 端口，默认 3180
├─ data\              【数据层】DSH_HOME：profiles / sessions / storages / cache / agents / logs
├─ secrets\           model-key.enc（AES-256-GCM + scrypt）与 key-name.txt
├─ backups\           升级前自动打的 data-*.zip
├─ ui\config.html      图形配置页（单文件，无外链）
├─ tools\             launcher / 密钥 / 维护脚本
│   ├─ launch.js  secret.js  config.js   启动器、A2 密钥、维护台
│   ├─ site.js                            非官方站点/覆盖层配置器
│   ├─ ui-server.js                       图形配置页的本地服务（127.0.0.1 + 令牌）
│   ├─ ask.js                             统一的问答读取（脚本化也能用）
│   ├─ say.cmd                            中文提示打印器（.cmd 调用）
│   └─ msg\*.txt                          中文提示文案（UTF-8，想改提示语改这里）
└─ VERSION.txt        构建与升级流水记录
```

## 2. 第一次使用（三步）

> **推荐走图形配置页**：双击 `dsh-ui.cmd`（或维护台 `9) 图形配置`）→ 浏览器打开本地配置页，站点、密钥、槽位、升级、诊断都在一个页面里点点点。命令行方式如下。

1. **存密钥**：双击 `dsh-config.cmd` → 选 `5) key` → 输入两遍口令（不落盘）＋粘贴 API key（隐藏输入）。
   结果：`secrets\model-key.enc`，里面只有密文。**口令和密钥都不写进 `data\`，也不进命令行参数。**
   - 如果你的站点是**中转/网关（非官方 DeepSeek）**：先做 `7) 站点/模型` 再存密钥，这样注入的变量名会与站点要求的 `apiKeyEnv` 一致。
   - 已经存过密钥、之后才配站点：**不用重新输入密钥**，启动时会自动按新变量名注入。
2. **启动**：双击 `dsh.cmd` → 输入上一步的口令 → 控制台打印带 token 的地址并自动打开浏览器。
3. **选工作区**：在 Web UI 里点「选择工作区」，添加你要让它干活的项目目录（这是宿主机路径，见 §6）。

命令行用法示例：

```
dsh-cli.cmd --version
dsh-cli.cmd headless "总结这个仓库的主要模块"
dsh-cli.cmd --profile web --help
dsh.cmd --no-key            ← 跳过密钥直接启动（只验证界面/配置时用）
```

## 3. 密钥是怎么保管的

- 存储：`secrets\model-key.enc` = AES-256-GCM 密文，密钥由 scrypt(N=16384) 从你的口令派生；口令本身不存任何地方。
- 使用：启动器在内存里解密 → **只注入子进程环境变量**（默认名 `DEEPSEEK_API_KEY`，可在 `secrets\key-name.txt` 改）→ dsh 的凭据解析「启动环境 > 存储文件 > .env」，环境层优先级最高。
- 已验证：错误口令 3 次即拒绝启动；子进程确实拿到该变量；`grep` 全盘搜不到密钥或口令明文。
- 边界（务必知道）：
  - 这防的是「**U 盘丢了 / 换机器留下痕迹**」，**不防 agent 本身**——dsh 官方文档也写明，agent 的工具进程与你是同一个 OS 用户，文件权限无法把机密对它隔离。
  - 环境层在 dsh 界面里是**只读**的，而且要**重启 dsh 才能换密钥**（启动环境是启动瞬间的快照）。
  - 密钥泄露风险由你自己承担，建议用一把**低额度、可随时吊销**的 key；要换 key 就重跑 `dsh-config.cmd → 5`。
  - 想要更强的静态保护，就把整块盘上 BitLocker To Go / VeraCrypt（本方案与它们叠加不冲突）。

## 4. 升级与回滚（A/B 双槽）

```
dsh-config.cmd
  2) upgrade   → 输入目标版本（如 0.2.1-alpha.2 / latest / alpha）
  3) switch    → 立即切到另一槽（秒级回滚）
```

`upgrade` 的完整流程（每一步都实测过）：自动备份 `data\` → 装进**空闲槽**（先官方源 `registry.npmjs.org`，失败自动转 `registry.npmmirror.com`）→ 跑 `--version` 启动检查，**只有校验通过才切指针** → 失败则回滚 package.json 且指针不动 → 结果写进 `VERSION.txt`。

- 实测耗时：首次（冷缓存）**5 分 28 秒**；复用盘上缓存后 **2 分 09 秒**。
- 手工回滚：把 `runtime\current.txt` 改成另一槽名即可，不需要重装。
- 离线升级：在有网机器上 `npm pack @deepseek-ai/dsh@版本` 拿到 `.tgz`，拷进 `runtime\` 后 `dsh-config.cmd → 6` 查看命令，或在槽目录里用 `--offline` 安装（依赖已缓存在 `runtime\npm-cache`）。
- **不要跟随 `@alpha` 漂移**：dsh 处于 developer preview，明确会破坏兼容；升级请显式给版本号，并先备份。

## 5. 换机器 / 换盘符

- 所有路径都由 `%~dp0` 推导 → **F: 换成 G:/E:/X: 都能跑**（已用 `subst X:` 实测：`X:\dsh-cli.cmd --version` 正常，`DSH_HOME=X:\data`）。
- 数据层、npm 缓存、密钥都在盘上，插到新机器不用重装任何东西。
- **仅限 Windows x64**：依赖里有 `node-pty` / `sharp` / `@swc` 原生模块，平台绑定。要给 Mac/Linux 用，得按平台各放一份 runtime（本布局支持，加 `runtime\node-<平台>` 与槽目录即可）。
- 盘的文件系统 NTFS/exFAT 都行（本方案不用 junction/符号链接）。

## 6. 已知限制与注意点

| 事项 | 说明 |
|---|---|
| 端口 | 固定 3180，目的是和机器上自装的 dsh（默认 3080）**并存**，两者不抢端口、不抢浏览器 cookie（cookie 名按 host+port 派生）。 |
| 工作区路径 | 会话里记录的是**宿主机绝对路径**。在 A 机加的项目到 B 机会失效，需要重新「选择工作区」；会话历史本身还在。 |
| 必须联网 | 模型请求要出网（密钥指向你自己的网关或官方 API）。 |
| 宿主残留 | 进程内环境变量、少量系统临时文件；**不写** `%APPDATA%`，**不创建** `~/.dsh`。已实测：`C:\Users\<你>\.dsh` 全程不存在。 |
| 临时文件 | 默认用**宿主** temp（`%LOCALAPPDATA%\Temp`）。原因：Windows ACL 沙箱会在 `os.tmpdir()` 下建私有临时目录并给它写安全描述符，这一步需要该目录有 `WRITE_OWNER`；数据盘/U 盘根目录通常只给登录用户 `Modify`，会导致 workspace-write 直接失败（`SetNamedSecurityInfoW Win32 5`）。想改回盘上：建 `runtime\usb-temp.txt`（但那块盘必须给足 `WRITE_OWNER`）。 |
| 杀软/公司机 | `.cmd` 与未签名的 `node.exe` 可能被拦；必要时加白名单。 |
| 桌面版 | Electron 桌面版**不做便携**（会写 `%APPDATA%`），便携形态用宿主浏览器开 Web UI。 |
| 性能 | 这块盘写入比本机 SSD 慢约 2.5 倍（装包 5 分 28 秒 vs 本机 2 分 12 秒）。会话/缓存写频繁，别用廉价小 U 盘。 |
| 体积 | 整包约 1.4GB（Node 115MB + 两槽约 0.93GB + 缓存 275MB）。只留一槽可省约 480MB。 |

## 7. 用非官方站点（中转站 / 网关 / 自建服务）

官方 DeepSeek 之外的站点不是"换个密钥"就完事：dsh 需要知道**端点地址、协议、模型清单**，而且这类网关通常有两处必须修正的请求格式。

**推荐做法**：`dsh-config.cmd → 7) 站点/模型`，依次回答：

| 问题 | 说明 |
|---|---|
| 站点 ID | 小写字母/数字/连字符，如 `my-relay`；写进配置后别再改（会话与凭据引用都用它） |
| 接口地址 | **要含 `/v1`**，如 `https://api.example.com/v1` |
| 协议 | 1) OpenAI Chat Completions 2) OpenAI Responses 3) Anthropic Messages。一个站点只能选一种，两种都提供就配两个站点 |
| 密钥变量名 | 默认 `GATEWAY_API_KEY`，决定启动时把密钥注入成哪个环境变量 |
| 模型 ID | 逗号分隔；图片模型写成 `名字?image` |
| 兼容修正 | 推荐 `Y`（见下） |

写入 `data\site-patch.yml`（一份独立覆盖文件），启动 `dsh.cmd` 时由启动器作为 `--patch` 传给 dsh。`data\profiles\web\cordis.patch.yml` **完全归 dsh 与它的 Web UI 所有**，本工具不再往里写（旧版本写在那里的块会在下次配置时自动清理，你的 UI 设置原样保留）。同时同步密钥变量名。**密钥不需要重新输入**：已有加密密钥时，启动器会按新变量名注入它（变量名以 `secrets\key-name.txt` 为准，随时可在官方/中转之间切换）。

懒得敲命令行就用图形页：双击 `dsh-ui.cmd`，或维护台 `9) 图形配置`——站点表单里有协议下拉、模型多行输入、兼容开关和「验收」按钮。

**两个最常见的拒签**（dsh 文档原话："多数 OpenAI 兼容网关至少会拒绝 OpenAI 所接受的某一样东西"）：
- 网关拒绝 `role: "developer"` → `compat.supportsDeveloperRole: false`
- 网关只认 `max_tokens`，不认 `max_completion_tokens` → `compat.maxTokensField: max_tokens`

`7) 站点/模型` 默认就会写这两条；网关本来不需要时去掉也无妨（只是请求形状略有不同）。

**验收**（配完必跑）：

```
runtime\node\node.exe tools\site.js dump
```

它执行 `dsh --profile web --dump-config`：组合成功并打印出你的 provider，就说明语法与字段都被 dsh 接受了。随后启动 `dsh.cmd` → 设置 → 模型 → 选中你填的模型 ID。

**其他情况**：
- 站点没有 `GET /models`（探测失败/列表为空）：手动填模型 ID 即可，效果一样。
- 只有推理模型报错：还是 `supportsDeveloperRole` 那条。
- 想让网关后面的 DeepSeek 真正"关闭思考"：需要 `compat.thinkingFormat: deepseek`，当前配置器还没提供这个开关——手工加到 `data\site-patch.yml` 里站点 provider 的 `compat:` 段即可。注意：再跑一次站点配置（或图形页点「保存站点」）会重写这个文件，手工项会丢，所以改完就不要再重配站点。
- 一个 provider 只能一种协议；中转同时给 OpenAI 与 Anthropic 两套接口 → 建两个站点。

**换/清站点**：`dsh-config.cmd → 8) 站点查看`（输 `c` 清除），重配再走一次 7。

## 8. 维护命令速查

```
dsh-doctor.cmd                                   # 全量自检（空间/槽/端口/密钥/宿主泄漏）
runtime\node\node.exe tools\launch.js selftest    # 预检报告，不起 agent
runtime\node\node.exe tools\secret.js status      # 密钥状态（不打印密钥）
runtime\node\node.exe tools\secret.js selftest    # 加密自检：往返/错误口令/明文泄漏
runtime\node\node.exe tools\config.js versions    # 双槽版本 + 上次用的源
runtime\node\node.exe tools\config.js backup      # 手工备份 data\
```

日志：`data\logs\launcher.log`（每次启动/退出）、`data\logs\startup-*.log`（dsh 启动失败时的完整诊断）。

## 9. 本盘硬规则（改脚本时请遵守）

1. **绝不 `setx`**：`DSH_HOME` / `npm_config_prefix` / `NODE_PATH` 一律只在进程内 `set`。一旦发布成系统/用户变量，机器上自装的 dsh 会跟着这块盘走（拔盘即坏）。
2. **`.cmd` 必须纯 ASCII**：cmd.exe 用系统 ANSI 代码页解析 .bat，中文会被截断并破坏括号配对；中文界面一律放在 `tools\*.js`（UTF-8）里输出。
3. **密钥只在内存**：不得写进 `data\`、不得作为命令行参数、不得回显。
4. 升级流程必须「先备份 → 装空闲槽 → 校验 → 才切指针」。
5. **中文提示语放哪里**：`.cmd` 里**永远不写中文**，它的提示由 `tools\say.cmd` ＋ `tools\msg\<id>.txt`（UTF-8）打印；Node 侧的中文直接写在 `tools\*.js` 里。要改提示语气，改这两处即可，改完不用重新装 dsh。
   （`.cmd` 里的英文注释是给维护者看的，不显示给用户，故意保持 ASCII。）
