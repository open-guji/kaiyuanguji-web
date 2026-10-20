// config/hosts.mjs 的类型声明（e2e／perf 的 TypeScript 引用它）
export declare const HOSTS: Record<string, string>;
export declare const DATA_ORIGIN: string;
export declare const LEGACY_DATA_ORIGIN: string;
export declare const API_ORIGIN: string;
export declare const SITE_ORIGIN: string;
export declare const SITE_APEX_ORIGIN: string;
export declare const STAGING_ORIGIN: string;
export declare const SSR_TEST_ORIGIN: string;
export declare const LEGACY_SITE_ORIGIN: string;
export declare const LEGACY_APEX_ORIGIN: string;
export declare const OAUTH_ISSUER: string;
export declare const DATA_STAGING_ORIGIN: string;
export declare function hostOf(origin: string): string;
