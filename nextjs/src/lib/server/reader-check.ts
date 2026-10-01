/**
 * 阅读页服务端校验：版本 key／章号在数据里是否真有（网站总管审查 web#99；overview#307 E 块改读新结构）。
 *
 * 不校验的话，乱填的地址也回 200、还带着指向自己的 canonical，会被当作大批软 404 收录。
 * 只认新结构（用户 09-30 定），查的是阅读器组件自己要读的同几份文件：
 *   items/<id>/manifest.json            版本清单（versions[0] 是 default）；没有 ＝ 这个条目没有文本 ＝ 404
 *   items/<id>/<key>/index.json         该版本的章目录（chapters[].file 是三位章号）
 *
 * 结果：found ＝ 都查到了（带回 manifest、版本、目录与落实的章，首屏预取直接用）；
 *       missing ＝ 确定没有（页面 404）；
 *       unknown ＝ 查不了（网络错等），页面照常渲染，但 canonical 回落到不带章号的地址，不给查不准的地址背书。
 */
import type { ReaderSel } from '../reader-route';

export type ReaderCheck = 'found' | 'missing' | 'unknown';

export interface ManifestVersion {
    key: string;
    kind?: string;
    label?: string;
    source?: string;
    source_name?: string;
    /** 版本名（底本）：「四部叢刊本」；可选（book-text 901182c50b） */
    edition_label?: string;
    source_url?: string | null;
    license?: string | null;
}
export interface Manifest { id?: string; versions: ManifestVersion[] }
export interface TextChapterMeta { n?: number; file: string; title?: string; has_json?: boolean }
export interface TextIndexDoc { chapters: TextChapterMeta[] }

export interface ReaderCheckResult {
    status: ReaderCheck;
    manifest?: Manifest;
    version?: ManifestVersion;
    index?: TextIndexDoc;
    /** 落实的章号：地址里给了就是它，没给是第一章 */
    chapter?: string;
    chapterTitle?: string;
}

/** 取 current/ 下一个 JSON：确定没有返回 null，查不了抛错 */
export type GetCurrentJson = <T>(relPath: string) => Promise<T | null>;

function validManifest(m: Manifest | null): m is Manifest {
    return !!m && Array.isArray(m.versions) && m.versions.length > 0 && m.versions.every((v) => v && typeof v.key === 'string');
}

/** 取条目的 manifest：没有返回 null（条目没有文本）；查不了抛错 */
export async function getManifest(id: string, get: GetCurrentJson): Promise<Manifest | null> {
    const m = await get<Manifest>(`items/${id}/manifest.json`);
    return validManifest(m) ? m : null;
}

/**
 * 旧地址换算用：取 manifest 失败（网络／存储错误）时给 'error'，与「确实没有」(null) 区分——
 * 前者只能临时跳走，不能发会被缓存的永久重定向。
 */
export async function getManifestOrError(id: string, get: GetCurrentJson): Promise<Manifest | null | 'error'> {
    try {
        return await getManifest(id, get);
    } catch {
        return 'error';
    }
}

async function check(id: string, sel: ReaderSel, get: GetCurrentJson): Promise<ReaderCheckResult> {
    const manifest = await getManifest(id, get);
    if (!manifest) return { status: 'missing' };
    const version = sel.key
        ? manifest.versions.find((v) => v.key === sel.key)
        : (manifest.versions.find((v) => v.key === 'default') ?? manifest.versions[0]);
    if (!version) return { status: 'missing' };
    const index = await get<TextIndexDoc>(`items/${id}/${version.key}/index.json`);
    if (!index || !Array.isArray(index.chapters) || index.chapters.length === 0) return { status: 'missing' };
    const hit = sel.chapter ? index.chapters.find((c) => c.file === sel.chapter) : index.chapters[0];
    if (!hit) return { status: 'missing' };
    const title = typeof hit.title === 'string' && hit.title.trim() ? hit.title.trim() : undefined;
    return { status: 'found', manifest, version, index, chapter: hit.file, chapterTitle: title };
}

/** 校验一个已通过 parseReaderSegments 的阅读页地址，并带回落实的版本、目录与章 */
export async function checkReader(id: string, sel: ReaderSel, get: GetCurrentJson): Promise<ReaderCheckResult> {
    try {
        return await check(id, sel, get);
    } catch (err) {
        console.warn(`[reader-check] ${id} 查不了，canonical 回落：${(err as Error).message}`);
        return { status: 'unknown' };
    }
}

/** 同 checkReader，只要结论 */
export async function checkReaderSel(id: string, sel: ReaderSel, get: GetCurrentJson): Promise<ReaderCheck> {
    return (await checkReader(id, sel, get)).status;
}
