/**
 * 阅读页首屏种子 read-seed.json（overview#345 方案 B，web 侧读法）。
 *
 * 数据侧给每个有文本的条目生成一个 `current/items/<id>/read-seed.json`：manifest 原样＋主版本的 index 原样，
 * 让首次渲染的取数从「manifest → index（并发 4 个请求）」缩成「一个 seed ‖ 首章」。
 *   { "v": 1, "manifest": {…manifest.json 原样…}, "primary": { "key": "<主版本 key>", "index": {…该版本 index.json 原样…} } }
 *
 * 开关：`latest.json` 里 `readSeed: 1`（数据发布者在 seed 全部上传成功之后才写）。没有／不是 1 ＝ 照旧的读法，一行不变。
 *
 * **只换数据来源，不换逻辑**：这里不做任何校验判断——checkReader／preloadReader 一行没改，仍按 manifest 校验版本与章；
 * 本模块只是把它们要取的 `manifest.json`、`<主版本>/index.json` 两个地址的结果换成 seed 里的原样拷贝。
 * 任何不对劲（seed 取不到、404、JSON 不合法、`v` 不认识、manifest.id 对不上、主版本与 manifest 里的不一致、
 * 要的是别的版本的 index）都**回退成原来的取数**，渲染结果与没有 seed 时逐字节一致（只是慢一点）。
 */
import type { Manifest, TextIndexDoc } from './reader-check';

export const READ_SEED_VERSION = 1;

export interface ReadSeed {
    v: number;
    manifest: Manifest;
    primary: { key: string; index: TextIndexDoc };
}

/** latest.json 里的开关：只认数字 1 */
export function isReadSeedEnabled(latest: unknown): boolean {
    return !!latest && typeof latest === 'object' && (latest as { readSeed?: unknown }).readSeed === READ_SEED_VERSION;
}

/** 校验并取出 seed；任何一处不合格返回 null（调用方回退原取数） */
export function parseReadSeed(raw: unknown, id: string): ReadSeed | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Partial<ReadSeed>;
    if (s.v !== READ_SEED_VERSION) return null;
    const m = s.manifest;
    if (!m || typeof m !== 'object' || !Array.isArray(m.versions) || m.versions.length === 0) return null;
    if (!m.versions.every((v) => v && typeof v.key === 'string')) return null;
    if (m.id !== undefined && m.id !== id) return null;
    const p = s.primary;
    if (!p || typeof p.key !== 'string' || !m.versions.some((v) => v.key === p.key)) return null;
    const idx = p.index;
    if (!idx || typeof idx !== 'object' || !Array.isArray(idx.chapters) || idx.chapters.length === 0) return null;
    return { v: READ_SEED_VERSION, manifest: m, primary: { key: p.key, index: idx } };
}

export type GetJsonFn = <T>(relPath: string) => Promise<T | null>;

/** 取 seed：失败（网络错、404、不合格）一律返回 null，不抛 */
export async function loadReadSeed(id: string, get: GetJsonFn): Promise<ReadSeed | null> {
    try {
        return parseReadSeed(await get<unknown>(`items/${id}/read-seed.json`), id);
    } catch {
        return null;
    }
}

/**
 * 包一层取数函数：manifest.json 与「seed 主版本」的 index.json 用 seed 里的拷贝，其余地址（别的版本的 index、章文件……）原样转给底层。
 * seed 不可用（null）时全部原样转给底层。
 */
export function withReadSeed(id: string, get: GetJsonFn, seedP: Promise<ReadSeed | null>): GetJsonFn {
    const manifestPath = `items/${id}/manifest.json`;
    const indexPrefix = `items/${id}/`;
    const indexSuffix = '/index.json';
    return (async <T,>(relPath: string): Promise<T | null> => {
        if (relPath === manifestPath) {
            const s = await seedP;
            if (s) return s.manifest as unknown as T;
        } else if (relPath.startsWith(indexPrefix) && relPath.endsWith(indexSuffix)) {
            const key = relPath.slice(indexPrefix.length, relPath.length - indexSuffix.length);
            if (key && !key.includes('/')) {
                const s = await seedP;
                if (s && s.primary.key === key) return s.primary.index as unknown as T;
            }
        }
        return get<T>(relPath);
    }) as GetJsonFn;
}
