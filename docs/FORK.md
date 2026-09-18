# Pi Web Fork 维护规范

本文件规定 `PriceNing/pi-web` 这个 fork 的**改动纪律、版本规则、发布与同步流程**。
目的只有一个：**长期跟得上上游，同时不丢掉我们自己的功能。**

对外介绍（这是 fork、装哪个包、多了哪些功能）写在仓库根目录的 `README.md` / `README.zh-CN.md`。
**这篇 FORK.md 不是给路人看的产品说明**，是给以后的自己看的操作手册。

---

## 0. 本文档的边界（重要）

本仓库是**公开**的，所以这份文档只写**机制与规范**：任何人照着都能把 fork 跑起来。

**禁止写入本文档或仓库任何位置**：

- 具体机器：主机名、内网 IP、MAC、机器数量、地理位置
- 账号与路径：真实用户名、Windows 用户目录或 Unix home 的真实路径、机器专属的 npm 前缀
- 凭据与策略细节：口令、token 值、哪些机器设了 `PI_WEB_PASSWORD`、端口暴露范围的真实情况
- 会话标识、会话数量等业务数据快照

这些属于**私有部署清单**，放在自己的私有仓库或本地文件里（仓库已用 `.gitignore` 拦住
`*.local.md` 与 `deploy/` 两个惯用落点）。公共文档里写通用形式即可，例如"生产机建议设
`PI_WEB_PIN` 锁版本"，而不是"某台机器锁在某个版本"。

---

## 1. 仓库关系

| | |
|---|---|
| 上游 | https://github.com/agegr/pi-web （`upstream` remote，只 fetch，禁止 push） |
| 本仓库 | https://github.com/PriceNing/pi-web （`origin`，我们的发行分支） |
| 发布包名 | `@pricening/pi-web`（**不是** `@agegr/pi-web`，避免任何人 `npm i` 时把补丁覆盖掉） |
| 上游基线 | 记录在 `package.json` 的 `forkedFrom`（name / version / commit / url） |

分支模型（刻意简单，只有 main）：

```
upstream/main ──merge──▶ origin/main  =  上游 + 本 fork 的全部补丁
```

- **同步用 `merge`，不用 `rebase`**。main 是已发布分支，改写历史会让生产机装到的版本和 git 历史对不上。
- 想试验性做功能时开 `feat/*` 分支，验证完再合回 main；main 上永远只有 fork 自己的补丁集（`[pin-fork]` / `[archive-fork]`）。

---

## 2. 当前本地改动清单

### 2.1 服务端置顶（pin 项目 / 会话）

**动机**：项目和会话一多就找不到。且必须**服务端存储**——localStorage 是每个浏览器一份，PC / 手机 / Pad 三端会各自为政。

### 2.0 补丁全貌（测量于 2026-09-17，重算命令见下）

```bash
git diff --shortstat upstream/main...HEAD     # 2026-09-17：31 files changed, +2908 / -19
git diff --name-status upstream/main...HEAD   # 新增 20 个文件；修改 11 个上游文件
grep -c "pin-fork" components/SessionSidebar.tsx   # 热文件里的标记数（当前 9 处）
node --experimental-strip-types --test lib/pin-*.test.mjs lib/archive-*.test.mjs scripts/*.test.mjs
```

**新增文件（永不与上游冲突）**

| 文件 | 职责 |
|---|---|
| `lib/pin-order.ts` | 无依赖纯逻辑：payload 解析、`comparePinnedFirst`、key 校验、prune。浏览器与 Node 共用 |
| `lib/pin-store.ts` | 服务端存储：读写 `~/.pi/agent/pi-web/pins.json`，`proper-lockfile` 加锁 + 原子写 + 指纹缓存 |
| `app/api/pins/route.ts` | `GET` 读、`POST` 切换（鉴权由 `proxy.ts` 的 `/api/:path*` matcher 自动覆盖） |
| `lib/archive-order.ts` / `lib/archive-store.ts` | 项目归档视图：key = 服务端 `projectKey`，**不移动会话文件** |
| `app/api/archives/route.ts` | 归档 / 取消归档 |
| `app/api/archives/sessions/route.ts` | 设置页里按项目批量删除会话（复用 `deleteSessionById`；运行中 409） |
| `hooks/useArchives.ts`、`components/ArchiveButton.tsx`、`components/ArchivesConfig.tsx` | 侧栏归档按钮 + 设置里的归档管理页 |
| `lib/session-delete.ts` | 从会话 DELETE 路由抽出的删除实现，供批量删除复用 |
| `hooks/usePins.ts` | 客户端状态：挂载时拉一次，之后采纳轮询捎带的 payload；乐观更新 + 失败回滚 |
| `components/PinButton.tsx` | 图钉按钮，`action` / `inline` 两种形态 |
| `lib/pin-order.test.mjs`、`lib/pin-store.test.mjs`、`lib/pin-fork-anchors.test.mjs`、`lib/pin-fork-seams.test.mjs` | pin 的纯逻辑 / 存储 / **锚点** / 排序接缝测试 |
| `lib/archive-order.test.mjs`、`lib/archive-store.test.mjs`、`lib/archive-fork-anchors.test.mjs`、`lib/archive-fork-seams.test.mjs` | 归档的纯逻辑 / 存储 / **锚点** / 过滤接缝测试 |
| `scripts/next-version.mjs`（+测试） | 版本号规则的唯一实现（见 §4） |
| `scripts/set-forked-from.mjs`（+测试） | 维护 `package.json.forkedFrom`，记录对应哪个上游构建（见 §5.2） |
| `scripts/deploy-pi-web.mjs` | 生产机 status / install / rollback，强制精确版本 + 显式 registry（见 §7.1） |
| `scripts/pi-web-start.bat` | Windows 常驻启动器（含 `PI_WEB_PIN` 锁版本），由计划任务调用（见 §7.2） |
| `scripts/bootstrap-production.ps1` | 生产机一键接入：体检 / 装包 / 部署启动器 / 建任务 / 安全切换（见 §7.5） |
| `scripts/pi-web.service` | Linux systemd 用户服务模板（见 §7.6） |
| `.github/workflows/sync-upstream.yml` | 同步 + 发版流水线（见 §5.2） |
| `.gitattributes` | `*.bat` / `*.cmd` 存 LF、签出 CRLF（cmd.exe 解析批处理对 LF 不稳） |
| `docs/FORK.md` | 本文件 |

