/**
 * overview#456：阅读页的版本清单规则——有全文版就不列目录型 default；license 原样显示（「未知」不改写）；
 * self_collated（本站独立整理，原件）不受「有全文版就隐藏整理本」影响。
 */
import { describe, it, expect } from '@jest/globals';
import { readerManifest } from '../reader-manifest';

const collated = { key: 'default', kind: 'collated', label: '整理本', source_name: '維基文庫', license: 'CC BY-SA 4.0' };
const wiki = { key: 'wikisource', kind: 'transcription', label: '維基文庫', source_name: '維基文庫', license: 'CC BY-SA 4.0' };

describe('readerManifest', () => {
    it('default（collated）＋全文版：只留全文版，主版本变成全文版', () => {
        const m = readerManifest({ id: 'd59dh3vo9af4', versions: [collated, wiki] });
        expect(m.versions.map((v) => v.key)).toEqual(['wikisource']);
        expect(m.id).toBe('d59dh3vo9af4');
    });

    it('多份全文版：default 去掉，其余顺序不变', () => {
        const kanripo = { key: 'kanripo', kind: 'transcription', source_name: 'Kanripo', license: 'CC BY 4.0' };
        expect(readerManifest({ versions: [collated, wiki, kanripo] }).versions.map((v) => v.key)).toEqual(['wikisource', 'kanripo']);
    });

    it('default 是全文版、另有 key=collated 的整理本（古文觀止）：整理本也不列，default 仍是主版本', () => {
        const d = { ...wiki, key: 'default' };
        const c = { ...collated, key: 'collated' };
        expect(readerManifest({ versions: [d, c] }).versions.map((v) => v.key)).toEqual(['default']);
    });

    it('只有整理本（没有全文版）：保留 default', () => {
        expect(readerManifest({ versions: [collated] }).versions.map((v) => v.key)).toEqual(['default']);
    });

    it('default 本身就是全文版（kind=transcription）：不动', () => {
        const d = { ...wiki, key: 'default' };
        const k = { key: 'kanripo', kind: 'transcription' };
        expect(readerManifest({ versions: [d, k] }).versions.map((v) => v.key)).toEqual(['default', 'kanripo']);
    });

    it('license「未知」原样保留（不再改写成「版权未知」）；source_name 与别的 license 原样', () => {
        const m = readerManifest({ versions: [{ ...collated, source_name: '网络', license: '未知' }] });
        expect(m.versions[0]).toMatchObject({ source_name: '网络', license: '未知' });
        const z = readerManifest({ versions: [{ ...collated, source_name: '知乎网友整理', license: 'CC0 1.0' }] });
        expect(z.versions[0]).toMatchObject({ source_name: '知乎网友整理', license: 'CC0 1.0' });
        const only = readerManifest({ versions: [{ key: 'default', kind: 'collated', source_name: '网络', license: ' 未知 ' }, { key: 'x', license: null }] });
        expect(only.versions.map((v) => v.license)).toEqual([' 未知 ', null]);
    });

    it('self_collated（本站独立整理，原件）：有全文版也不隐藏，顺序不变', () => {
        const own = { key: 'self', kind: 'self_collated', label: '本站整理', source_name: '开鉴古籍', license: 'CC BY-SA 4.0' };
        expect(readerManifest({ versions: [collated, wiki, own] }).versions.map((v) => v.key)).toEqual(['wikisource', 'self']);
        expect(readerManifest({ versions: [own, collated, wiki] }).versions.map((v) => v.key)).toEqual(['self', 'wikisource']);
        // 只有 self_collated 与整理本、没有全文版：两者都保留
        expect(readerManifest({ versions: [collated, own] }).versions.map((v) => v.key)).toEqual(['default', 'self']);
    });

    it('不改入参', () => {
        const input = { versions: [collated, wiki] };
        readerManifest(input);
        expect(input.versions).toHaveLength(2);
    });
});
