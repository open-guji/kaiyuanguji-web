/**
 * @jest-environment node
 *
 * overview#307 E 块：阅读页服务端校验读 manifest（web#99 审查：乱填地址不能 200 出软 404）。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { checkReader, checkReaderSel, getManifest, type GetCurrentJson } from '../server/reader-check';

const WORK = 'd59f2htm01du';

const FILES: Record<string, unknown> = {
    [`items/${WORK}/manifest.json`]: { id: WORK, versions: [{ key: 'default', kind: 'collated', label: '整理本' }, { key: 'wikisource', kind: 'transcription', label: '維基文庫' }] },
    [`items/${WORK}/default/index.json`]: { chapters: [{ n: 1, file: '001', title: '經錄', has_json: true }, { n: 2, file: '002', title: ' 史錄 ', has_json: true }] },
    [`items/${WORK}/wikisource/index.json`]: { chapters: [{ n: 1, file: '001', title: '' }, { n: 2, file: '002' }, { n: 3, file: '003', title: '卷三' }] },
};
const get: GetCurrentJson = async <T,>(rel: string) => (FILES[rel] ?? null) as T | null;

describe('checkReader', () => {
    it('没给版本和章：主版本第一章，带回 manifest、版本、目录与章名', async () => {
        const r = await checkReader(WORK, {}, get);
        expect(r.status).toBe('found');
        expect(r.version?.key).toBe('default');
        expect(r.chapter).toBe('001');
        expect(r.chapterTitle).toBe('經錄');
        expect(r.index?.chapters).toHaveLength(2);
        expect(r.manifest?.versions).toHaveLength(2);
    });

    it('给了章：章名按目录（去首尾空白）；其他版本按 key', async () => {
        expect((await checkReader(WORK, { chapter: '002' }, get)).chapterTitle).toBe('史錄');
        const w = await checkReader(WORK, { key: 'wikisource', chapter: '003' }, get);
        expect(w).toMatchObject({ status: 'found', chapter: '003', chapterTitle: '卷三' });
        expect((await checkReader(WORK, { key: 'wikisource' }, get)).chapter).toBe('001');
        expect((await checkReader(WORK, { key: 'wikisource' }, get)).chapterTitle).toBeUndefined(); // 目录里章名为空
    });

    it('版本或章不存在 → missing（页面真 404）', async () => {
        expect((await checkReader(WORK, { key: 'kanripo' }, get)).status).toBe('missing');
        expect((await checkReader(WORK, { chapter: '009' }, get)).status).toBe('missing');
        expect((await checkReader(WORK, { key: 'wikisource', chapter: '004' }, get)).status).toBe('missing');
    });

    it('条目没有 manifest（没有文本）、manifest 没有版本、目录为空 → missing', async () => {
        expect((await checkReader('d59f2aaaaaaa', {}, get)).status).toBe('missing');
        const g1: GetCurrentJson = async <T,>(rel: string) => (rel.endsWith('manifest.json') ? { versions: [] } : null) as T | null;
        expect((await checkReader(WORK, {}, g1)).status).toBe('missing');
        const g2: GetCurrentJson = async <T,>(rel: string) => (rel.endsWith('manifest.json') ? FILES[`items/${WORK}/manifest.json`] : { chapters: [] }) as T | null;
        expect((await checkReader(WORK, {}, g2)).status).toBe('missing');
    });

    it('查不了（网络错）→ unknown，不当 404', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const boom: GetCurrentJson = async () => { throw new Error('ECONNRESET'); };
        expect((await checkReader(WORK, { chapter: '001' }, boom)).status).toBe('unknown');
        expect(await checkReaderSel(WORK, {}, boom)).toBe('unknown');
        warn.mockRestore();
    });
});

describe('getManifest', () => {
    it('取到返回；没有返回 null；形态不对（版本没有 key）当没有', async () => {
        expect((await getManifest(WORK, get))?.versions.map((v) => v.key)).toEqual(['default', 'wikisource']);
        expect(await getManifest('d59f2aaaaaaa', get)).toBeNull();
        const bad: GetCurrentJson = async <T,>() => ({ versions: [{ kind: 'collated' }] }) as T;
        expect(await getManifest(WORK, bad)).toBeNull();
    });
});