**对上游文件的改动**（11 个文件；上游既有文件里共 21 处 `[pin-fork]` 标记。例外是 `package.json`：包名/版本/`publishConfig`/`forkedFrom`/脚本 本身就是自说明的，不加标记）

| 文件 | 上游改动频率 | 我们改了什么 |
|---|---|---|
| `components/SessionSidebar.tsx` | 高（48 次/90 天） | pin 接线 + 归档接线（`useArchives`、项目行归档按钮、轮询采纳 archives） |
| `lib/session-family.ts` | 极低（1 次） | 可选参数 `pinnedSessionIds` + 排序改为 pinned 优先 |
| `lib/project-groups.ts` | 极低（1 次） | 可选参数 `pinnedProjectKeys` + `archivedProjectKeys` 过滤 |
| `app/api/agent/running/route.ts` | 低（3 次） | 响应里捎带 `pins` 与 `archives` |
| `app/api/sessions/route.ts` | 低（5 次） | 列表加载时 `prunePins()` / `pruneArchives()` 清理孤儿 |
| `lib/app-update.ts`、`app/api/app-update/route.ts` | 极低（1、2 次） | 更新检查指向我们的包（见 §2.2） |
| `components/SessionSidebar.test.mjs` | 中（13 次） | 上游一条断言按新签名更新 |
| `lib/app-update.test.mjs` | 低 | 上游一条断言按新 Release URL 更新 |
| `package.json` | 中 | 包名、`publishConfig`、`forkedFrom`、`release:pin*` 脚本、测试 glob 加 `scripts/` |
| `.gitignore` | 低 | 拦住私有部署清单（`*.local.md`、`*.local.json`、`deploy/`，见 §0） |


**行为规定**

- 排序：**pinned 组在前，组内一律按最近活跃**（不按 pin 时间）。
- 项目 pin 的 key 用服务端算出的 `projectKey`（`workspaceKeyOf()`），**不用路径字符串**——Windows 大小写、分隔符、UNC 已由上游归一化。
- 会话 pin 的 key 是 `session.id`：改名保留、**fork 不继承**、删除即清理。
- 项目下已无会话时，其 pin 自动清理（与上游"项目列表只含有会话的目录"的立场一致）。
- 图钉与相邻的重命名/删除按钮**同一套视觉规格与出现规则**：桌面端在 hover 时随该组一起出现，**已置顶的行则常亮**作为标记；触屏设备（`useIsMobile()`）始终可见，因为没有 hover 就永远点不到。
- 跨设备同步**不开新连接**：蹭侧栏已有的 2.5 秒 `GET /api/agent/running` 轮询（`RUNNING_SESSIONS_POLL_MS = 2500`），所以任何一端 pin，其他端 ≤2.5 秒收敛。**限定条件**：该轮询只在标签页可见时进行（`document.visibilityState !== "visible"` 时暂停），所以被切到后台的标签页会在重新获得可见时收敛，而不是准时 2.5 秒。

### 2.2 项目归档（视图开关，不移动会话文件）

**动机**：侧栏「项目」不是 pi 的一等实体，只是会话按 `projectKey` 聚出来的视图。用户要的是「这个项目别出现在列表里」，不是删代码仓库。

**行为规定**

- 归档记录的 key 是服务端 `projectKey`，落在 `~/.pi/agent/pi-web/archives.json`。会话 `.jsonl` **原地不动**。
- 侧栏项目下拉过滤掉已归档项目；归档按钮在项目行上（与图钉并列）。删除会话**只在设置 → 归档**，侧栏没有删除项目。
- 设置里的归档节是全局页（不依赖当前 cwd）。详情列出该项目下的会话标题 / 时间 / 消息数。
- 删除这批会话：复用 `deleteSessionById`；该项目有正在运行的 agent 则 409；确认词为 `confirm` / 「确认」 / 「確認」。全部成功后才摘掉该项目的 pin 与归档记录。不删磁盘上的代码目录。
- 在已归档项目里新建会话、从搜索打开其会话、或用自定义路径进入，都会自动取消归档。
- 跨设备同样蹭 `/api/agent/running` 的 `archives` 字段。

### 2.3 更新检查重定向

上游的 `app-update` 检查写死在 `@agegr/pi-web`。若不改，界面会提示"升级到官方最新版"，**用户一点就把补丁升没了**。现在指向 `@pricening/pi-web` 与 `PriceNing/pi-web` 的 Release 页。

