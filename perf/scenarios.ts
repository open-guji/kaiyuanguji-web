export type ActionType =
    | { kind: 'goto'; path: string }
    | { kind: 'wait_selector'; selector: string; timeoutMs?: number }
    | { kind: 'click'; selector: string }
    | { kind: 'fill'; selector: string; value: string }
    | { kind: 'wait_ms'; ms: number }
    | { kind: 'wait_idle'; timeoutMs?: number }
    | { kind: 'wait_lcp'; timeoutMs?: number };

export interface Scenario {
    id: string;
    name: string;
    actions: ActionType[];
    /** 等待 first-paint 或骨架消失的标记选择器（用于 perceived-ready 测量） */
    readySelector?: string;
}

const FEEDBACK_TAB = 'button:has-text("反馈"), [role="tab"]:has-text("反馈")';

export const SCENARIOS: Scenario[] = [
    {
        id: 'A1-home',
        name: '首页冷启动',
        actions: [
            { kind: 'goto', path: '/' },
            { kind: 'wait_idle', timeoutMs: 30000 },
        ],
    },
    {
        id: 'B1-bookindex-recommend',
        name: '古籍索引页（默认 tab=recommend）',
        actions: [
            { kind: 'goto', path: '/book-index' },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'B2-bookindex-catalog',
        name: '古籍索引页 - 目录书 tab',
        actions: [
            { kind: 'goto', path: '/book-index?tab=catalog' },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'B3-bookindex-collection',
        name: '古籍索引页 - 叢編 tab',
        actions: [
            { kind: 'goto', path: '/book-index?tab=collection' },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'B4-bookindex-site',
        name: '古籍索引页 - 在線資源 tab',
        actions: [
            { kind: 'goto', path: '/book-index?tab=site' },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'B5-bookindex-feedback',
        name: '古籍索引页 - 反馈 tab',
        actions: [
            { kind: 'goto', path: '/book-index?tab=feedback' },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'F1-search-global',
        name: '全局搜索「論語」',
        actions: [
            { kind: 'goto', path: '/book-index?q=' + encodeURIComponent('論語') },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'F2-search-jianti',
        name: '简体搜索「论语」',
        actions: [
            { kind: 'goto', path: '/book-index?q=' + encodeURIComponent('论语') },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'D1-detail-work',
        name: '作品详情（论语）',
        actions: [
            { kind: 'goto', path: '/book-index?id=GYL5215Antm' },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'D3-detail-entity',
        name: '人物详情（孔子）',
        actions: [
            { kind: 'goto', path: '/book-index?id=ER01jhdb52' },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
    {
        id: 'E1-collated-edition',
        name: '整理本入口（任一 has_collated 作品）',
        actions: [
            { kind: 'goto', path: '/book-index?id=GYL5215Antm' },
            { kind: 'wait_idle', timeoutMs: 60000 },
        ],
    },
];

export function findScenarios(filter?: string): Scenario[] {
    if (!filter) return SCENARIOS;
    const ids = filter.split(',').map((x) => x.trim()).filter(Boolean);
    const found = SCENARIOS.filter((s) => ids.some((id) => s.id === id || s.id.startsWith(id)));
    if (found.length === 0) {
        throw new Error(`No scenario matched filter: ${filter}. Known IDs: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    }
    return found;
}
