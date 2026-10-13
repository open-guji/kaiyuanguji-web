/**
 * @jest-environment jsdom
 *
 * overview#581 方案 A 第 3 项：服务端直出的首章正文——SSR 里有正文与真链接，水合不报错，阅读器内容出来后卸载。
 */
import { describe, it, expect, jest } from '@jest/globals';
import React, { act, useRef } from 'react';
// jsdom 下 react-dom/server 解析到浏览器版（缺 MessageChannel），与 ItemSummaryView.test 一样用 node 版
const { renderToString } = require('react-dom/server.node') as typeof import('react-dom/server');
import { hydrateRoot } from 'react-dom/client';
import ReaderLead, { type ReaderLeadData } from '../ReaderLead';

const DATA: ReaderLeadData = {
    paragraphs: ['洪範之書起於禹。', '箕子傳之。'],
    truncated: true,
    selfHref: '/read/x/001',
    prev: { href: '/read/x/000', label: '序' },
    next: { href: '/read/x/002', label: '卷二' },
    itemHref: '/item/x',
    itemLabel: '洪範傳·书目详情',
};

function Host({ withReader }: { withReader?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
        <div ref={ref}>
            <div id="reader">{withReader ? '读'.repeat(500) : '加载中…'}</div>
            <ReaderLead data={DATA} hostRef={ref} />
        </div>
    );
}

describe('ReaderLead', () => {
    it('SSR：正文段落、继续阅读、上下章与书目页都是真 <a href>', () => {
        const html = renderToString(<Host />);
        expect(html).toContain('洪範之書起於禹。');
        expect(html).toContain('href="/read/x/001"'); // 继续阅读指向本页自己
        expect(html).toContain('href="/read/x/000"');
        expect(html).toContain('href="/read/x/002"');
        expect(html).toContain('href="/item/x"');
        expect(html).not.toContain('display:none');
    });

    it('水合无报错；阅读器内容长出来后卸载', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        const el = document.createElement('div');
        el.innerHTML = renderToString(<Host />);
        document.body.appendChild(el);
        const root = hydrateRoot(el, <Host />);
        await act(async () => {});
        expect(errors).not.toHaveBeenCalled();
        expect(el.querySelector('[data-reader-lead]')).not.toBeNull();
        await act(async () => { el.querySelector('#reader')!.textContent = '读'.repeat(500); });
        await act(async () => {});
        expect(el.querySelector('[data-reader-lead]')).toBeNull();
        root.unmount();
        errors.mockRestore();
    });
});