---

## 3. 补丁纪律（加新功能时必须遵守 —— 本节是唯一权威出处）

上游非常活跃（近 90 天 **573 次提交**，约 6 次/天，测量于 2026-09-17），所以**"改动放哪里"直接决定以后同步是
5 分钟还是 5 小时**。这一节是硬约束，不是建议。

### 3.1 流程：一个功能 = 一个分支 = 一个 commit

```bash
git checkout -b feat/<名字>          # 不要混进 feat/pin-project-and-session
# ...写代码...
npm run lint && npx tsc --noEmit && npm test     # 不要在本地 npm run build（Windows 会 OOM，见 §5.1）
git push -u origin feat/<名字>       # 开 PR，让 CI 在 ubuntu 上跑一遍（白捡 Linux 覆盖）
```

合并进 main 后 CI 自动发版；**先升一台 canary，再改其余机器的 `PI_WEB_PIN`**。
保持"单功能单 commit"是为了能单独 revert —— 上游哪天自己实现了同一件事，你要能干净地摘掉自己那一个。

### 3.2 代码放哪里（按优先级，从上往下依次退化）

| 顺序 | 做法 | 理由 |
|---|---|---|
| 1 | 新逻辑一律开**新文件**，绝不往大组件里塞 | 永不冲突 |
| 2 | 需要服务端状态 → 写 `~/.pi/agent/pi-web/<名字>.json`，照抄 `lib/pin-store.ts`（`proper-lockfile` 加锁 + 原子写 + 指纹缓存） | 与 pi 共享目录同生命周期，备份/迁移一起走 |
| 3 | 需要改行为 → 挂在**冷文件**的接缝上。近 90 天提交次数：`lib/session-family.ts` 1、`lib/project-groups.ts` 1、`lib/app-update.ts` 1、`app/api/agent/running/route.ts` 3、`app/api/sessions/route.ts` 5 | 冲突概率极低 |
| 4 | 实在要动**热文件** → 只允许"接线"级改动，每处加 `// [<功能>-fork]` 标记 | 把冲突面压到几十行内 |
| 5 | **绝不触碰**（见下表） | — |

热文件黑名单（近 90 天被改次数，测量于 2026-09-17；**这些数字会漂移，别照抄，要重算**）：

```bash
git fetch upstream
for f in components/ChatWindow.tsx components/AppShell.tsx lib/rpc-manager.ts hooks/useAgentSession.ts lib/i18n/messages/zh-CN.ts components/SessionSidebar.tsx lib/session-reader.ts lib/types.ts lib/session-family.ts lib/project-groups.ts lib/app-update.ts; do
  n=$(git log --since='90 days ago' --oneline upstream/main -- "$f" | wc -l)
  echo "$n  $f"
done | sort -rn
# 2026-09-17 实测（次数 文件）：90 ChatWindow / 76 AppShell / 73 rpc-manager / 67 useAgentSession
#   / 63 i18n zh-CN / 48 SessionSidebar / 31 session-reader / 20 types
#   / 1 session-family / 1 project-groups / 1 app-update   ← 后三个就是我们的接缝，几乎不动
```

**绝对禁止清单**：

| 禁止 | 原因 |
|---|---|
| 往 `lib/i18n/messages/*.ts` 加 key | 最热文件之一（zh-CN 63 次、en 62 次/90 天）且有 key 集对齐测试，每次同步必冲突。文案自带在组件里，用 `useI18n()` 的 `locale` 选 |
| 往 `lib/types.ts` 加字段 | 20 次/90天。要附加信息就在 API 层做结构类型转换或另建类型 |
| 写 `settings.json` / `auth.json` / `models.json` | 归 pi CLI 所有，两边写会互相覆盖 |
| 改 `sessions/` 下任何内容 | 破坏"与本地 pi 共享"的设计（§8） |
| 伪造 `modified` 等真实字段来骗排序 | 污染 pi 的真实数据。要置顶就改比较器（见 pin 的做法） |

### 3.3 每个新功能必须配套的四件事

1. 纯逻辑抽成**无依赖模块**，必须能被浏览器 bundle import（不得出现 `node:fs`、`node:path`、`next/server`）
2. 单元测试 + **一个锚点测试**（照 `lib/pin-fork-anchors.test.mjs` 写）：断言你挂的接缝仍然存在。
   这是防"**上游重构后功能静默失效、但测试全绿**"的唯一有效手段 —— 它宁可挡住发版，也不发一个坏包。
3. 更新本文档：§2 改动清单、§10 已知取舍
4. 若引入新的服务端状态文件，在 §8 的边界表里登记路径与理由

上游文件里被我们改到的既有断言，**同步改掉**（我们已经改过 2 处），不要留着红。

### 3.4 什么时候该拒绝一个需求

如果它要求重写热文件的大块逻辑（例如给虚拟化列表加分区标题 —— 行高写死 54px，插入 section 要改高度与窗口计算），
**先估冲突成本再动手**。我们已经因此放弃过一次（见 §10），那是合理取舍，不是失败。

### 3.5 心态：不再依赖上游接受任何东西

历史上 pin/收藏类 5 个社区 PR 全部被关闭未合并，所以我们不指望 `agegr` 收我们的 PR。
**fork 就是终点**，功能对不对由我们自己的 CI 门禁和生产机说了算。

## 4. 版本号与 tag 规则

