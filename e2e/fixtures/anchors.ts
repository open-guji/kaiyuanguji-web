/**
 * 测试锚点 —— 抗数据漂移的断言基准。
 *
 * 本站数据每天都在变（升格改 ID、新增条目、reindex），把具体数值写死在用例里
 * 必然很快失效——perf/scenarios.ts 里的 `aTNoXY45BGY3` 就是前车之鉴：该 ID 早已
 * 404，但因为老 smoke 只看字节数不看内容，测试一直"通过"。
 *
 * 所以断言分三档，优先用前两档：
 *   1. 结构性 —— 只断言"存在且形态对"，不写死数值（最抗漂移）
 *   2. 量级   —— 断言落在合理区间，防的是归零/暴跌这类灾难性回归
 *   3. 精确   —— 只用于长期稳定的经典条目（史記的作者不会变成别人）
 */

/** 被测站点，默认线上；本地验证传 TARGET=http://localhost:3000 */
export const TARGET = process.env.TARGET ?? 'https://www.kaiyuanguji.com';

/** 数据源 COS（经 EdgeOne 反代） */
export const DATA_BASE = process.env.DATA_BASE ?? 'https://data.kaiyuanguji.com';

/** 搜索 L1（Meilisearch，上海）。公开只读 key，非机密。 */
export const MEILI_BASE = process.env.MEILI_BASE ?? 'https://api.kaiyuanguji.com';
export const MEILI_KEY =
    process.env.MEILI_KEY ??
    '1b0b438f7eadd34e1a6b53c76d63bd3614822d3ec9856251c9340a78456c5465';

/**
 * 全局统计的合理区间（档位 2）。
 * 区间给得宽（约 ±40%），只为拦住"数据没打包进去"「索引塌了」这类灾难，
 * 不为追踪日常增长——日常增长撞到上界时，把上界调大即可。
 *
 * ⚠️ 2026-09-04 下调：旧区间基于 meta.json 的 works=181097 等数字，而那些
 * 数字把升格墓碑算了两遍（bundle-data.mjs 漏了 promoted_to 过滤，见该文件
 * 注释）。修复后 works 回到真实的 ~91k，books ~21k，collections ~72。
 * 旧下界 works>=120_000 会因此误报，故按真实量级重设。
 * 取值时刻：2026-09-04（修复后），works≈91125 books≈20841
 * collections≈72 entities≈58669。
 */
export const COUNT_RANGES = {
    works: { min: 60_000, max: 200_000 },
    books: { min: 12_000, max: 60_000 },
    collections: { min: 40, max: 500 },
    entities: { min: 35_000, max: 200_000 },
} as const;

/**
 * 稳定锚点条目（档位 3）。
 * 选的都是经典中的经典，且已升格到 production —— 短期内不会被删除或改名。
 * 若某天真的被合并/改 ID，测试会红，那时更新此处即可（这正是我们想要的信号）。
 */
export const ANCHORS = {
    /** 作品：史記。用于验证作品详情页的基本信息、关联版本、资源区块 */
    work: {
        id: 'd59f20aowb9c',
        title: '史記',
        titleSimplified: '史记',
        author: '司馬遷',
        authorSimplified: '司马迁',
        /** 关联的 Book（版本）与 related_works 数量都很大，断言"不为空"即可 */
        minBooks: 10,
        minRelatedWorks: 20,
    },

    /**
     * 整理本：直齋書錄解題。
     * 这是本次一连串 bug 的爆发点（tab 消失 / "0 部书" / 书名不渲染），
     * 用它做整理本渲染的守门用例最合适。
     * 下列数字来自 collated_edition/index.json，属结构性事实，
     * 除非重新整理这部书，否则不会变。
     */
    collated: {
        id: 'd59f2htm01du',
        title: '直齋書錄解題',
        titleSimplified: '直斋书录解题',
        totalJuan: 22,
        totalCategories: 56,
        totalSections: 3062,
        /** 卷四「禮類」——修复前这一卷显示"0 部书"且无书名标题 */
        sampleJuanFile: 'juan/004.json',
        sampleJuanCategory: '禮類',
        sampleJuanCategorySimplified: '礼类',
        /** 该卷实际书目条目数（type=book 的 section 数） */
        sampleJuanBookCount: 55,
        /** 该卷首条书目，用于验证书名标题确实渲染出来了 */
        sampleJuanFirstBook: '《古禮經》十七卷',
        sampleJuanFirstBookSimplified: '《古礼经》十七卷',
    },

    /** 人物实体：用于验证 Entity 详情页 */
    entity: {
        id: '1j96hewiuieps',
    },
} as const;

/** 搜索用例：繁简两种写法都必须能召回结果 */
export const SEARCH_QUERIES = [
    { q: '論語', label: '繁体' },
    { q: '论语', label: '简体' },
] as const;

/** book-index 页的 5 个 tab */
export const BOOK_INDEX_TABS = [
    'recommend',
    'catalog',
    'collection',
    'site',
    'feedback',
] as const;
