/**
 * @jest-environment node
 *
 * W2-2 中间件：/book-index?id=<正式 id> → 308 /item/<id>，其余一律放过。
 */
import { describe, it, expect } from '@jest/globals';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware.ssr';

function run(path: string) {
    const res = middleware(new NextRequest(`https://staging.kaiyuanguji.com${path}`));
    return { status: res.status, location: res.headers.get('location') };
}

describe('middleware.ssr', () => {
    it('只有一个正式 id → 308 /item/<id>', () => {
        expect(run('/book-index?id=d59f20aowb9c')).toEqual({
            status: 308,
            location: 'https://staging.kaiyuanguji.com/item/d59f20aowb9c',
        });
    });
    it.each([
        '/book-index',
        '/book-index?id=d59f20aowb9c&tab=collated', // 详情组件自己的 URL 同步，改写会丢 tab
        '/book-index?id=1evgpgqsis9hc', // 草稿 id：交给客户端查升格表
        '/book-index?id=1evgpgqsis9hc&redirected_from=x',
        '/book-index?id=bad..id',
        '/book-index?q=史記',
    ])('放过：%s', (path) => {
        expect(run(path).location).toBeNull();
    });
});