**必须使用纯 `x.y.z`**，原因：上游的 `lib/app-update.ts` 用 `/^(\d+)\.(\d+)\.(\d+)$/` 解析，任何预发布后缀（如 `0.9.1-pin.1`）都会让"有更新"提示**永久失效**。

规则（唯一实现见 `scripts/next-version.mjs`）：

```
next = max(上游版本, 已发布最高版本 + 0.0.1)
```

- 刚同步完上游时，`next` 就等于上游版本号 → `npm info @pricening/pi-web version` 直接能看出对应哪个上游版本。
- 同一上游版本下要单独发我们的修复，就往上走 patch（0.9.1 → 0.9.2），**永不重复、永不倒退**。
- 真实对应关系由 git 记录：`forkedFrom.commit` + merge 历史 + tag `v<version>`。

Tag 约定：

| tag | 含义 |
|---|---|
| `v0.9.2` | 我们的发布（CI 自动打，并建 GitHub Release） |
| `upstream/v0.9.2` | （可选）为上游 tag 打的本地镜像 tag，便于 diff |

---

## 5. 发布流程

### 5.1 发布通道：OIDC（当前状态 —— 仓库内**没有任何 secret**）

已实测确认（v0.9.6）：在 `gh secret list` 为空的情况下，CI 仍成功发出
`+ @pricening/pi-web@0.9.6`，且走的是 `尝试 Trusted Publishing (OIDC)` 分支。
即：无 token、不会过期、附带 provenance 证明，也不受 npm「2027-01 起绕过 2FA 的
granular token 不得直接发布」影响 —— 我们本来就不走那条路。

> **为什么不在本地发（实测）**：`npm run build`（webpack 生产构建）在本机 Windows 上会 OOM ——
> 默认 4 GB 堆约 3.5 分钟崩一次；给到 `--max-old-space-size=8192` 与 `12288` 时，
> 约 14 分钟后仍因堆耗尽失败（`Ineffective mark-compacts near heap limit`）。
> 同一份代码在 ubuntu-latest 上约 2 分钟构建完成。
> **结论：构建与发布只在 CI 里做**，本地只跑 `npm run dev` 预览与 `npm test`。

信任关系配置（npm 包页面 → Settings → Trusted publishing；**建好不能改，只能删了重建**）：

| 字段 | 值 |
|---|---|
| Organization or user | `PriceNing` |
| Repository | `pi-web` |
| Branch | `main` |
| Workflow filename | `sync-upstream.yml` ← **只填文件名，大小写敏感，不带路径** |
| Environment name | 留空 |
| **Allow npm publish** | ☑️ 必须勾（不勾则只允许 `npm stage publish`） |

#### 历史：当初如何破冰（重建时参考，已完成）

Trusted Publishing 要在**包页面**上配置，而包页面只有发布过一次之后才存在，所以上面这条路
需要一次性破冰：

1. 建一个**勾选 Bypass 2FA** 的 granular token（普通 token 会被账号 2FA 策略以 `403` 拒发）
2. `gh secret set NPM_TOKEN` → 手动触发 workflow 发首版
3. 去包页面配好 Trusted Publishing → `gh secret delete NPM_TOKEN` → 在 npm 页面 revoke 该 token
4. 再触发一次发版，确认日志是 OIDC 分支且没有走兜底 —— 到这一步才算真正拆掉梯子

> 两个花了很久才定位的坑：
> - **不勾 bypass 的 token 发不了**：`403 ... bypass 2fa enabled is required to publish packages`；
>   同理 web login 的 CLI token 也改不了 dist-tag（实测 403）。副作用：stale 的 `next: 0.9.1`
>   tag 现在删不掉，只能忽略（没人会装 `@next`，且 0.9.1 也是合法构建）。
> - **Node 22 自带的 npm 10.x 没有 OIDC 代码路径**，`npm publish --provenance` 只会报 `ENEEDAUTH`，
>   现象和「trusted publisher 没配对」完全一样。workflow 已固定先 `npm install -g npm@11` 并打印版本。

### 5.2 日常：CI 自动同步 + 发版（`.github/workflows/sync-upstream.yml`）

每天 14:30（北京时间）+ 可手动触发（`force_publish` 可跳过「无新东西」判断）：

```
fetch upstream → merge → 写 forkedFrom → npm ci → lint → tsc → npm test（含锚点测试）
→ 算版本 → 升级 npm → next build → npm publish（OIDC）→ npm pack
→ 打 tag 并 push main → GitHub Release（附 tarball）
```

要点：

- 任何一步失败：**不推送、不发版**（已实战验证：某次发布成功但 Release 步骤失败时，
  tag 与 main 都没被动过，失败是干净的）。
- **`forkedFrom` 自动维护**：上游会提交代码而不 bump 自己的版本（HEAD 一直在动而 version
  停在 0.9.1），所以「对应哪个上游构建」只能靠这个字段记录，手写一天就过期。
  由 `scripts/set-forked-from.mjs` 负责。
- **不会重复发空版**：只有「上游有新提交」或「仓库版本 ≠ 已发布版本」才发。这里曾写错成
  比较 `next` 与 `published`，而版本规则保证 `next` 永远更大，会导致每天发一个内容相同的空版本。
- **OIDC 优先，失败不静默降级**：兜底分支只在 `NPM_TOKEN` 存在时才生效；现在没有 secret，
  所以 OIDC 一失败就直接变红，不会默默发出一个没有 provenance 的包而无人察觉。

### 5.3 灰度：放在安装层，不放在 registry tag 层

