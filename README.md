# Clawd on Desk × DSH 增强包 + 鲸鱼娘主题

一个仓库两件配套的东西：`dsh-clawd-extras`（Clawd on Desk 的 DeepSeek Harness 桥接增强版）和[鲸鱼娘主题](themes/whale-girl/)（桌宠皮肤，素材来自 [vlln/whale-girl](https://github.com/vlln/whale-girl)，MIT）。

官方 bridge 只上报会话状态和权限审批。这个插件把 DSH 有、Clawd 也收、但官方没接的信号补齐。

## 仓库内容

| 路径 | 内容 |
|---|---|
| `lib/` `cordis.patch.yml` `package.json` | 宿主半边：事件映射、上报、余额轮询 |
| `client.js` | 浏览器半边：设置页的配置表单 |
| `themes/whale-girl/` | 鲸鱼娘主题（素材源 + 可直接导入的 zip） |
| `params.example.json` | 可热改的参数示例 |
| `test/` | 27 项单测（18 项原样 + 9 项 SSH 主机传输：发现与 nonce 正负用例、端到端、审批往返、身份三态、fail closed、override 排他），另有 `live-probe.mjs` 在线诊断反向隧道 |
| `LICENSE` | MIT（主题美术另见文末署名） |

## 设计要点

### 巧思：拿虚拟会话当余额告警灯

Clawd 没有余额这个概念。它的配额环是给订阅制 agent 的限流百分比用的（字段名还是白名单），DeepSeek 按量付费对不上，所以"把余额显示到桌宠上"这条路本身不通。

换个做法：不显示数字，用状态动画当灯。插件造一个虚拟会话 `deepseek-harness:balance-guard-<启动秒>`，余额低于阈值推到 `notification`，低于一半推到 `error`，充值回来让它收场；HUD 行标题写金额，数字也就有了。

有个坑：这个会话**不能是 headless**——Clawd 合并主状态时会跳过 headless 会话，动画根本不会播。

### 妥协：三处绕不开的限制，各自怎么处理

| 限制 | 处理 |
|---|---|
| Clawd 对 DSH 有 sequence fence（按 `session_id` 记水位），两个上报者会互顶序号、双双丢事件，所以不能与官方 bridge 并存 | fork 官方那份，原有行为逐字保留、只加映射。新增映射时开始/结束必须成对——漏了 `compaction/end` 会让状态永久卡在 `sweeping` |
| `request/context` 会写进会话日志，但**不会送达插件的 `session/event` 监听器** | 上下文窗口用可配置兜底 `contextWindowFallback`，真收到事件时覆盖 |
| DSH 的 bundle/patch 只在进程启动时 compose，宿主 HMR 又排除 `node_modules`（插件正是从 `profiles/web/node_modules/...` 解析），改配置必重启 | 插件自己盯 `params.json`：每 3 秒看 mtime，改了就地生效，并顺手触发一次余额轮询 |

## 补了什么

`F1`–`F5` 是全文和源码注释通用的索引（`F` 只是 feature 的流水号，没有别的含义）。配置表、代码注释里写「（F3）」就是指向下表的这一行。

| 编号 | 能力 | DSH 侧来源 | Clawd 侧落点 |
|---|---|---|---|
| F1 | 上下文用量 | `tokenMeter.measure().surfaceTokens` + 上下文窗口 | `context_usage`，HUD 显示百分比 |
| F2 | 等待审批 | `approval/asked` / `approval/decided` | `notification` 状态 |
| F3 | 子代理 / 团队 | `subagent/descriptor`、`team/*`、`delegationDepth > 0` | `juggling` 状态 |
| F4 | 上下文压缩 | `compaction/start` → `sweeping`；`compaction/end` → `idle` | `sweeping` 状态 |
| F5 | 余额告警 | `credentials` → `GET /user/balance` | 独立虚拟会话，按阈值分档 |
| F6 | 远程 DSH（SSH 主机） | `~/.claude/hooks/clawd-remote.json`（Clawd 部署时写入的身份文件） | 走 `x-clawd-routing-nonce` 打到反向转发的 `remotePort`，会话归到该主机名下 |

状态 FIFO、阻塞式审批气泡、`SessionStart`/`SessionEnd` 映射从官方 bridge 原样保留。

### F6：远端 DSH 怎么找到桌面端

Clawd 的「SSH 主机」模式是在远端开反向转发
`ssh -R 127.0.0.1:<remotePort>:127.0.0.1:<appPort>`，远端的一切请求都落到桌面端的
`src/remote-ssh-ingress.js`。那个 ingress **只接受 `GET/POST /state` 与 `POST /permission`，
且必须带该 profile 的 `x-clawd-routing-nonce`（32 位小写 hex），否则一律 404**。

官方 bridge 的 client 既不带这个头、也只在本地找 `~/.clawd/runtime.json`，所以在 SSH 主机模式下
它永远探测不到桌面端（日志里只有 `clawd-unavailable`）。本插件把传输分成两条，发现时二选一：

| 模式 | 判定 | 目标 |
|---|---|---|
| `ssh-remote` | 能读到并校验通过 `clawd-remote.json`（`CLAWD_REMOTE_IDENTITY_PATH` 为其排他覆盖） | 只打 `identity.remotePort`，每次探测/上报都盖 nonce；**不做端口扫描**（该模式下只有这一个端点可达，扫别的只会产出 404） |
| `local` | 所有候选都没有身份文件，**且 Clawd 没有把本机标记成受管远端** | 上游行为不变：`runtime.json` 优先，再扫 `23333-23337` |

身份文件**每次发现都重读**，不跨传输变更缓存：桌面端重新部署（换 nonce 或换端口）后，
下一次上报失败即自愈。身份解析分成三态，因为「没有文件」和「文件不可用」意思相反：

| 状态 | 判定 | 行为 |
|---|---|---|
| `absent` | 所有候选路径都不存在，且没有受管远端标记 | 走本地扫描（上游行为） |
| `invalid` | 文件存在但读不出 / 不是 JSON / 字段不合法，**或**没有文件但带受管远端标记 | **fail closed**：报 `clawd-unavailable`，绝不扫端口 |
| `valid` | 校验通过 | 打 `identity.remotePort` + nonce |

受管远端标记沿用 Clawd 自己的判据（`hooks/server-config.js` 的 `isSshSecureMode`）：`CLAWD_SSH_REMOTE=1`
或 `clawd-ssh-secure-v1`（可用 `CLAWD_SSH_SECURE_MARKER_PATH` 覆盖）。这条是有意为之——半成品身份
一旦回落扫描，这台远端上要是同时开着 Clawd 桌面端，另一台机器的状态乃至审批请求就会被投过去。

身份候选按顺序解析，其中 `CLAWD_REMOTE_IDENTITY_PATH` **排他**：设了它就只认它，不再尝试默认位置
（与 Clawd 的 `resolveRemoteIdentityPath` 一致）。默认顺序是 `~/.claude/hooks/clawd-remote.json`
（Clawd 部署 hook 时写入的那个），再到 `~/.clawd/clawd-remote.json`——后者是本插件的兜底候选，
Clawd 自身不认这个路径。任一候选**存在但不可用**就立刻判 `invalid` 并停止，既不看后面的候选、
也不扫端口；这就是上面 fail closed 的实现方式。受管标记的查找位置**不跟随 identity 覆盖**
（Clawd 的标记路径同样不跟随），挪 identity 不会把"这机器是受管远端"的证据一起挪走。

**验证范围**：F6 传输已在 Linux（Ubuntu 26.04）+ DSH `0.1.2-rc.1` + 真实 Clawd 桌面端上端到端跑通
（探针通过、连上后上报零拒绝、F1 上下文取到真值、F5 余额轮询成功）。**F6 不依赖任何 DSH 版本相关面**
——它只用 Clawd 侧的 identity 文件与 ingress 的 nonce 契约，所以在 `0.1.2-rc.1` 上跑通意味着更旧的
版本预期同样可用（含 Clawd 契约表里的 `0.1.1-rc.2` / `0.1.0-rc.6`），前提是该版本能正常加载插件
并投递 `session/*` 事件（F1–F5 的事件面差异仍在）。

## 安装

```powershell
git clone https://github.com/HarveyZed/clawd-whale-girl.git
cd clawd-whale-girl
dsh plugin --profile web remove @dsh-external/dsh-clawd-bridge   # 同一会话不能有两个上报者
dsh plugin --profile web add "$PWD"
# 重启 dsh web —— bundle 只在启动时 compose
```

依赖零安装（只用 Node 标准库 + DSH 自带服务），克隆下来直接 add。

**远端（Clawd SSH 主机）不需要额外配置**：插件靠 Clawd 部署时写入的 `clawd-remote.json` 自动认出
该模式（F6）。排查入口——桌面端"没反应"时先在远端跑：

```bash
node test/live-probe.mjs
```

它会区分三种长得一样的故障：`nothing is listening on 127.0.0.1:<port>`＝桌面端的 SSH 主机会话没连着
（反向转发没建）；`404 from the Clawd ingress`＝nonce 过期（桌面端重新配对过该主机）；
`OK`＝通。

主题：把 `themes/whale-girl/` 复制进 Clawd 用户主题目录（Windows：`%APPDATA%\clawd-on-desk\themes\`），或在「设置 → 主题 → 导入主题 zip」里选 `themes/whale-girl.zip`。

> 若 Clawd 能看到全局 `dsh` CLI，它的启动同步可能把官方 bridge 装回来。稳妥做法：把 Clawd prefs 里 `agents["deepseek-harness"].integrationInstalled` 置 `false`（`enabled` 保持 `true`，事件照收）。

## 配置

启动层写在 `cordis.patch.yml` 的 `config`，可被 `params.json` 覆盖（后者运行中 3 秒热生效）。

| 键 | 默认 | 说明 |
|---|---|---|
| `contextUsage` | `true` | 上报上下文用量（F1） |
| `contextWindowFallback` | `1000000` | 收不到 `request/context` 时的窗口，换模型要手改 |
| `approvalNotification` | `true` | `approval/asked` 切 `notification`（F2），不影响审批气泡 |
| `subagentJuggling` | `true` | 子代理/团队切 `juggling`（F3） |
| `compactionSweeping` | `true` | 压缩切 `sweeping`，结束回 `idle`（F4） |
| `permissionBubble` | `true` | 是否接管普通审批；关掉＝完全交还 DSH 原生弹窗 |
| `permissionTimeoutMs` | `600000` | 等待审批决定的上限；超时按无决定交还 DSH，不伪造 deny |
| `debugLogPath` | 包目录 `debug.log` | 采样日志路径。不写＝用默认；显式空字符串＝关闭 |
| `paramsPath` | 包目录 `params.json` | 热改参数文件。不写＝用默认；显式空字符串＝只读启动层 |
| `paramsPollMs` | `3000` | 参数文件检查间隔（最小 100） |

| `balance.*` | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 余额轮询与告警总开关 |
| `threshold` | `20` | 低于它 `notification`，低于一半 `error` |
| `currency` | `CNY` | 取哪个币种；找不到退回第一个 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用名，经 DSH `credentials` 解析（key 不下发浏览器、不写日志） |
| `baseUrl` / `endpoint` | `https://api.deepseek.com` / `/user/balance` | 余额接口 |
| `refreshMs` | `300000` | 轮询间隔（最小 60000） |
| `firstRetryMs` | `15000` | 首次轮询失败后的重试间隔；凭据就绪后立刻补一次 |
| `mode` | `flash` | `flash`＝跨档显示 `flashMs` 后收场；`sticky`＝低于阈值期间持续显示 |
| `flashMs` | `12000` | `flash` 模式的显示时长 |
| `remindEveryMs` | `1800000` | 仍低于阈值时每隔多久再闪一次（0＝关） |

## 设置页与活参数

- **设置页**：设置 → 内置插件 → 「Clawd 扩展」，字段同配置表，保存后立即生效并写回 `params.json`。
- **活参数**：直接改 `params.json`（可从 `params.example.json` 复制），每 3 秒生效，不用重启；改动会写进调试日志。

## 已知缺陷

当前不足，都不在本仓库的修复计划内。

| 缺陷 | 影响 | 归属 |
|---|---|---|
| Clawd 没有余额字段或接口 | 余额只能借状态动画表达，做不出独立余额牌 | 需上游改 Clawd |
| DSH 没有 worktree 事件 | `carrying` 无法映射 | DSH 事件面 |
| DSH 只有「新增子代理」事件，没有「结束」事件 | 父会话会一直 `juggling`，直到下一次工具事件覆盖 | DSH 事件面 |
| 兼容性验证不完备 | 插件本体（F1–F5）只在 Windows x64 + DSH `0.1.6-alpha.2` 上跑过；F2/F3/F4 的端到端行为与其他平台组合未验证。其他 DSH 版本未验证，Clawd Doctor 可能提示未安装（其契约表不含 `0.1.6-alpha.2`） | 缺跨平台、跨版本的真实端到端环境 |
| 设置页文案仅中文 | DSH 支持多语言，这里 label 是硬编码 | 本仓库未接 locale |

### 未验证部分我的推测

以下是读代码推的，没有实测支撑，当线索用别当结论。

- **macOS / Linux**：宿主半边只用 Node 标准库（`http` / `fs` / `path` / `url`）加全局 `fetch`，没有原生模块、没有 Windows API、没有 shell 调用，包目录靠 `fileURLToPath` 定位而不是 `%APPDATA%`，所以**我倾向于能直接跑**。不确定的是两处外部约定：Clawd 用 `os.homedir()` 拼 `~/.clawd/runtime.json`，三平台路径一致，但 Clawd 自己的 DSH 集成也是 Windows 优先做的；用户主题目录各平台不同，`themes/` 得放到对应位置。余额是纯 HTTPS，与平台无关。
- **更早的 DSH 版本**：插件没有版本门禁（官方 bridge 那份契约表被绕开了），所以旧版本不会报错也不会拒绝加载，最可能的表现是**静默失效**——事件名对不上，映射不触发，桌宠就是不动。`compaction/*`、`subagent/*`、`team/*` 属于较晚加入的事件，早于它们的版本上 F3、F4 大概率完全不工作；F1、F2、F5 依赖的 `tokenMeter`、`approval/*`、`credentials` 服务也可能缺失或改名，同样是「没反应」而不是崩溃。
- **将来的 DSH 版本**：同样的静默风险。事件重命名、`webServer.register` 或设置页 slot 的 API 变动，都不会在安装时报错。排查入口：宿主半边的 `debug.log` 会记下 `post dropped (204)` / `post rejected:`，设置页打不开则说明浏览器半边没加载上。

## 路线图

计划要做的事。

| 事项 | 说明 |
|---|---|
| 补齐鲸鱼娘素材 | `sweeping` 用「整理/清扫」姿势替代借用 `thinking`（需要一张俯身收拾的图，姿势与 `thinking` 的手托下巴区分开）；顺带把只有 2–3 帧的状态补到流畅 |
| 上下文窗口取真值 | 用 `sessionQuery.observeSession()` 的 `contextPressure` 投影替代兜底常量（需先验证该 API 的 lease 释放与取值形状） |

## 许可

- 插件代码 MIT（宿主半边 fork 自 Clawd 官方 bridge，MIT）。
- `themes/whale-girl/` 角色美术来自 [vlln/whale-girl](https://github.com/vlln/whale-girl)（MIT, Copyright (c) 2026 Sam Gao），属社区二创，再分发请保留署名。
