/**
 * 对校网址参数 `?cmp=<对照本条目id>-<版本key>`：按第一个 `-` 拆；版本 key 省略＝该条目主版本；
 * 条目 id 是 [0-9a-z]+（无连字符），版本 key 沿用阅读页路径里的写法（字母开头，[a-z0-9-]）。
 * 一期只认第一个（将来多个用逗号分隔）。不合法返回 null（静默忽略）。
 */
export interface CompareTarget {
    id: string;
    /** 省略＝主版本 */
    key?: string;
}

const ID_RE = /^[0-9a-z]+$/;
const KEY_RE = /^[a-z][a-z0-9-]*$/;

export function parseCmp(raw: string | null | undefined): CompareTarget | null {
    if (!raw) return null;
    const first = raw.split(',')[0].trim();
    const dash = first.indexOf('-');
    const id = dash < 0 ? first : first.slice(0, dash);
    const key = dash < 0 ? undefined : first.slice(dash + 1);
    if (!ID_RE.test(id)) return null;
    if (key !== undefined && !KEY_RE.test(key)) return null;
    return key ? { id, key } : { id };
}

export function formatCmp(t: CompareTarget): string {
    return t.key ? `${t.id}-${t.key}` : t.id;
}
