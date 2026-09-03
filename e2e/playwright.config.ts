import { defineConfig, devices } from '@playwright/test';

/**
 * 生产环境验收测试。
 *
 * 分两个 project，按"反馈速度"排序，CI 里可以先跑 contract 快速失败：
 *   contract —— 纯 HTTP，不开浏览器，几秒跑完。查数据管线与后端契约。
 *   ui       —— 真实浏览器渲染断言。查用户实际看到的内容。
 *
 * 默认打线上；本地验证：TARGET=http://localhost:3000 npx playwright test
 */
export default defineConfig({
    testDir: '.',
    // 线上验收禁止 .only 漏进 CI
    forbidOnly: !!process.env.CI,
    // 公网抖动难免，失败重试一次再判定；本地不重试便于调试
    retries: process.env.CI ? 1 : 0,
    // 打的是生产站，控制并发避免给源站压力
    workers: process.env.CI ? 4 : 6,
    reporter: process.env.CI
        ? [['list'], ['html', { outputFolder: 'out/report', open: 'never' }], ['json', { outputFile: 'out/results.json' }]]
        : [['list'], ['html', { outputFolder: 'out/report', open: 'never' }]],

    use: {
        // 失败时留证据，排查线上问题时很关键
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        actionTimeout: 30_000,
        navigationTimeout: 60_000,
    },

    // 单个用例上限：搜索降级到 L2 时要下载分片，给足余量
    timeout: 120_000,
    expect: { timeout: 15_000 },

    projects: [
        {
            name: 'contract',
            testDir: './contract',
            use: {},
        },
        {
            name: 'ui',
            testDir: './ui',
            use: { ...devices['Desktop Chrome'] },
        },
        /**
         * 可降级依赖：挂了也不该拦住发版。
         *
         * 目前只有搜索 L1 (Meilisearch)——它跑在一台 2GB 无 swap 的小机器上，
         * OOM/卡死是常态化风险（2026-09-03 一天内两次：先公网 IP 变更、
         * 后进程卡死）。前端有 L2 兜底，用户无感，所以不值得让每次发版都亮红灯：
         * 红灯天天亮，真正的回归就没人看见了。
         *
         * CI 里单独一步跑，`continue-on-error: true`。
         */
        {
            name: 'degradable',
            testDir: './degradable',
            use: {},
        },
    ],
});