**不要用 `--tag next` 做灰度**，两条实测理由：

1. 首次发布时即使 `npm publish --tag next`，npm **仍会创建 `latest`** —— `next` 通道拦不住任何人。
2. 事后把 `latest` 挪回去需要"能改 dist-tag 的凭据"：普通 token 被 2FA 策略挡掉（实测 403），
   而 Trusted Publishing (OIDC) **只能发布、不能改 tag**。也就是说这条收口路径不可持续。

所以灰度改由**安装层**保证，效果等价且不需要任何额外凭据：

```powershell
# ① 只升 canary 一台（显式版本号）
npm i -g @pricening/pi-web@<版本> --registry=https://registry.npmjs.org/
# ② 用一天，确认没问题
# ③ 再改部署脚本里的 PINNED_VERSION，其余机器才会升
```

关键前提：**生产机永远按精确版本安装**（见 §7）。这样 registry 上有没有 `latest`
都不重要 —— 没有任何机器会自动跟进，坏版本最多影响 canary 一台。

---

## 6. 上游同步

### 6.1 CI 自动成功时

什么都不用做。

### 6.2 CI 报冲突时（本地手工）

```bash
git fetch upstream --tags
git merge upstream/main
# 解决冲突：优先保留上游实现，再把 [xxx-fork] 接线重新插回去
npm run lint && npx tsc --noEmit && npm test
git push origin main
```

冲突处理提示：

- `SessionSidebar.tsx` 是唯一高频冲突点。解决后**必须重跑 `npm test`**，锚点测试会告诉你哪根线掉了。
- 上游若把 `listSessionFamilies` / `getRecentProjects` 改名或删掉：不要保留旧函数名，把 pin 参数搬到新函数上，并同步改 `lib/pin-fork-anchors.test.mjs`。
- 上游若自己实现了 pin/收藏（维护者多次提到"要重新设计会话组织"）：**立即停用我们的补丁**，回归纯镜像，把 `package.json` 的改动缩到只剩包名与更新检查。

---

## 7. 生产机部署与回滚

### 7.1 一次性安装 / 升级 / 回滚

```powershell
# 推荐用本仓库的助手：它会强制精确版本、显式 registry，并提醒官方包冲突
node scripts/deploy-pi-web.mjs status            # 本机版本 + 最新可装版本
node scripts/deploy-pi-web.mjs install <版本>   # 安装/升级（canary 一台）
node scripts/deploy-pi-web.mjs rollback <版本>   # 回滚（同样是精确版本）

# 它等价于：
npm i -g @pricening/pi-web@<版本> --registry=https://registry.npmjs.org/

# 拉不到 npm 时，用 GitHub Release 的 tarball 兜底
npm i -g .\pricening-pi-web-<版本>.tgz
```

从官方版切换过来的正确顺序（**先卸后装**）：

```bat
npm uninstall -g @agegr/pi-web
npm i -g @pricening/pi-web@<版本> --registry=https://registry.npmjs.org/
```

为什么不能先装后卸（**Windows 与 Linux 均已实测**）：两个包的全局 bin 垫片**同名**（`%APPDATA%\npm\pi-web.cmd/.ps1`），
官方包在位时 `npm i -g @pricening/pi-web` 会**直接失败**（Linux 上是同一个坑，只是形式为 `<npm prefix>/bin/pi-web` 符号链接）：

```
npm error EEXIST: File already exists  →  Remove the existing file and try again,
                                          or run npm with --force to overwrite files recklessly.
```

而且失败后会留下一个半成品安装（`npm ls -g` 里显示 `@pricening/pi-web@` 且版本为空），
必须先 `npm uninstall -g @pricening/pi-web` 再重来。所以：

- **正在运行的机器**（不能先卸官方，否则服务断）：`npm i -g @pricening/pi-web@<版本> --force` 装 fork
  → 切换启动器 → 停旧起新 → **确认 fork 已在服务后**再卸官方包（参考一次性脚本 `pi-web-cutover.ps1` 的顺序）
- **能停机的机器**：老实按上面的顺序先卸后装，不用 `--force`

另：卸载其中一个包时，npm 会把**共享的 `pi-web` 命令垫片一并删掉**（即使另一个包还在）。
`scripts/pi-web-start.bat` 用绝对路径 `node ...\bin\pi-web.js` 启动，不依赖那个垫片，所以服务不受影响；
但手动敲 `pi-web` 会失效。

> **实测修复方法（真实切换时踩过）**：服务在跑的时候，`npm i -g @pricening/pi-web --force` 会
> 报 `EBUSY: resource busy or locked, rename ...\@pricening\pi-web -> ...\.pi-web-xxxx`（Windows 下
> 运行中的包目录改不了）。正确的补刀是**不重装、只重建链接**，无需停机也不会掉会话：
> ```powershell
> npm rebuild -g @pricening/pi-web     # 恢复 pi-web / pi-web.cmd / pi-web.ps1 三个垫片
> ```

### 7.2 常驻启动：`scripts/pi-web-start.bat`

本仓库的 `scripts/pi-web-start.bat` 是**规范副本**，部署到跑 pi-web 的机器上并让计划任务指向它：

```bat
copy /Y scripts\pi-web-start.bat "%USERPROFILE%\Desktop\pi-web-start.bat"
schtasks /Create /TN pi-web-server /TR "\"%USERPROFILE%\Desktop\pi-web-start.bat\"" /SC ONSTART /RU <用户> /RP /RL HIGHEST /F
schtasks /Run /TN pi-web-server
```

