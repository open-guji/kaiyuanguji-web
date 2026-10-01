/**
 * @jest-environment node
 *
 * WEB2（overview#249 Q2）；overview#307 E 块：阅读页首屏数据——manifest、版本目录（校验时已读过）与首章正文，
 * 交给 seedTransport 就地返回。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { preloadReader, SEED_TEXT_MAX } from '../preload';
import { seedCallKey, seedTransport } from '../reader-seed';
import type { ReaderCheckResult } from '@/lib/server/reader-check';
import type { IndexStorage } from 'book-index-ui/storage';

const ID = 'd59f2htm01du';
const MANIFEST = { id: ID, versions: [{ key: 'default', kind: 'collated' }, { key: 'wikisource', kind: 'transcription' }] };
const INDEX = { chapters: [{ n: 1, file: '001', title: '經錄', has_json: true }, { n: 2, file: '002', title: '史錄' }] };

function found(over: Partial<ReaderCheckResult> = {}): ReaderCheckResult {
    return { status: 'found', manifest: MANIFEST, version: MANIFEST.versions[0], index: INDEX, chapter: '001', chapterTitle: '經錄', ...over };
}

function store(json: Record<string, unknown>, text: Record<string, string> = {}) {
    const getJson = jest.fn(async (rel: string) => (rel in json ? json[rel] : null)) as unknown as <T>(rel: string) => Promise<T | null>;
    const getText = jest.fn(async (rel: string, max?: number) => {
        const t = text[rel];
        if (t === undefined) return null;
        return max !== undefined && t.length > max ? null : t;
    });
    return { getJson, getText };
}

describe('preloadReader', () => {
    it('有章 json 的章：manifest、目录、{ md, json } 三项', async () => {
        const { getJson, getText } = store({ [`items/${ID}/default/001.json`]: { title: '經錄', sections: [] } }, { [`items/${ID}/default/001.txt`]: '經錄正文' });
        const seed = await preloadReader(ID, found(), getJson, getText);
        expect(seed.calls![seedCallKey('getTextManifest', ID)]).toBe(MANIFEST);
        expect(seed.calls![seedCallKey('getTextIndex', ID, 'default')]).toBe(INDEX);
        expect(seed.calls![seedCallKey('getChapter', ID, 'default', '001')]).toEqual({ md: '經錄正文', json: { title: '經錄', sections: [] } });
    });

    it('没有章 json 的章（维基全文）：只取 md；其他版本按版本 key', async () => {
        const { getJson, getText } = store({}, { [`items/${ID}/wikisource/002.txt`]: '卷二' });
        const seed = await preloadReader(ID, found({ version: MANIFEST.versions[1], chapter: '002' }), getJson, getText);
        expect(seed.calls![seedCallKey('getTextIndex', ID, 'wikisource')]).toBe(INDEX);
        expect(seed.calls![seedCallKey('getChapter', ID, 'wikisource', '002')]).toEqual({ md: '卷二', json: null });
        expect(getJson).not.toHaveBeenCalled();
    });

    it('章的 md 与 json 要么一起给要么都不给：登记了 json 却没取到 → 不给这一章（交给浏览器），manifest 与目录照给', async () => {
        const { getJson, getText } = store({}, { [`items/${ID}/default/001.txt`]: '經錄正文' });
        const seed = await preloadReader(ID, found(), getJson, getText);
        expect(seed.calls![seedCallKey('getChapter', ID, 'default', '001')]).toBeUndefined();
        expect(seed.calls![seedCallKey('getTextManifest', ID)]).toBe(MANIFEST);
    });

    it('正文超过上限（不让 HTML 过大）、取不到：不给这一章', async () => {
        const big = 'x'.repeat(SEED_TEXT_MAX + 1);
        const { getJson, getText } = store({}, { [`items/${ID}/wikisource/002.txt`]: big });
        const seed = await preloadReader(ID, found({ version: MANIFEST.versions[1], chapter: '002' }), getJson, getText);
        expect(seed.calls![seedCallKey('getChapter', ID, 'wikisource', '002')]).toBeUndefined();
        expect(getText).toHaveBeenCalledWith(`items/${ID}/wikisource/002.txt`, SEED_TEXT_MAX);
    });

    it('取数抛错：不抛，少放这一章', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const getJson = jest.fn(async () => { throw new Error('boom'); }) as unknown as <T>(rel: string) => Promise<T | null>;
        const getText = jest.fn(async () => { throw new Error('boom'); });
        const seed = await preloadReader(ID, found(), getJson, getText);
        expect(seed.calls![seedCallKey('getTextManifest', ID)]).toBe(MANIFEST);
        expect(Object.keys(seed.calls!)).toHaveLength(2);
    });

    it('校验结果不是 found（查不了、没有）：空种子', async () => {
        const { getJson, getText } = store({});
        expect(await preloadReader(ID, { status: 'unknown' }, getJson, getText)).toEqual({});
        expect(await preloadReader(ID, { status: 'missing' }, getJson, getText)).toEqual({});
        expect(await preloadReader(ID, { status: 'found' }, getJson, getText)).toEqual({});
    });
});

describe('seedTransport', () => {
    function base() {
        return {
            getTextManifest: jest.fn(async () => 'from-transport:manifest'),
            getTextIndex: jest.fn(async () => 'from-transport:index'),
            getChapter: jest.fn(async () => 'from-transport:chapter'),
        } as unknown as IndexStorage & Record<string, jest.Mock>;
    }

    it('命中种子就地返回，不碰底层；getChapter 末尾的选项对象不参与匹配', async () => {
        const t = base();
        const s = seedTransport(t, {
            [seedCallKey('getTextManifest', ID)]: MANIFEST,
            [seedCallKey('getChapter', ID, 'default', '001')]: { md: '正文', json: null },
        });
        await expect(s.getTextManifest!(ID)).resolves.toBe(MANIFEST);
        await expect(s.getChapter!(ID, 'default', '001', { json: true })).resolves.toEqual({ md: '正文', json: null });
        await expect(s.getChapter!(ID, 'default', '001')).resolves.toEqual({ md: '正文', json: null });
        expect(t.getTextManifest).not.toHaveBeenCalled();
        expect(t.getChapter).not.toHaveBeenCalled();
    });

    it('没命中（别的章、别的版本、种子里没有这个方法）照原样转给底层', async () => {
        const t = base();
        const s = seedTransport(t, { [seedCallKey('getChapter', ID, 'default', '001')]: { md: '正文', json: null } });
        await expect(s.getChapter!(ID, 'default', '002', { json: true })).resolves.toBe('from-transport:chapter');
        await expect(s.getChapter!(ID, 'wikisource', '001')).resolves.toBe('from-transport:chapter');
        await expect(s.getTextIndex!(ID, 'default')).resolves.toBe('from-transport:index');
        expect(t.getChapter).toHaveBeenCalledTimes(2);
        expect(t.getChapter).toHaveBeenCalledWith(ID, 'default', '002', { json: true });
    });

    it('种子里的值是 null／undefined 不拦（「服务端没取到」不是「没有」）；种子为空原样返回 transport', async () => {
        const t = base();
        const s = seedTransport(t, { [seedCallKey('getTextManifest', ID)]: null });
        await expect(s.getTextManifest!(ID)).resolves.toBe('from-transport:manifest');
        expect(seedTransport(t, undefined)).toBe(t);
        expect(seedTransport(t, {})).toBe(t);
    });
});
