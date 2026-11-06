import { act, renderHook, waitFor } from '@testing-library/react';
import { useCompare } from '../useCompare';

jest.mock('@/lib/compare/variants', () => ({ loadVariantTest: async () => null }));

const cells = Array.from('卷一天地玄黃宇宙').map((c, i) => ({ c, a: `1:1:${i + 1}` }));
const transport = {
    getTextManifest: async () => ({ versions: [{ key: 'wikisource' }] }),
    getTextIndex: async (id: string) =>
        id === 'base'
            ? { chapters: [{ file: '002', headings: [{ level: 1, label: '卷一', anchor: '1:1:1' }] }] }
            : { chapters: [{ file: '005', title: '卷001' }] },
    getChapter: async () => ({ md: '## 卷001\n\n天地元黃宇\n' }),
};
const props = { id: 'base', versionKey: 'default', chapter: '002', transport, sourceIds: ['wiki'], cells };

beforeEach(() => {
    window.history.replaceState(null, '', '/read/base/002?cmp=wiki');
    window.localStorage.clear();
});

it('读 ?cmp=，比对出差异，补全版本 key，点字开详情、上一处下一处', async () => {
    const { result } = renderHook(() => useCompare(props));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(window.location.search).toBe('?cmp=wiki-wikisource');
    // 卷一标题＋「卷一」两字对照本没有 → omit；玄/元 → word；宇宙 vs 宇 → omit
    expect(result.current.shown.map((i) => [i.cat, i.base, i.reading])).toEqual([['omit', '卷一', ''], ['word', '玄', '元'], ['omit', '宙', '']]);
    expect(result.current.decorations.get('1:1:5')).toMatchObject({ tone: 'cmp-word', sub: '元' });
    act(() => { result.current.pick('1:1:5'); });
    expect(result.current.current?.base).toBe('玄');
    act(() => { result.current.step(1); });
    expect(result.current.current?.base).toBe('宙');
    act(() => { result.current.setTarget(null); });
    expect(window.location.search).toBe('');
    expect(result.current.active).toBe(false);
});

it('不合法或不是本作品来源的 ?cmp= 静默忽略', async () => {
    window.history.replaceState(null, '', '/read/base/002?cmp=other-x');
    const { result } = renderHook(() => useCompare(props));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.active).toBe(false);
    expect(result.current.status).toBe('idle');
});

it('对照本取不到：status=error，不抛', async () => {
    const bad = { ...transport, getTextIndex: async (id: string) => (id === 'base' ? { chapters: [] } : null) };
    const { result } = renderHook(() => useCompare({ ...props, transport: bad }));
    await waitFor(() => expect(result.current.status).toBe('error'));
});
