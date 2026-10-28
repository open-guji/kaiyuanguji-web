/** 作品「文本来源」表（entry.read_texts，打包算好）：解析与作品页阅读入口的默认去处 */
import { describe, it, expect } from '@jest/globals';
import { defaultReadTarget, readTextLabel, readTextsOf } from '../read-texts';

const rows = [
    { id: '96mid1ogzk', label: '開源古籍自校本', edition: '清乾隆六十年武英殿刻本', own: true },
    { id: 'd59dh3vo9af4', label: '維基文庫' },
];

describe('read-texts', () => {
    it('readTextsOf：认格式，坏项跳过，没有字段是空数组', () => {
        expect(readTextsOf({ read_texts: [...rows, null, { id: 3 }, { id: 'x' }] })).toEqual(rows);
        expect(readTextsOf({})).toEqual([]);
        expect(readTextsOf(null)).toEqual([]);
    });

    it('defaultReadTarget：作品页入口去第一行（自建本）；第一行就是本条目或没有表时不改', () => {
        expect(defaultReadTarget('d59dh3vo9af4', rows)).toBe('/read/96mid1ogzk');
        expect(defaultReadTarget('96mid1ogzk', rows)).toBeNull();
        expect(defaultReadTarget('d59dh3vo9af4', [])).toBeNull();
    });

    it('readTextLabel：来源 · 底本', () => {
        expect(readTextLabel(rows[0])).toBe('開源古籍自校本 · 清乾隆六十年武英殿刻本');
        expect(readTextLabel(rows[1])).toBe('維基文庫');
    });
});
