/**
 * overview#267 QA 回归 P2：条目页直出（关 JS 看到的）的首屏摘要也是简体。
 * 用真的 book-index-ui LocaleProvider：条目页里它就包在 ItemDetailClient 上。
 */
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);

import { LocaleProvider } from 'book-index-ui';
import ItemSummaryView from '../ItemSummaryView';

async function ssr(el: React.ReactElement): Promise<string> {
    const g = globalThis as { TextEncoder?: unknown; setImmediate?: unknown };
    g.TextEncoder ??= (await import('node:util')).TextEncoder;
    g.setImmediate ??= (fn: () => void) => setTimeout(fn, 0);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { renderToString } = require('react-dom/server.node') as typeof import('react-dom/server');
    return renderToString(el);
}

const summary = {
    id: '96kzkdm8e8',
    type: 'book',
    title: '新鐫全部繡像紅樓夢',
    edition: '程甲本',
    authorLine: '（清）曹霑撰、（清）高鶚續',
    measure: '一百二十回',
    description: '本書為長篇小說，據抄本整理。',
};

describe('ItemSummaryView（条目页服务端首屏摘要）', () => {
    it('直出的 HTML 里书名、版本、作者、卷数、提要都已转成简体，且仍带「加载中...」', async () => {
        const html = await ssr(<LocaleProvider><ItemSummaryView s={summary} source="h1" version="h1:r" /></LocaleProvider>);
        expect(html).toContain('新镌全部绣像红楼梦');
        expect(html).toContain('（清）曹霑撰、（清）高鹗续'); // 曹霑在组件库的保留名单里，不转
        expect(html).toContain('一百二十回');
        expect(html).toContain('本书为长篇小说，据抄本整理。');
        for (const trad of ['繡像', '紅樓夢', '高鶚', '為長篇']) expect(html).not.toContain(trad);
        expect(html).toContain('加载中...');
        expect(html).toContain('data-ssr-item="96kzkdm8e8"');
        expect(html).toContain('data-ssr-source="h1"');
        expect(html).toContain('data-ssr-version="h1:r"');
    });

    it('没有的字段不出空标签', async () => {
        const html = await ssr(<LocaleProvider><ItemSummaryView s={{ ...summary, edition: '', authorLine: '', measure: '', description: '' }} source="current" version="current:k" /></LocaleProvider>);
        expect(html).not.toContain('<p style="font-size:0.875rem;color:#78716c');
        expect(html).toContain('新镌全部绣像红楼梦');
    });

    it('读者选过繁体（localStorage）时，客户端会切回原文；服务端直出仍是默认简体', async () => {
        const html = await ssr(<LocaleProvider locale="zh-Hant"><ItemSummaryView s={summary} source="h1" version="h1:r" /></LocaleProvider>);
        expect(html).toContain('新鐫全部繡像紅樓夢');
    });
});
