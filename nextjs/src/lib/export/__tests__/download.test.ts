/**
 * buildExport：按章条目声明取文件（字、标点取瘦身副本，专名取原文件保 href）、套 front matter、转字形、起文件名。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { availableFormats, buildExport, type ExportChapter } from '../download';

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'v020.json'), 'utf-8'));
const chapter: ExportChapter = {
    file: '020', title: '小學類', char_file: '020.char.json', reader_char_file: '020.char.reader.json',
    punct_file: '020.punct.json', reader_punct_file: '020.punct.reader.json', entity_file: '020.entity.json',
    text_version: '0.3.1', punct_version: '0.1.0', entity_version: '0.4.12',
};

function storage() {
    const asked: string[] = [];
    const files: Record<string, unknown> = {
        '020.char.reader.json': fx.char,
        '020.punct.reader.json': fx.punct,
        '020.entity.json': fx.entity,
    };
    return { asked, getTextFile: async (_id: string, _key: string, file: string) => { asked.push(file); return files[file] ?? null; } };
}

const base = { id: '96mid1ogzk', versionKey: 'default', chapter, bookTitle: '欽定四庫全書總目', versionLabel: '開源古籍自校本', license: 'CC0 1.0' };

describe('buildExport', () => {
    it('分行本只取字，不出标点、专名版本号', async () => {
        const s = storage();
        const r = await buildExport({ ...base, format: 'lines', links: false, glyph: 'original' }, s);
        expect(s.asked).toEqual(['020.char.reader.json']);
        expect(r.filename).toBe('欽定四庫全書總目-第020冊-分行本.md');
        expect(r.text.startsWith('---\ntitle: "欽定四庫全書總目"\nbook_id: "96mid1ogzk"\nchapter: "020"\n')).toBe(true);
        expect(r.text).toContain('text_version: "0.3.1"');
        expect(r.text).not.toContain('punct_version');
        expect(r.text.endsWith(fx.expected.lines)).toBe(true);
    });

    it('专名本带链接：专名取原文件，正文与 render_rich 一致', async () => {
        const s = storage();
        const r = await buildExport({ ...base, format: 'entity', links: true, glyph: 'original' }, s);
        expect(s.asked).toContain('020.entity.json');
        expect(r.text).toContain('format: "專名本（帶鏈接）"');
        expect(r.text).toContain('entity_version: "0.4.12"');
        expect(r.text).toContain('license: "CC0 1.0"');
        expect(r.text.endsWith(fx.expected.linked)).toBe(true);
    });

    it('标点本 = 只留书名号', async () => {
        const r = await buildExport({ ...base, format: 'punct', links: true, glyph: 'original' }, storage());
        expect(r.text.endsWith(fx.expected.works)).toBe(true);
    });

    it('简体：正文、文件名都转，链接不动，字数不变', async () => {
        const r = await buildExport({ ...base, format: 'entity', links: true, glyph: 'simplified' }, storage());
        expect(r.filename).toBe('钦定四库全书总目-第020册-专名本.md');
        expect(r.text).toContain('book-index://Work/d59f1iqd854w');
        expect(r.text).toContain('《[汉志](book-index://Work/d59f1iqd854w)》');
        const orig = await buildExport({ ...base, format: 'entity', links: true, glyph: 'original' }, storage());
        const body = (t: string) => t.slice(t.indexOf('\n---\n') + 5);
        expect([...body(r.text)].length).toBe([...body(orig.text)].length);
    });

    it('通行繁体：只做异体字归一', async () => {
        const r = await buildExport({ ...base, format: 'punct', links: false, glyph: 'traditional' }, storage());
        expect(r.text).toContain('相參並列'); // 㕘→參
        expect(r.text).not.toContain('㕘');
        expect(r.text).toContain('欽定四庫全書總目');
    });

    it('缺层报错', async () => {
        await expect(buildExport({ ...base, chapter: { ...chapter, entity_file: 'x.json' }, format: 'entity', links: true, glyph: 'original' }, storage())).rejects.toThrow('專名');
    });
});

describe('availableFormats', () => {
    it('按章条目声明', () => {
        expect(availableFormats(chapter)).toEqual(['lines', 'punct', 'entity']);
        expect(availableFormats({ char_file: 'a.json', punct_file: 'b.json' })).toEqual(['lines', 'punct']);
        expect(availableFormats({ char_file: 'a.json' })).toEqual(['lines']);
        expect(availableFormats({})).toEqual([]);
        expect(availableFormats({ char_file: '../x' })).toEqual([]);
    });
});
