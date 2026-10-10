/**
 * 被测站点的「形态」—— 同一套用例要能打三种站：
 *
 *   | 站 | 架构 | noindex | canonical 指向 |
 *   |----|------|---------|----------------|
 *   | https://staging.kaiyuanguji.com  | 全栈（SSR＋中间件） | 有 | 自己 |
 *   | https://ssr-test.kaiyuanguji.com | 全栈（接正式 KV 与正式数据，切域名前的 www 预演） | 无 | www |
 *   | https://www.kaiyuanguji.com      | 静态导出（切域名前） | 无 | — |
 *
 * 全栈特有的行为（/item/<id> 服务端渲染、308 跳转、sitemap 分片）在静态站上不存在，
 * 那几条用例要跳过；但「跳过」必须有闸，否则切域名后 www 变成全栈、这里还当它是静态站，
 * 新架构的用例就会在正式站上集体静默跳过。闸见 contract/fullstack.spec.ts 的
 * 「静态站声明仍然成立」：声明为静态的站若 /item/<id> 已能打开，直接报红。
 *
 * 每项都能用环境变量覆盖（本地打 localhost、或切域名后临时改口径）：
 *   SITE_ARCH=fullstack|static    EXPECT_NOINDEX=1|0    CANONICAL_ORIGIN=https://…
 */
import { TARGET } from './anchors';

/** 已知的全栈站。切域名后把 www 加进来（或 deploy.yml 的 verify 传 SITE_ARCH=fullstack） */
const FULLSTACK_HOSTS = ['staging.kaiyuanguji.com', 'ssr-test.kaiyuanguji.com', 'localhost', '127.0.0.1'];

const host = new URL(TARGET).hostname;
const isStaging = host.startsWith('staging.');

function envFlag(name: string): boolean | undefined {
    const v = process.env[name];
    if (v === undefined || v === '') return undefined;
    return v === '1' || v.toLowerCase() === 'true';
}

export const SITE = {
    host,
    /** 是否按全栈（SSR）架构验收 */
    fullstack: process.env.SITE_ARCH
        ? process.env.SITE_ARCH === 'fullstack'
        : FULLSTACK_HOSTS.includes(host),
    /** 页面是否应带 <meta name="robots" content="noindex">（测试站全站 noindex，正式站没有） */
    noindex: envFlag('EXPECT_NOINDEX') ?? isStaging,
    /**
     * canonical／sitemap <loc> 的源站。ssr-test 是「将来的 www」，构建时 SITE_URL 就是 www，
     * 所以它的 canonical 与 sitemap 都指向 www——这是设计如此，不是 bug。
     */
    canonicalOrigin: (process.env.CANONICAL_ORIGIN
        ?? (isStaging || host === 'localhost' || host === '127.0.0.1'
            ? new URL(TARGET).origin
            : 'https://www.openguji.com')).replace(/\/$/, ''),
} as const;
