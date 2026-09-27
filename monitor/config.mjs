/**
 * 监控目标与阈值。全部可用环境变量覆盖——故障注入演示就是靠改这里
 * （把域名指向本地假服务器、把阈值调到必然失败）。
 * 阈值的含义与误报时怎么调，见 monitor/README.md。
 */
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));

export function loadConfig() {
  return {
    www: env('MON_WWW', 'https://www.kaiyuanguji.com'),
    data: env('MON_DATA', 'https://data.kaiyuanguji.com'),
    api: env('MON_API', 'https://api.kaiyuanguji.com'),
    staging: env('MON_STAGING', 'https://staging.kaiyuanguji.com'),
    // 公开只读搜索 key：本就随 JS 发给每个浏览器，非机密（同 e2e/fixtures/anchors.ts）
    meiliKey: env('MON_MEILI_KEY', '1b0b438f7eadd34e1a6b53c76d63bd3614822d3ec9856251c9340a78456c5465'),
    tlsHosts: env('MON_TLS_HOSTS', 'www.kaiyuanguji.com,data.kaiyuanguji.com,api.kaiyuanguji.com,staging.kaiyuanguji.com')
      .split(',').map((s) => s.trim()).filter(Boolean),

    timeoutMs: num('MON_TIMEOUT_MS', 20000),
    // A2 搜索
    searchQuery: env('MON_SEARCH_Q', '史記'),
    searchMaxMs: num('MON_SEARCH_MAX_MS', 3000),
    searchBaselineRatio: num('MON_SEARCH_BASELINE_RATIO', 0.9),
    // A1 部署停更：main 改了 book-index-ui 之后，测试站多久内必须跟上、正式站多久内必须跟上
    stagingLagHours: num('MON_STAGING_LAG_HOURS', 3),
    prodLagHours: num('MON_PROD_LAG_HOURS', 72),
    // A7 证书
    tlsMinDays: num('MON_TLS_MIN_DAYS', 14),
    // B1 前端错误
    errorFloor: num('MON_ERROR_FLOOR', 20),
    errorFactor: num('MON_ERROR_FACTOR', 5),
    // B2 反馈量
    feedbackMaxPerHour: num('MON_FEEDBACK_MAX_PER_HOUR', 20),
    // B3 数据新鲜度
    freshnessMaxHours: num('MON_FRESHNESS_MAX_HOURS', 36),
    dataRepos: {
      draft: env('MON_REPO_DRAFT', 'open-guji/book-index-draft'),
      production: env('MON_REPO_PRODUCTION', 'open-guji/book-index'),
      text: env('MON_REPO_TEXT', 'open-guji/book-text'),
    },
    githubApi: env('GITHUB_API_URL', 'https://api.github.com'),
    githubToken: env('GITHUB_TOKEN', ''),
    errorViewToken: env('ERROR_VIEW_TOKEN', ''),
  };
}
