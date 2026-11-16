/**
 * 本站自做文本的授权口径：全站已于 PR #575 从 CC0 改为 CC BY-SA 4.0，但数据仓里本站自做版本
 * （source=original／kind=self_collated）的 manifest.json 仍写着「CC0 1.0」，阅读页因此显示「本站獨立整理 · CC0 1.0」。
 * 数据仓改完前，网站在读 manifest 时把这类版本的 CC0 就地换成 CC BY-SA 4.0；数据改完后本函数自然成为空操作。
 * 只动本站自做的版本，别家来源（如 upstream）真实标的授权照原样保留。
 */
const SITE_LICENSE = 'CC BY-SA 4.0';
const CC0_RE = /^\s*CC0(?:[\s-]*1\.0)?\s*$/i;

function isCc0(v: unknown): boolean {
    return typeof v === 'string' && CC0_RE.test(v);
}

export function normalizeManifestLicense<T>(manifest: T): T {
    const m = manifest as unknown as { versions?: unknown; source?: unknown } | null;
    if (!m || typeof m !== 'object') return manifest;
    if (Array.isArray(m.versions)) {
        for (const v of m.versions as Array<Record<string, unknown> | null>) {
            if (v && typeof v === 'object' && (v.source === 'original' || v.kind === 'self_collated') && isCc0(v.license)) {
                v.license = SITE_LICENSE;
            }
        }
    }
    const s = m.source as Record<string, unknown> | null | undefined;
    if (s && typeof s === 'object' && isCc0(s.license) && /开源古籍|開源古籍/.test(String(s.name ?? ''))) {
        s.license = SITE_LICENSE;
    }
    return manifest;
}
