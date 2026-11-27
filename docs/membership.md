# 会员登录与注册（Better Auth 邮箱登录）

2026-11-26 上线正式站（v0.2.36 起）。读者输入邮箱，收到一封登录链接，点开即登录；新邮箱自动注册为读者。无密码。

## 1. 它怎么工作

```
/register 或顶栏「登录」下拉框
  → POST /api/ba/sign-in/magic-link        Better Auth（只负责验证邮箱与限频）
  → 腾讯云邮件推送发信（模板，链接 https://域名/{{url}}）
  → 读者点链接 → /api/ba/magic-link/verify → /api/ba-session（桥接）
  → 读/写成员记录 member:<邮箱>（中心库 web_inbox，kind=kv）
  → 签发原有的 session JWT cookie（HS256，180 天，带 tokenVersion）
  → 注销 Better Auth 自己的临时会话
```

- **成员体系没变**：成员记录、`session` cookie、`/api/auth/me`、`/admin`、`/oauth` 都照旧；已有成员邮箱相同即「平移」，角色与 `tokenVersion` 不变（不踢其他设备）。
- Better Auth 的库是单独的 D1 `openguji-auth`（user／session／account／verification／rateLimit 表），**只经 Worker 网关 `POST /v1/auth/d1`**（`auth` 角色令牌），站点不持有 D1 令牌。表结构迁移：`nextjs/scripts/ba-d1-migrate.mts`。
- 全部代码是全栈构建里的 `*.ssr.ts`（静态导出不打包）：`nextjs/src/lib/server/ba-*.ssr.ts`、`d1-http.ssr.ts`、`app/api/ba/[...all]`、`app/api/ba-session`。
- 界面：顶栏 `AccountMenu`（未登录是「登录」按钮，点开下拉邮箱框；登录后是人形图标）、`/account` 用户页（信息、登出）、`/register`（含错误提示）。

## 2. 开关与环境变量（EdgeOne Pages，构建时烘进去，改了要重新构建）

| 变量 | 作用 |
|---|---|
| `BA_ENABLED=1` | 总开关；不是 1 时 `/api/ba*` 回 404，现有邀请制登录完全不受影响 |
| `BA_REGISTRATION_OPEN=1` | 开放注册；关时只有已是成员的邮箱会收到信（回包一律成功，不暴露邮箱是否存在）；被管理员移除（墓碑）的邮箱永远不能自助回来 |
| `BETTER_AUTH_URL` | 本站地址（正式站 `https://www.openguji.com`）；仓里不写死域名（`ops/tests/hosts.test.mjs` 会拦） |
| `BETTER_AUTH_SECRET` | 正式站、测试站**各用各的** |
| `BA_AUTH_URL`／`BA_AUTH_TOKEN` | Worker 网关地址与 `auth` 角色令牌 |
| `AUTH_JWT_SECRET` | 原有的 session 签名密钥（桥接也用它） |
| `WEB_INBOX_TOKEN` | 读写成员记录的 Worker `web` 角色令牌；没配回落 `FEEDBACK_ADMIN_TOKEN`。测试站与正式站读写**同一个**成员库 |
| `MAIL_PROVIDER` | `tencent`（默认）｜`resend`｜`log`（只记日志不发，联调用） |
| `MAIL_FROM` | 发信地址，格式 `开源古籍 <login@mail.openguji.com>` |
| `TENCENT_SECRET_ID`／`TENCENT_SECRET_KEY` | CAM 子账号 `web-ses` 的密钥（权限仅邮件推送） |
| `TENCENT_SES_TEMPLATE_ID` | 登录邮件模板 ID（见 §3） |
| `TENCENT_SES_REGION` | 发信域名验证所在地域。**本站是 `ap-hongkong`**，必须设（代码不写默认值：构建的泄露扫描会把与变量同值的字面量当泄露，构建会红）；没设就不发信只记日志；地域不对腾讯回 `FailedOperation.SendEmailErr`（「请检查 Region 参数」） |

## 3. 登录邮件模板

腾讯云邮件推送只能用模板发信，且审核要求**链接保留确定域名**，变量不能是整条网址。模板源文件 `docs/mail-templates/login-link.html`，链接写成 `https://www.openguji.com/{{url}}`；代码只传 `url`＝验证地址去掉域名与开头斜杠后的路径与参数。模板里不要放注释（收件人看得见）。改模板要重新提交审核（约 1 个工作日），通过后换 `TENCENT_SES_TEMPLATE_ID`。

## 4. 限频

按客户端 IP 分桶（`eo-connecting-ip`／`x-forwarded-for`），存认证库：同一 IP 10 分钟最多 3 封登录邮件，其余接口 1 分钟 20 次。魔法链接 10 分钟有效、只能用一次。

## 5. 权限（caps）

