/**
 * @jest-environment node
 *
 * 条目页头部（overview#280 S4）：meta description／og:description／twitter:description 出简体，
 * <title>／og:title 与 JSON-LD 保持原文。取数与跳转判断不在这里测（item-data／item-redirect 有自己的测试）。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ReactElement } from 'react';

const mockGetItem = jest.fn<(id: string) => Promise<unknown>>();
jest.mock('@/lib/server/item-data', () => ({
    getItemServer: (id: string) => mockGetItem(id),
    getPromotionServer: async () => ({ status: 'absent' }),
}));
jest.mock('next/navigation', () => ({
    notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
    permanentRedirect: () => { throw new Error('NEXT_REDIRECT'); },
    redirect: () => { throw new Error('NEXT_REDIRECT'); },
}));
jest.mock('../ItemDetailClient', () => () => null);
jest.mock('../ItemSummaryView', () => () => null);

const ID = 'd59f20aowb9c';
const ENTRY = {
    id: ID, type: 'work', title: '史記',
    authors: [{ name: '司馬遷', role: '撰', dynasty: '西漢' }],
    description: { text: '記載黃帝至漢武帝的通史。司馬遷撰。' },
};

beforeEach(() => {
    mockGetItem.mockReset().mockResolvedValue({ entry: ENTRY, source: 'h1', version: 'h1:r' });
});

async function meta() {
    const { generateMetadata } = await import('../page.ssr');
    return generateMetadata({ params: Promise.resolve({ id: ID }) });
}

describe('条目页 generateMetadata（S4）', () => {
    it('description／og／twitter 的 description 都是简体', async () => {
        const m = await meta();
        expect(m.description).toContain('司马迁');
        expect(m.description).not.toContain('司馬遷');
        expect(m.openGraph?.description).toBe(m.description);
        expect(m.twitter?.description).toBe(m.description);
    });

    it('title 与 og:title 不动（仍是原文）', async () => {
        const m = await meta();
        expect(m.title).toBe('史記');
        expect(m.openGraph?.title).toContain('史記');
        expect(m.twitter?.title).toContain('史記');
    });

    it('页面里的 JSON-LD：description 是原文，name 是原文，简体名在 alternateName', async () => {
        const { default: ItemPage } = await import('../page.ssr');
        const el = (await ItemPage({ params: Promise.resolve({ id: ID }) })) as ReactElement<{ children: ReactElement[] }>;
        const script = el.props.children[0] as ReactElement<{ dangerouslySetInnerHTML: { __html: string } }>;
        const ld = JSON.parse(script.props.dangerouslySetInnerHTML.__html);
        expect(ld.name).toBe('史記');
        expect(ld.description).toContain('司馬遷');
        expect(ld.alternateName).toContain('史记');
    });

    it('查不到的条目 → 未找到 + noindex（不受影响）', async () => {
        mockGetItem.mockResolvedValue(null);
        const m = await meta();
        expect(m.title).toBe('未找到条目');
        expect(m.robots).toEqual({ index: false, follow: false });
    });
});
