// 由 ops/sync-hosts.mjs 从 config/hosts.json 生成，勿手改；改域名请改 config/hosts.json 后重跑

export const DATA_ORIGIN = 'https://data.openguji.com';
export const LEGACY_DATA_ORIGIN = 'https://data.kaiyuanguji.com';
export const API_ORIGIN = 'https://api.kaiyuanguji.com';
export const SITE_ORIGIN = 'https://www.openguji.com';
export const SITE_APEX_ORIGIN = 'https://openguji.com';
export const STAGING_ORIGIN = 'https://staging.kaiyuanguji.com';
export const SSR_TEST_ORIGIN = 'https://ssr-test.kaiyuanguji.com';
export const LEGACY_SITE_ORIGIN = 'https://www.kaiyuanguji.com';
export const LEGACY_APEX_ORIGIN = 'https://kaiyuanguji.com';
export const OAUTH_ISSUER = 'https://www.kaiyuanguji.com';

/** 'https://data.example.com' → 'data.example.com' */
export const hostOf = (origin: string): string => new URL(origin).host;