成员记录可带 `caps`，`/api/auth/me` 返回生效的权限（`edge-functions/api/auth/caps.js`）：read、img.view、img.hires、img.unlimited、review.submit、review.approve、feedback.manage、member.manage、admin.panel。角色是预设（reader／reviewer／editor／admin），单项可另授（来源 grant／paid／review-score／occupation，可带到期、可撤销）。**目前只有 `/api/auth/me` 返回它，书影分级、审阅准入等还没有按它拦。**

## 6. 排障

| 现象 | 看什么 |
|---|---|
| `/api/ba/sign-in/magic-link` 回 500 | 响应是带原因的 JSON。多半是读成员记录的令牌（`WEB_INBOX_TOKEN`）在 Worker 上无效，或 Worker 网关不可达 |
| 回 200 但没收到信 | 先看垃圾箱；邮箱不是成员且注册关着（设计如此）；`FailedOperation.SendEmailErr` 看地域；腾讯控制台「发送统计」（有延迟） |
| 点链接回 `/register?error=expired` | 链接已用过或超过 10 分钟 |
| `error=blocked` | 邮箱已被管理员移除，或注册关着而邮箱不是成员 |
| `error=config`／`server` | `AUTH_JWT_SECRET` 没配／桥接读写成员库失败 |
| 紧急关闭 | 把 `BA_REGISTRATION_OPEN` 改 0 重新构建（已有成员仍可登录）；全关设 `BA_ENABLED` 为空（回到纯邀请制）；整站回滚用上一版产物重新晋升 |

测试站联调：邮件里的链接固定写正式站域名，所以在测试站发的信点开会落到正式站；联调时用脚本从认证库取出 token，直接访问测试站自己的 `/api/ba/magic-link/verify?token=…&callbackURL=/api/ba-session`。

## 会员号与提交带会员身份

- **会员号是整站唯一的会员 ID**：8 位＝7 位随机＋1 位校验，字母表是 Crockford Base32 去掉易混的 I L O U（`0-9 A-H J K M N P-T V-Z`）。存储用紧凑形式 `K7QM2XR9`，给人看写成 `K7QM-2XR9`。它随机生成，不由邮箱推出，改邮箱也不变。
- 存在成员记录 `member:<email>.code`；全站唯一靠索引键 `membercode:<号>` → email，发号时先查后写（中心库没有原子「不存在才写」，两人同一毫秒抽到同一号才会撞，量级可忽略）。老成员第一次提交或访问 `/api/auth/me` 时懒补，写后回读。删除墓碑、改角色、重新加入都保留会员号。
- 校验位只防抄错念错：奇数权重（1,3,5,7,9,11,13）加权求和 mod 32，单字符错必被发现，相邻互换几乎都发现；它不是密码，别当凭证用。`normalizeMemberCode()` 宽容输入：大小写、横线、空格、O→0、I/L→1。
- 用户在 /account 页看到并能一键复制会员号；报 bug、反馈时附上它，我们按号反查（索引键 `membercode:<号>` 取到邮箱）。
- 身份只从已验签的 `session` cookie 来（`memberFromRequest`，含 tokenVersion 校验），请求体里的任何自报身份一律不采信。
- 精校票（cellreview）、改字（charfix）、讨论（thread）：登录会员 `voter = 会员号`（8 位，跨设备同一票）；匿名仍是 `sha256(aid|ip)` 前 16 位。下游凭长度区分：8 位＝会员，16 位十六进制＝匿名。（11-27 有数小时 voter 是 36 位 UUIDv7，那批票待迁移；成员记录里若有 `uid` 字段就是那个旧别名。）
- 反馈：记录带 `member: <会员号>`；公开读剔除该字段，邮箱后台按号反查。
- 公开数据显示：绝不出邮箱；有昵称显示昵称，否则显示会员号。

### 回填与迁移（一次性）

`.github/workflows/member-code-backfill.yml`（手动，默认 dry_run）：给没有会员号的会员发号并写索引；把 voter 是 UUID 的精校票／改字／讨论迁成会员号（旧键删掉；cellreview 的 Worker 不许删，旧键列在 summary 里请整理侧清）；反馈记录里的 `member` UUID 改成会员号。summary 只出计数和会员号，不出邮箱。要等会员号版上线正式站后再真跑。

## 昵称

- /account 页「昵称」栏可设置或清除（最多 20 字，空串＝清除），接口 `POST /api/auth/nickname`（边缘函数 `auth/nickname.js`），身份只认验签 session cookie，只改成员记录的 `nickname`，其余字段原样保留。
- 昵称会在公开处显示，所以拒绝：像邮箱或网址的、含 `@ < >` 的、控制字符与双向控制符；全角半角先归一，连续空白合并。
- 新注册时在登录表单里填的昵称沿用原有逻辑（只在首次注册写入）。
