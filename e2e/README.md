# 生产验收测试（e2e）

打的是**线上真站点**，不是本地 dev server。deploy.yml 的 `verify` job 在部署
完成后跑它，用来回答一个问题：这次发布有没有把用户实际看到的东西弄坏。

```bash
npm ci
npx playwright install --with-deps chromium

npm run test:contract     # 纯 HTTP，几秒，先跑这层
npm run test:ui           # 真实浏览器
npm run test:degradable   # 可降级依赖（搜索 L1），不阻断发版
npm run report            # 看上一次的 HTML 报告

TARGET=http://localhost:3000 npm run test:ui   # 打本地
```

## 三层的分工

| project | 位置 | 查什么 | 红了意味着 |
|---------|------|--------|-----------|
| `contract` | `contract/` | 数据管线、搜索后端、站点产物自述 | 数据没上线 / 部署没生效 |
| `ui` | `ui/` | 用户在浏览器里实际看到的内容 | 页面回归 |
| `degradable` | `degradable/` | 搜索 L1（Meilisearch） | 只记录，**不阻断发版**（前端有 L2 兜底） |

## 写用例前必读：别制造假红

这套东西是发版门禁。它红一次，就有人要停下手里的事来看。所以**用例红必须
等于线上真出问题**——为别的原因红，等于训练所有人忽略红灯，真回归就被淹没。

已经踩过的两个坑，都有现成机制，写新用例时照着用：

### 1. 断言新版 UI 行为 → 加版本门禁

`verify` 跑的是**仓里当前 commit 的 e2e**，打的是**刚部署上线的站点**。
先提交用例、后提交 `book-index-ui` 版本升级，中间那次部署必然红：用例要的
行为还没上线。2026-09-05 一天内因此红了两次（#177 / #179）。

站点 `<meta name="bim-ui-version">` 暴露实际打包的版本，声明一下就好：

```ts
test.describe('人物页', () => {
    test.beforeEach(({ request }) => requireUiVersion(request, '0.7.2', '人物页重构'));
    // ...
});
```

线上比 0.7.2 旧就跳过，升上去后自动生效。用例于是可以随重构一起先落 main。

### 2. 依赖「某条目就是这个样子」→ 别写死 ID

本站数据每天在变：升格改 ID、新增条目、补全字段。`fixtures/anchors.ts` 开头
写了断言的三个档位，优先用前两档（结构性 / 量级），第三档（精确锚点）只留给
史記这类不会变的经典。

尤其危险的是**锚「什么都没有的条目」**——「空」正是本项目每天在消灭的属性。
这类用例改用候选池 + 运行时挑选：

```ts
const sample = await pickEmptySample(request, EMPTY_STATE_POOL.work, isEmptyWork);
test.skip(sample === null, '候选池全部已被整理，空状态无从验证');
```

## fixtures

| 文件 | 内容 |
|------|------|
| `anchors.ts` | 被测地址、断言锚点与区间、空状态候选池 |
| `version.ts` | 解析 `latest.json`，拼带版本号的 data URL（含 cache-buster） |
| `preconditions.ts` | 版本门禁 `requireUiVersion`、空样本挑选 `pickEmptySample` |

## 跳过 vs 失败

前置条件不成立时一律**跳过**，不失败：这套 e2e 的职责是拦线上回归，不是督促
数据整理或催版本发布；前提没了就没有可断言的东西，为此挡住部署是错的。
跳过会带着原因出现在报告里。

唯一的例外是机制本身坏掉——`contract/site-build.spec.ts` 守着这一点：站点若
不再暴露 `bim-ui-version`，版本门禁就会变成一批用例集体静默跳过，那条契约会
直接报红。
