/**
 * overview#267 用户意见：关于、反馈、隐私、404 页底色用暖纸色令牌（og-paper → --color-paper，与首页、条目页同一个色），
 * 不写死色值；页脚照全站，黑底（.og-footer 用墨色令牌，见 globals.css）。
 */
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: React.ReactNode }) => <main>{children}</main>);
jest.mock('@/components/feedback/FeedbackProvider', () => ({ useFeedback: () => ({ open: jest.fn() }) }));
jest.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: jest.fn() }) }));

import AboutPage from '../about/page';
import PrivacyPage from '../privacy/page';
import FeedbackPage from '../feedback/page';
import NotFound from '../not-found';

// 反馈页挂载时会取列表；jsdom 没有 fetch，桩一个空列表
beforeAll(() => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(() => Promise.resolve({ json: async () => ({ success: true, items: [] }) }));
});

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

describe('暖纸色底（overview#267）', () => {
    it.each([
        ['关于', <AboutPage key="a" />],
        ['隐私', <PrivacyPage key="p" />],
        ['反馈', <FeedbackPage key="f" />],
        ['404', <NotFound key="n" />],
    ])('%s页根元素带 og-paper', (_name, el) => {
        const { container } = render(el);
        expect(container.querySelector('.og-paper')).not.toBeNull();
    });

    it('og-paper 用 --color-paper 令牌，不写死色值；页脚黑底用 --color-ink', () => {
        expect(css).toMatch(/\.og-paper\s*\{\s*background:\s*var\(--color-paper\);\s*\}/);
        const footer = css.match(/\n\s+\.og-footer\s*\{[^}]*\}/)?.[0] ?? '';
        expect(footer).toMatch(/background:\s*var\(--color-ink\)/);
        expect(footer).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    });
});
