/**
 * 古籍总目客户端部分（N4b）：book-index-ui 的 CatalogPage 接到路由上——
 * 选节点、翻页、「全部」行落到默认节点；作品卡与分页是真链接。
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

import CatalogClient from '../CatalogClient';

const TREE = [
    { id: 'cjing', label: '經部', count: 1 },
    { id: 'cshi', label: '史部', count: 60, children: [{ id: 'czhengshi', label: '正史類', count: 60 }] },
    { id: 'unclassified', label: '未分類', count: 5 },
];

async function setup(page = 2) {
    const r = render(
        <CatalogClient
            tree={TREE}
            selectedId="czhengshi"
            page={page}
            pageCount={3}
            works={[
                { id: 'd59f282rkphc', title: '三國志', juan: 65, authors: [{ name: '陳壽', dynasty: '西晉' }], summary: '晉陳壽撰。', classification: ['史部', '正史類'] },
                { id: 'w2', title: '某書', juan: '一百三十篇' },
            ]}
        />,
    );
    // LocaleProvider 挂载后异步加载繁简转换，等它落定
    await act(async () => {});
    return r;
}

beforeEach(() => mockPush.mockReset());

describe('CatalogClient', () => {
    it('作品卡是真链接，指向条目页；字符串卷数原样显示', async () => {
        await setup();
        const card = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/item/d59f282rkphc');
        expect(card).toBeTruthy();
        expect(card).toHaveTextContent('三國志');
        expect(screen.getByText(/一百三十篇/)).toBeInTheDocument();
    });

    it('分页是真链接（第 1 页不带 page）', async () => {
        await setup();
        const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
        expect(hrefs).toContain('/catalog?node=czhengshi');
        expect(hrefs).toContain('/catalog?node=czhengshi&page=3');
    });

    it('选节点：跳到该节点页', async () => {
        await setup();
        const tree = screen.getAllByRole('tree')[0];
        await userEvent.click(within(tree).getByText('經部'));
        expect(mockPush).toHaveBeenCalledWith('/catalog?node=cjing');
    });

    it('「全部」行：先落到不带 node 的地址（默认节点），不出 404', async () => {
        await setup();
        const tree = screen.getAllByRole('tree')[0];
        await userEvent.click(within(tree).getByText('全部'));
        expect(mockPush).toHaveBeenCalledWith('/catalog');
    });
});
