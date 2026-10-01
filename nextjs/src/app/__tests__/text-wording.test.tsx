import { render } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({ push: jest.fn() }),
}));

import HomePage from '../page';
import AboutPage from '../about/page';
import BetaPage from '../beta/page';
import { FEEDBACK_TYPES } from '@/lib/feedback';

/**
 * 用户 10-01：页面上不再出现「整理本」「转录全文」「全文」，统一叫「文本」（overview#322）。
 * 「全文检索」「全文搜索」是功能名（在正文里检索），不是类别词，照留。
 */
const CATEGORY_WORDS = /整理本|转录全文|轉錄全文|全文(?!检索|搜索)/;

describe('页面文案不出类别词「整理本」「全文」', () => {
    it.each([
        ['首页', HomePage],
        ['关于', AboutPage],
        ['内测说明', BetaPage],
    ])('%s', (_, Page) => {
        const { container } = render(<Page />);
        expect(container.textContent).not.toMatch(CATEGORY_WORDS);
    });

    it('反馈表单的提示语', () => {
        for (const t of FEEDBACK_TYPES) expect(t.placeholder ?? '').not.toMatch(CATEGORY_WORDS);
    });
});