它做的事：定位 node/npm/全局前缀 → 缺包就装 → 有新版就升 → 启动 → 写日志。
排错用 `pi-web-start.bat --check`，会打印解析到的 node / npm / prefix / registry / 入口路径 / 已装版本。

可用环境变量：

| 变量 | 作用 |
|---|---|
| `PI_WEB_HOSTNAME` / `PI_WEB_PORT` | 监听地址（默认 `0.0.0.0` / `30141`） |
| `PI_WEB_LOG` | 日志文件（默认 `%LOCALAPPDATA%\pi-web\logs\pi-web-start.log`） |
| `PI_WEB_PASSWORD` | 开启登录鉴权；`0.0.0.0` 若能被可信网络之外访问就必须设 |
| **`PI_WEB_PIN`** | 锁定精确版本并**跳过自动升级** |

> ⚠️ **生产机必须设 `PI_WEB_PIN`**。这个 launcher 每次开机都会跑一遍，而 fork 的 `@latest`
> 是 CI 自动发布的 —— 不设锁就等于把「上游提交 → CI 构建 → 自动发 npm → 所有机器下次开机
> 自动吸收」连成无人值守的一条链。CI 门禁能挡住编译/测试失败，挡不住"全绿但行为不对"。
> 例外：canary 那台不设 `PI_WEB_PIN`，让它自动吃 `@latest`，正是它的用途。

### 7.3 Windows 上踩过的坑（都已实测）

| 坑 | 现象 | 结论 |
|---|---|---|
| `Start-Process pi-web` | `%1 is not a valid Win32 application` | npm 的全局垫片是 `pi-web.ps1`，不能当可执行文件启动。必须 `node <prefix>\node_modules\@pricening\pi-web\bin\pi-web.js`（launcher 就是这么做的） |
| 用 SSH 起分离进程 | `Start-Process` / `Win32_Process.Create` 起的进程随 SSH 会话回收而死 | 常驻只能靠计划任务（或服务），不要指望远程会话里后台拉起 |
| 只读镜像 | `npm login` / `npm publish` 打到镜像报 409 `user registration disabled`；新 scoped 包安装 404 | `~/.npmrc` 的 `registry` 是全局的，launcher 与文档里的每条 npm 命令都显式带 `--registry` |
| 防火墙 | 30141 入站从别的机器不通 | 远程验证要在目标机本机做（`Invoke-WebRequest http://127.0.0.1:30141/...`） |
| 本地构建 | `npm run build` 在 Windows 上 OOM（见 §5.1） | 构建/发布只在 CI；本机只跑 dev 预览和 `npm test` |

### 7.4 切换后的自检

```powershell
# 服务是否活着、pin 接口是否存在（旧版官方版没有这个路由，可用来确认切换成功）
(Invoke-WebRequest http://127.0.0.1:30141/api/pins -UseBasicParsing).Content
# 期望：{"sessions":[],"projects":[]}
```

规定：

- **精确版本号安装**，禁止 `^` / `latest` 落到运维脚本里；版本记录在部署仓库里，让"谁升到了哪"可审计。
  `deploy-pi-web.mjs install` 会直接拒收非 `x.y.z` 的参数，launcher 用 `PI_WEB_PIN` 表达同一约束。
- 同一台机器**只保留一个** pi-web 包（原因见 §7.1）。
- 升级前先停服务：`pi-web` 会 idle 回收 AgentSession，但 `node-pty` 终端会话会断。
- 数据安全：卸载/升级**不会动 `~/.pi/agent/`**，会话、配置以及 `pi-web/pins.json`（置顶记录）都完整保留，本地 pi CLI 不受影响。
- `PI_WEB_SKIP_VERSION_CHECK=1` 现在**不再是必须**（更新检查已指向我们自己的包），但如果你不希望界面出现任何升级提示，它仍是有效的开关。

### 7.5 一键接入新的生产机：`scripts/bootstrap-production.ps1`

在**仓库检出目录**里用管理员 PowerShell 运行。幂等，可反复跑；默认不碰正在运行的服务。

```powershell
.\scripts\bootstrap-production.ps1 -Check        # 只体检，什么都不改
.\scripts\bootstrap-production.ps1              # 装 fork + 部署启动器 + 建开机任务
.\scripts\bootstrap-production.ps1 -Pin <版本>  # 同上，并锁到精确版本（推荐生产机），例：-Pin 0.9.6
.\scripts\bootstrap-production.ps1 -RestartNow  # 立刻从官方包切到 fork（会断当前 pi-web 会话）
```

它会做并且只做这些判断：

- 官方包还在位时装 fork 会自动带 `--force`（否则 npm 因共享 bin 垫片 `EEXIST` 直接失败）
- 启动器落点自动在 `%USERPROFILE%`、`%USERPROFILE%\Desktop`、公共桌面里找现有文件；找到旧版**先带时间戳备份**再覆盖（备份永不覆盖）
- 已有同名计划任务但指向别的东西时**直接报错停手**，不猜
- `-RestartNow` 的顺序是：停任务 → 停官方进程 → 起 fork → **确认 fork 在监听** → 才卸官方包 → 再 `npm rebuild -g` 补回被一起删掉的 `pi-web` 垫片；fork 起不来就抛错并保留官方包与备份，绝不留下"两头都没了"的状态

