import { describe, it, expect } from '@jest/globals';
import { canonicalRedirectTarget, normalizeHost, CANONICAL_HOST, MOVED_HASH } from '../site-hosts';

const go = (host: string | null, pathname = '/', search = '', method = 'GET') =>
    canonicalRedirectTarget({ host, method, pathname, search });

describe('canonicalRedirectTarget（主域名迁移 overview#275）', () => {
    it('旧域名 www／裸域 → 新域名同一路径，保留查询串，带横幅片段', () => {
        expect(go('www.kaiyuanguji.com', '/item/d59f20aowb9c', '?tab=lineage')).toBe(`https://${CANONICAL_HOST}/item/d59f20aowb9c?tab=lineage${MOVED_HASH}`);
        expect(go('kaiyuanguji.com', '/')).toBe(`https://${CANONICAL_HOST}/${MOVED_HASH}`);
    });
    it('新域名裸域 → www，不带横幅片段', () => {
        expect(go('openguji.com', '/read/abc', '?x=1')).toBe(`https://${CANONICAL_HOST}/read/abc?x=1`);
    });
    it('规范主机、测试站、data／api 主机、未知主机都放过', () => {
        for (const h of [CANONICAL_HOST, 'staging.kaiyuanguji.com', 'staging.openguji.com', 'data.kaiyuanguji.com', 'api.kaiyuanguji.com', 'localhost:3000', '', null]) {
            expect(go(h, '/item/x')).toBeNull();
        }
    });
    it('主机名大小写、端口不影响判断', () => {
        expect(normalizeHost('WWW.KaiyuanGuji.com:443')).toBe('www.kaiyuanguji.com');
        expect(go('WWW.KAIYUANGUJI.COM', '/a')).not.toBeNull();
    });
    it.each(['/api/feedback', '/api/version', '/oauth/token', '/.well-known/openid-configuration', '/_next/static/x.js'])('保留前缀 %s 不跳', (p) => {
        expect(go('www.kaiyuanguji.com', p)).toBeNull();
    });
    it('非 GET／HEAD 不跳；HEAD 跳', () => {
        expect(go('www.kaiyuanguji.com', '/item/x', '', 'POST')).toBeNull();
        expect(go('www.kaiyuanguji.com', '/item/x', '', 'HEAD')).not.toBeNull();
    });
    it('只是前缀相似的页面路径照常跳（/apix 不是 /api/）', () => {
        expect(go('www.kaiyuanguji.com', '/apix')).not.toBeNull();
    });
});

describe('icpForHost（页脚备案号按域名）', () => {
    it('openguji.com 及未知主机 → -2；kaiyuanguji.com 各主机 → 原号', async () => {
        const { icpForHost, ICP_OPENGUJI, ICP_KAIYUANGUJI } = await import('../site-hosts');
        expect(ICP_OPENGUJI).toBe('冀ICP备2026013455号-2');
        for (const h of ['www.openguji.com', 'openguji.com', null, 'localhost']) expect(icpForHost(h)).toBe(ICP_OPENGUJI);
        for (const h of ['www.kaiyuanguji.com', 'kaiyuanguji.com', 'staging.kaiyuanguji.com']) expect(icpForHost(h)).toBe(ICP_KAIYUANGUJI);
    });
});
