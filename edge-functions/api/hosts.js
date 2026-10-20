// 由 ops/sync-hosts.mjs 从 config/hosts.json 生成，勿手改；改域名请改 config/hosts.json 后重跑

export const DATA_ORIGIN = 'https://data.kaiyuanguji.com';
export const API_ORIGIN = 'https://api.kaiyuanguji.com';
export const SITE_ORIGIN = 'https://www.openguji.com';
export const SITE_APEX_ORIGIN = 'https://openguji.com';
export const STAGING_ORIGIN = 'https://staging.kaiyuanguji.com';
export const SSR_TEST_ORIGIN = 'https://ssr-test.kaiyuanguji.com';
export const LEGACY_SITE_ORIGIN = 'https://www.kaiyuanguji.com';
export const LEGACY_APEX_ORIGIN = 'https://kaiyuanguji.com';
export const OAUTH_ISSUER = 'https://www.kaiyuanguji.com';

export const DATA_STAGING_ORIGIN = `${DATA_ORIGIN}/staging`;

/** 本站页面的所有来源（新旧域名的 www 与裸域）；CORS 白名单用，第一个是不匹配时的回落值 */
export const SITE_ORIGINS = [LEGACY_SITE_ORIGIN, LEGACY_APEX_ORIGIN, SITE_ORIGIN, SITE_APEX_ORIGIN];
