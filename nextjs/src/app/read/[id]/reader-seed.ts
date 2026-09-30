/**
 * WEB2（overview#249 Q2；overview#307 E 块改成新结构）：阅读页首屏数据，服务端取好随页面交给 ReaderClient。
 *
 * 阅读器（book-index-ui 的 TextReader）开页要走 manifest → 版本目录 → 首章正文这条串行链，LCP 全压在上面。
 * 服务端校验地址时已经读过 manifest 与版本目录（lib/server/reader-check.ts，进程内缓存），顺手把首章正文也取了，
 * 一起交给浏览器：seedTransport 就地返回这三次调用，不再发请求。
 *
 * 只管首屏那一章：翻章、换版本照常走 transport。取不到的项就不放，阅读器自己去取。
 * 本文件客户端、服务端共用，不能引服务端模块。
 */
import type { IndexStorage } from 'book-index-ui/storage';

export interface ReaderSeed {
    /** transport 调用 → 结果，键见 seedCallKey */
    calls?: Record<string, unknown>;
}

/** transport 方法名＋参数 → 种子键 */
export function seedCallKey(method: string, ...args: string[]): string {
    return [method, ...args].join('\u0000');
}

/**
 * 包一层 transport：调用命中种子就直接返回，否则照原样转给底层。
 * 命中只看前面的字符串参数（条目 id、版本 key、章号）；末尾的选项对象（getChapter 的 `{ json }`）不参与匹配。
 * 种子里没有值（null／undefined）的不拦，免得把「服务端没取到」当成「没有」。
 */
export function seedTransport<T extends IndexStorage>(transport: T, calls: Record<string, unknown> | undefined): T {
    if (!calls || Object.keys(calls).length === 0) return transport;
    return new Proxy(transport, {
        get(target, prop, receiver) {
            const orig = Reflect.get(target, prop, receiver);
            if (typeof prop !== 'string' || typeof orig !== 'function') return orig;
            return (...args: unknown[]) => {
                const strs = args.filter((a): a is string => typeof a === 'string');
                // 字符串参数必须在前、其余（选项对象）在后
                if (strs.length > 0 && args.slice(0, strs.length).every((a) => typeof a === 'string')) {
                    const hit = calls[seedCallKey(prop, ...strs)];
                    if (hit !== undefined && hit !== null) return Promise.resolve(hit);
                }
                return (orig as (...a: unknown[]) => unknown).apply(target, args);
            };
        },
    });
}
