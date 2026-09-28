/**
 * 版本解析 —— 所有 data 请求的 cache-bust 依据。
 *
 * 线上数据布局：条目在 `current/` 单副本，靠 `?v=<版本键>` 让 CDN 分离缓存。
 * 版本键 = latest.json 的 cacheKey（三仓合成），旧数据无此字段时回退 commitId
 * （与前端 nextjs/src/lib/data-version.ts 同一口径，见 overview#169）。
 * 版本号的唯一权威来源是根目录的 `latest.json`（EdgeOne 配了不缓存）；
 * `current/version.json` 带 immutable 长缓存，读它会拿到过期值——2026-09-02
 * 就是因为 BundleStorage 自己去读 current/version.json，拿到 9 天前的旧
 * commit，导致所有 items/* 请求拼出的 URL 全是 404。
 */
import type { APIRequestContext } from '@playwright/test';
import { DATA_BASE } from './anchors';

export interface DataVersion {
    /** draft 仓 12 位短哈希（旧数据的 ?v=） */
    commitId: string;
    /** 三仓合成键（16 位 hex），有则优先用作 ?v= 与 v/<key>/search */
    cacheKey?: string;
    fullCommitId?: string;
    productionCommitId?: string;
    /** book-text 仓（整理本/全文资产）的 commit */
    textCommitId?: string;
    commitDate?: string;
    bundleDate?: string;
}

/**
 * 拉当前发布版本。带 cache-buster query，绕开任何中间缓存，
 * 确保测试拿到的是源站真实状态而非 CDN 快照。
 */
export async function fetchLatest(request: APIRequestContext): Promise<DataVersion> {
    const res = await request.get(`${DATA_BASE}/latest.json?_=${Date.now()}`);
    if (!res.ok()) {
        throw new Error(`latest.json 不可达: HTTP ${res.status()}`);
    }
    const json = (await res.json()) as DataVersion;
    if (!json.commitId) {
        throw new Error(`latest.json 缺 commitId: ${JSON.stringify(json)}`);
    }
    return json;
}

/** 前端实际用的版本键：优先 cacheKey，缺则回退 commitId */
export function versionKey(v: DataVersion): string {
    return v.cacheKey || v.commitId;
}

/** 拼一个带正确版本号的 data URL */
export function dataUrl(path: string, version: string): string {
    const clean = path.replace(/^\//, '');
    // 额外挂一个时间戳绕开 CDN 边缘缓存。
    //
    // 只带 ?v=<commitId> 不够：commitId 取自数据仓 HEAD，而一次「代码改了、
    // 数据没改」的部署会重新打包 current/* 但 commitId 不变——URL 一模一样，
    // CDN 于是继续吐旧内容。部署后立刻跑的 verify job 因此读到上一版数据，
    // 报出根本不存在的失败（2026-09-04：meta.json 明明已是 88489，
    // 测试却拿到旧的 2980）。
    //
    // 生产前端不需要这个时间戳——它靠 commitId 分离缓存是正确的策略，
    // 只有「部署后立即验证」这个场景必须看到源站真实状态。
    return `${DATA_BASE}/${clean}?v=${version}&_=${Date.now()}`;
}
