/**
 * 网站界面文字的统一入口（overview#337）。
 *
 * - 客户端组件：const t = useSiteT(); t('footer.about')
 * - 服务端组件：<T k="footer.about" />（小客户端组件，跟随繁简偏好）
 * - 服务端直出的 <title>、meta：getSiteT('zh-Hans')——服务端拿不到偏好（存在 localStorage），一律简体
 *
 * 数据文字（书名、作者等）不走这里：用组件库的 useConvert（BimLocaleProvider 范围内），
 * 服务端用 lib/server/simplify 的 toSimplified。
 */
import type { SiteLocale } from '@/lib/site-locale';
import { NAMESPACES, type SiteMessages } from './messages';

/** 字典里所有字符串叶子的点路径，如 'footer.about' */
type Leaves<T, P extends string = ''> = {
    [K in keyof T & string]: T[K] extends string
        ? `${P}${K}`
        : T[K] extends Record<string, unknown> ? Leaves<T[K], `${P}${K}.`> : never;
}[keyof T & string];

export type SiteMessageKey = Leaves<SiteMessages>;
export type SiteT = (key: SiteMessageKey, vars?: Record<string, string | number>) => string;

const CACHE = new Map<SiteLocale, SiteMessages>();

export function getSiteMessages(locale: SiteLocale): SiteMessages {
    let m = CACHE.get(locale);
    if (!m) {
        const out = {} as Record<string, unknown>;
        for (const [k, set] of Object.entries(NAMESPACES)) out[k] = (set as Record<SiteLocale, unknown>)[locale];
        m = out as SiteMessages;
        CACHE.set(locale, m);
    }
    return m;
}

function lookup(messages: unknown, key: string): string | undefined {
    let cur: unknown = messages;
    for (const part of key.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : undefined;
}

function format(s: string, vars: Record<string, string | number>): string {
    return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

const T_CACHE = new Map<SiteLocale, SiteT>();

/** 取某语言的 t()：缺键回落繁体，再缺原样返回键名（便于发现漏登记） */
export function getSiteT(locale: SiteLocale): SiteT {
    let t = T_CACHE.get(locale);
    if (!t) {
        const messages = getSiteMessages(locale);
        t = (key, vars) => {
            const s = lookup(messages, key) ?? lookup(getSiteMessages('zh-Hant'), key) ?? key;
            return vars ? format(s, vars) : s;
        };
        T_CACHE.set(locale, t);
    }
    return t;
}