> ⚠️ 如果你正是通过那台机器的 pi-web 在操作它，`-RestartNow` 等于自断。那种情况改用一次性计划任务在进程外执行（本次主机切换就是这么做的），或者直接重启机器。

---

### 7.6 Linux 机器：systemd 用户服务（无需 launcher）

模板在 `scripts/pi-web.service`。切换一台已装官方包的 Linux 机器的完整顺序（已在真实机器上验证）：

```bash
# 1) 装 fork —— 官方包在位时必须 --force，否则 EEXIST 失败
npm i -g @pricening/pi-web@<版本> --registry=https://registry.npmjs.org/ --force
readlink -f ~/.npm-global/bin/pi-web          # 应指向 @pricening/pi-web/bin/pi-web.js

# 2) 重启服务并确认是 fork
systemctl --user restart pi-web
curl -s http://127.0.0.1:30141/api/pins       # 返回 JSON 才是 fork；404 说明还是官方包

# 3) 才卸官方包
npm uninstall -g @agegr/pi-web

# 4) 检查链接是否被一起删掉（实测会被删），删了就 rebuild
[ -e ~/.npm-global/bin/pi-web ] || npm rebuild -g @pricening/pi-web
systemctl --user restart pi-web && systemctl --user is-active pi-web   # 卸完做一次冷重启验证
```

要点：

- **`loginctl enable-linger $USER` 是关键**。用户级服务默认只在登录后运行，开了 linger 才真正开机自启。
- Linux **不需要 launcher 脚本**：systemd 不做 `npm update`，版本天然锁定；升级必须显式
  `npm i -g @pricening/pi-web@<版本> && systemctl --user restart pi-web`。这等价于 Windows 侧
  `PI_WEB_PIN` 的效果，无需额外配置。
- `ExecStart` 指向 npm 全局 bin 的**链接**而非包内绝对路径，这样升级/重装不用改 unit。
- 快速判断"服务的是哪个构建"：`curl -s http://127.0.0.1:30141/api/pins` —— 官方包没有这个路由，
  会返回 Next 的 404 HTML。

---

## 8. 与 local pi 共享状态的边界（红线）

pi-web 的优秀设计是**与本地 pi 共享 `~/.pi/agent`**。我们绝不破坏它：

| 允许 | 禁止 |
|---|---|
| 在 `getAgentDir()/pi-web/` 子目录下写自有状态（先例：上游自己的 `pi-web-session-index.json`；本 fork 另有 `pins.json`、`archives.json`） | 写 `settings.json`、`auth.json`、`models.json`（这些归 pi CLI 所有，两边写会互相覆盖） |
| 只读 `sessions/` 下的会话 | 修改任何会话 `.jsonl` 内容或元数据 |
| 用 `getAgentDir()` 取路径，从而跟随 `PI_CODING_AGENT_DIR` 一起迁移 | 写死 `~/.pi/agent` |
| 附加纯展示性元数据（pin / archive） | 伪造 `modified` 等真实时间字段来骗排序 |

pin / archive 数据落在 `~/.pi/agent/pi-web/{pins,archives}.json`：备份/迁移 agentDir 时自动跟着走；pi CLI 不枚举未知文件，所以对它完全不可见。归档**不移动** `sessions/` 下的 jsonl。

---

## 9. npm 认证政策（当前状态）

| 场景 | 用什么 | 备注 |
|---|---|---|
| CI 发版 | **Trusted Publishing (OIDC)** —— 唯一通道 | 无 secret、无过期、带 provenance。已在 v0.9.6 实测（仓库 secrets 为空仍发布成功） |
| 本机应急发布 | **web login**：`npm login --registry=https://registry.npmjs.org/ --auth-type=web` | 2FA 走交互（通行密钥），不绕过。注意本机 `~/.npmrc` 若指向只读镜像，必须显式带 `--registry` |
| CI 兜底 token | **当前不存在**（已删除并 revoke） | 重建见 §5.1「历史：如何破冰」 |

三条实测出来的硬约束（别凭直觉配置）：

1. **账号开启"发布需要 2FA"后，普通 granular token 发不了**（`403 ... bypass 2fa enabled is
   required to publish packages`）。能发的只有勾了 Bypass 2FA 的 token —— 而 npm 已公告
   **2027-01 起这类 token 不再允许直接发布**。所以"建个普通 token 当兜底"这个直觉是错的，
   兜底要么用 bypass token（临时、用完即撤），要么没有。
2. **dist-tag 操作同样要 2FA 级凭据**：web login 的 CLI token 执行 `npm dist-tag rm` 实测 403。
   因此灰度不能设计成"CI 发 `next`、人工提升 `latest`"（提升这步没人能做），只能放在安装层（§5.3）。
3. **Node 22 自带 npm 10.x 不支持 OIDC**，`npm publish --provenance` 报 `ENEEDAUTH`，与"没配好
   trusted publisher"现象相同。CI 里必须先 `npm install -g npm@11`。

---

## 10. 已知取舍

