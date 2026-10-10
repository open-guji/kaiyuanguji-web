/**
 * 阅读页给读者看的 manifest（overview#456）。服务端校验、首屏种子、浏览器端取数共用，不引服务端模块。
 *
 * 显示规则，数据不动（目录页仍读原 manifest 的 default）：
 *   1. 作品有 kind=transcription 的全文版时，所有 kind=collated 的整理本（目录型 default，或 key 为 collated 等）阅读页都不列，只留全文版；
 *      default 被隐藏后 versions[0] 是主版本（阅读器把「没有 default 时的第一份」当主版本，地址里不写 key）。
 *      kind=self_collated（本站独立整理，即原件）不适用这条隐藏：它不是整理本的衍生，有全文版也照常列出。
 *   2. 来源标签直接用 source_name／license，license 原样显示（写「未知」就显示「未知」，不改写）。
 */
import type { Manifest, ManifestVersion } from './server/reader-check';

/** 这里只 import type，客户端引用不会带进服务端代码 */
export function readerManifest(manifest: Manifest): Manifest {
    const versions = manifest.versions;
    const hasFullText = versions.some((v) => v.kind === 'transcription');
    // 只隐藏 kind=collated；self_collated（本站独立整理的原件）不在此列
    const hideCollated = (v: ManifestVersion) => hasFullText && v.kind === 'collated';
    if (!versions.some(hideCollated)) return manifest; // 没有要隐藏的就原样返回（种子命中判等、少一次拷贝）
    return { ...manifest, versions: versions.filter((v) => !hideCollated(v)) };
}
