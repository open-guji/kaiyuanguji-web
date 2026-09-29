# perf — kaiyuanguji-web 性能/网络审计

跑预设的用户旅程场景，每条路径在多档网速下采集：
- 总请求数 / 字节（压缩 + 解压后）
- FCP / LCP / DCL / load
- top 10 大文件
- 失败请求

输出 markdown + json 报告，方便基线对比。

## 快速开始

```bash
cd perf
npm install
npx playwright install --with-deps chromium

# 默认：所有场景 × 所有 profile，跑生产
npm run perf

# 指定场景和 profile
npm run perf -- --scenarios=B1,B2 --profiles=slow-4g

# 单场景 + headed 模式（本地调试）
npm run perf -- --scenarios=A1 --profiles=fast --headed

# 自定义目标
npm run perf -- --target=http://localhost:3000
```

## 目录结构

| 文件 | 用途 |
|------|------|
| `profiles.ts` | 网速档位定义（Fast / 4G / Slow 4G / 3G / 2G） |
| `scenarios.ts` | 场景定义（首页、book-index 各 tab、搜索、详情、整理本…） |
| `collector.ts` | CDP 采集器（请求字节、navigation timing、throttling）|
| `runner.ts` | CLI 入口 |
| `report.ts` | markdown / json 渲染 |
| `out/` | 输出（带时间戳的报告 + `latest.md` / `latest.json`） |

## 在国内服务器跑

```bash
# 在上海服务器上一次性安装
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs
cd /path/to/kaiyuanguji-web/perf
npm install
npm run install-browser

# 跑基线
npm run perf -- --profiles=fast,slow-4g
```

## 加场景

`scenarios.ts` 里加：

```ts
{
    id: 'X1-my-flow',
    name: '我的流程',
    actions: [
        { kind: 'goto', path: '/some/path' },
        { kind: 'wait_selector', selector: '[data-ready]' },
        { kind: 'click', selector: 'button.next' },
        { kind: 'wait_idle', timeoutMs: 30000 },
    ],
},
```

## 夜间门槛（overview#280 T2）

`test.yml` 的 `perf-prod`（每日／手动）跑完 `--profiles=fast` 后接 `gate.ts`：

- **LCP**：`thresholds.json` 的 `lcpMs`（场景 id → 毫秒，只判 fast 档）。场景没跑成、没观测到 LCP 也算超标——门槛失效比慢更糟。
- **条目页缓存命中首字节**：`itemTtfb`。对同一个干净条目地址连续 GET `samples` 次（Node fetch，取到响应头的时刻），只统计响应头 `EO-Cache-Status: Cache Hit` 的样本，取中位数；命中样本不足 `minHits` 只警告不判（判的是命中路径的速度，不是命中率）。
- 超标：`gate.ts` 退出 1 → 工件里有 `gate.md`／`gate.json`，job 摘要贴出，**开单**（标签 `perf`，同名单已开则追加评论），最后 job 变红。
- 初始值是按 2026-09-02 夜间基线放宽约 1.5 倍定的（`thresholds.json` 开头有说明），跑一周后按真实分布收紧。

本地：`npm run perf -- --profiles=fast --scenarios=A1-home,I1-item-page` 之后 `npx tsx gate.ts [--target=…]`；判定逻辑的测试 `npx tsx --test gate.test.ts`。
