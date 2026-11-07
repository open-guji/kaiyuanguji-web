import { compareWhole } from '../compare';
import { chapterChars } from '../wikitext';
import type { BaseCell } from '../volumes';

const cellsOf = (s: string): BaseCell[] => Array.from(s).map((c, i) => ({ c, a: `1:1:${i + 1}` }));

describe('同书另一版本（光盘本）整章对校', () => {
    it('章名行不参与，标点空白去掉', () => {
        expect(chapterChars('## 卷首·聖諭\n\n欽定　四庫\n全書，總目\n').join('')).toBe('欽定四庫全書總目');
    });

    it('双行小注标记 <…|…> 不算字', () => {
        expect(chapterChars('## 章\n也悍<如王柏吳澄攻駁經|文動輒删改之類>學脈').join('')).toBe('也悍如王柏吳澄攻駁經文動輒删改之類學脈');
    });

    it('整章对整章，出用字不同与增减，记在唯一一段里', async () => {
        const r = await compareWhole({
            cells: cellsOf('欽定四庫全書總目卷一'),
            md: '## 章\n欽定四庫全書總目卷二十\n',
            file: '001',
            label: '本册',
            isVariant: () => false,
        });
        expect(r.segments).toHaveLength(1);
        expect(r.segments[0]).toMatchObject({ status: 'ok', wikiFile: '001', from: 0, to: 10 });
        expect(r.items.map((i) => [i.base, i.reading])).toEqual([['一', '二十']]);
        expect(r.items[0].cat).toBe('word');
    });
});
