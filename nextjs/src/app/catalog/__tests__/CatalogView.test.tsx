/**
 * 古籍总目过渡渲染（N4b）：卡片字段、分类树展开与高亮、分页。
 */
import { describe, it, expect } from '@jest/globals';
import { render, screen, within } from '@testing-library/react';
import CatalogView, { pageList } from '../CatalogView';
import { catalogHref } from '../catalog-route';

const TREE = [
    { id: 'cjing', label: '經部', count: 1, children: [{ id: 'cyi', label: '易類', count: 1 }] },
    { id: 'cshi', label: '史部', count: 60, children: [{ id: 'czhengshi', label: '正史類', count: 60 }] },
    { id: 'unclassified', label: '未分類', count: 5 },
];

function setup(page = 1) {
    const path = [TREE[1], TREE[1].children![0]];
    return render(
        <CatalogView
            tree={TREE}
            selectedId="czhengshi"
            path={path}
            page={page}
            pageCount={3}
            works={[
                {
                    id: 'd59f282rkphc', title: '三國志', juan: 65,
                    authors: [{ name: '陳壽', dynasty: '西晉' }, { name: '裴松之' }],
                    summary: '晉陳壽撰。', classification: ['史部', '正史類'],
                },
                { id: 'w2', title: '某書' },
            ]}
            nodeHref={(id) => catalogHref(id)}
            pageHref={(p) => catalogHref('czhengshi', p)}
            workLink={(id) => `/item/${id}`}
        />,
    );
}

describe('CatalogView', () => {
    it('卡片：书名、卷数、作者朝代、提要、分类签，整张是真链接', () => {
        setup();
        const link = screen.getByRole('link', { name: /三國志/ });
        expect(link).toHaveAttribute('href', '/item/d59f282rkphc');
        expect(link).toHaveTextContent('65卷');
        expect(link).toHaveTextContent('陳壽（西晉）、裴松之');
        expect(link).toHaveTextContent('晉陳壽撰。');
        expect(link).toHaveTextContent('史部·正史類');
        expect(screen.getByRole('link', { name: '某書' })).toHaveAttribute('href', '/item/w2');
    });

    it('分类树：当前节点高亮，只展开当前路径，未分類在最后', () => {
        const { container } = setup();
        const aside = container.querySelector('.og-cat-aside') as HTMLElement;
        const cur = within(aside).getByRole('link', { current: 'page' });
        expect(cur).toHaveTextContent('正史類60');
        expect(cur).toHaveAttribute('href', '/catalog?node=czhengshi');
        expect(within(aside).queryByText('易類')).toBeNull();
        const tops = within(aside).getAllByRole('link').map((a) => a.textContent);
        expect(tops[tops.length - 1]).toBe('未分類5');
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('史部 › 正史類');
    });

    it('分页：上一页／下一页与页码', () => {
        setup(2);
        const nav = screen.getByRole('navigation', { name: '分页' });
        expect(within(nav).getByText('上一页')).toHaveAttribute('href', '/catalog?node=czhengshi');
        expect(within(nav).getByText('下一页')).toHaveAttribute('href', '/catalog?node=czhengshi&page=3');
        expect(within(nav).getByLabelText('第2页')).toHaveAttribute('aria-current', 'page');
    });

    it('第 1 页没有上一页链接', () => {
        setup(1);
        const nav = screen.getByRole('navigation', { name: '分页' });
        expect(within(nav).getByText('上一页').tagName).toBe('SPAN');
    });

    it('pageList：首尾＋当前前后两页，中间省略', () => {
        expect(pageList(1, 1)).toEqual([1]);
        expect(pageList(1, 5)).toEqual([1, 2, 3, null, 5]);
        expect(pageList(10, 20)).toEqual([1, null, 8, 9, 10, 11, 12, null, 20]);
        expect(pageList(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    });
});