| 未做 | 原因 |
|---|---|
| 置顶分区 / 可折叠 "Pinned" 标题 | 会话列表是虚拟化的（行高写死 54px），插 section header 要在热文件改高度与窗口计算，冲突面暴涨。当前实现是"直接排到最前" |
| 打开页面默认选中"置顶的项目" | 首屏项目自动选择在 effect 里，改它要动依赖数组；目前默认项目仍按最近活跃 |
| 会话级归档 / 把 jsonl 挪到 archive 目录 | 本 fork 的归档是**项目视图开关**，文件仍留在 pi 的 `sessions/`；真删只发生在设置→归档页 |
| 侧栏直接「删除项目」 | 项目不是实体。侧栏只归档；删会话必须进设置页，并输入「确认」或 `confirm` |
| 删除磁盘上的代码仓库 | 明确不做。归档页文案写清「不会删除工作区代码」 |
| 多服务器间同步 pin | 我们的 pi-web 只有一台服务器，服务端存储已满足跨设备。若将来多实例，把 `~/.pi/agent` 放共享存储即可 |
| 清掉 npm 上 stale 的 `next: 0.9.1` tag | 需要 2FA 级凭据，而 bypass token 已 revoke、CLI 又只能吃 TOTP（我们用的是通行密钥）。影响为零，见 §9 第 2 条 |
| 本地 Windows 构建 | `npm run build` 会 OOM（§5.1）。构建与发布只在 CI 做，本地只跑 dev 与测试 |

---

## 11. 每次同步后的最小验证清单

```bash
npm run lint
npx tsc --noEmit
npm test          # 必须包含 lib/pin-fork-anchors.test.mjs 与 lib/archive-fork-anchors.test.mjs 全绿
```

**不要在本地跑 `npm run build`**（见 §5.1 的 OOM 实测）；构建属于 CI。

手工抽查（2 分钟）：

1. 侧栏项目下拉：图钉出现、点击置顶、顺序变化、刷新后仍在
2. 会话行：hover 时图钉与重命名/删除同框；已置顶行常亮
3. 手机/Pad 打开同一实例：一端 pin，另一端在**标签页可见时** ≤2.5 秒自动置顶（切到后台的标签页要等回到前台）
4. `~/.pi/agent/pi-web/pins.json` 内容符合预期；删掉一个已 pin 会话后其记录消失
5. 侧栏项目行可归档，项目从下拉里消失；设置 → 归档能看到它、能取消归档；删除须输入「确认」或 `confirm`，且不删代码目录
6. `~/.pi/agent/pi-web/archives.json` 内容符合预期；该项目下会话全部删掉后归档记录被 prune
7. `node scripts/deploy-pi-web.mjs status` 能看到新版本；`node -p "require('./package.json').forkedFrom.commit"` 已指向上游最新 commit；CI 发布日志出现 `✅ OIDC 发布成功`（不是兜底分支）

---

## 12. 两个高频问题

### 12.1 上游发布了新功能/新版本，之后会发生什么？

**默认路径：你什么都不用做。**

```
上游提交/发版
  → CI 每天 14:30 拉取并 merge 进我们的 main
  → 门禁：lint + tsc + 全量测试（含锚点测试）
  → 干净通过 → 构建 → OIDC 发 npm（@latest）→ 打 tag + Release（附 tarball）
  → 生产机下次开机（或重启服务）自动吸收 @latest
```

你需要**主动看一眼**的三种情况：

1. **CI 变红（合并冲突）**：日志会点名可能涉及的文件。按 §6.2 本地 merge 一次即可。
   特别注意：若冲突在 `package.json` 的 `version` 行，**保留我们自己的序列**（`forkedFrom` 由 CI 自动写）。
2. **上游自己实现了 pin / 收藏**（维护者多次提到要"重新设计会话组织"）：**立刻停用我们的补丁**，
   否则两套置顶逻辑会打架。做法：合并后
   ```bash
   # 只看我们挂接缝的那几个文件，避免上游 "pinned models" 之类无关用词造成误报
   git grep -in "pinned\|favorite\|archive" upstream/main -- components/SessionSidebar.tsx lib/session-family.ts lib/project-groups.ts lib/types.ts app/api/sessions
   # 2026-09-17 实测该命令输出为空；若某天有输出，说明上游在自己的实现里碰到了同一块地
   ```
   有实质命中就把 `feat/pin` 那个 commit 从 main 上 revert 掉，`package.json` 只保留包名与更新检查两处改动，
   继续跟上游发版。这样 fork 退化成"官方包的镜像发布渠道"，仍然自洽。
3. **上游删掉/改名了我们依赖的函数**：锚点测试会红，这是**故意设计**的失败 —— 它宁可挡住发版，
   也不发一个"pin 已经静默失效但没人知道"的版本。修法是把接缝搬到新位置，并同步更新
   `lib/pin-fork-anchors.test.mjs` 与 §2 的清单。

**出问题怎么退**：

```powershell
npm i -g @pricening/pi-web@<上一个可用版本> --registry=https://registry.npmjs.org/   # 回滚
```
置顶数据存在 `~/.pi/agent/pi-web/pins.json`，**与包版本无关**，回退不丢数据；GitHub Release 上每个版本的 tarball 永久保留，可离线安装。

### 12.2 我自己又有了新需求，怎么做？

**规则全部在 §3（唯一权威出处）**，那里有：流程、代码放置优先级、热文件黑名单、绝对禁止清单、
必须配套的四件事、以及"什么时候该拒绝一个需求"。

最短起手式：

```bash
git checkout -b feat/<名字>
npm run lint && npx tsc --noEmit && npm test     # 别在本地 build
git push -u origin feat/<名字>                   # 开 PR 拿 Linux 覆盖
```

然后按 §3.3 补齐四件套，合并后 CI 自动发版，先升 canary 再推 `PI_WEB_PIN`。
