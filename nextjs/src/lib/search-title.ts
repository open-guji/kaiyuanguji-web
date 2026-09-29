/**
 * 搜索页 <title>（不含站名，站名由根布局的 title.template 补）：「朱熹 - 搜索」→「朱熹 - 搜索 - 开源古籍」。
 * 没有检索词返回 null，用站名默认 title。
 */
export function searchPageTitle(query: string | string[] | null | undefined): string | null {
    const raw = Array.isArray(query) ? query[0] : query;
    const q = (raw ?? '').trim();
    return q ? `${q} - 搜索` : null;
}
