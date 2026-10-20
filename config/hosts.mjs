/**
 * Node 脚本（ops/、nextjs/scripts/、perf/、e2e/）取域名的入口：读同目录的 hosts.json（唯一来源）。
 * 网站代码用 nextjs/src/lib/hosts.ts，边缘函数用 edge-functions/api/hosts.js（两者都由 ops/sync-hosts.mjs 生成）。
 */
import { readFileSync } from 'node:fs';

export const HOSTS = JSON.parse(readFileSync(new URL('./hosts.json', import.meta.url), 'utf-8'));

export const DATA_ORIGIN = HOSTS.data;
/** 旧数据域名：仍可用（同一个 COS 桶），清缓存时两个域名都清 */
export const LEGACY_DATA_ORIGIN = HOSTS.legacyData;
export const API_ORIGIN = HOSTS.api;
export const SITE_ORIGIN = HOSTS.site;
export const SITE_APEX_ORIGIN = HOSTS.siteApex;
export const STAGING_ORIGIN = HOSTS.staging;
export const SSR_TEST_ORIGIN = HOSTS.ssrTest;
export const LEGACY_SITE_ORIGIN = HOSTS.legacySite;
export const LEGACY_APEX_ORIGIN = HOSTS.legacyApex;
export const OAUTH_ISSUER = HOSTS.oauthIssuer;

/** 测试站的数据前缀 */
export const DATA_STAGING_ORIGIN = `${DATA_ORIGIN}/staging`;

/** 'https://data.example.com' → 'data.example.com' */
export const hostOf = (origin) => new URL(origin).host;
