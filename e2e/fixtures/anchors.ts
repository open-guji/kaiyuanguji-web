/**
 * 测试锚点 —— 抗数据漂移的断言基准。
 *
 * 本站数据每天都在变（升格改 ID、新增条目、reindex），把具体数值写死在用例里
 * 必然很快失效——perf/scenarios.ts 里的 `aTNoXY45BGY3` 就是前车之鉴：该 ID 早已
 * 404，但因为老 smoke 只看字节数不看内容，测试一直"通过"。
 *
 * ⚠️ 2026-09-14：上面这段话写下之后，那个 ID **又原地烂了几个月没人换**，
 * 直到从生产错误日志里倒查出「夜跑 perf 每晚往线上打一条 404」才发现；
 * 同时查出 E1 的 ID 也 404、本文件的 entity 锚点是草稿墓碑。
 * ⇒ **写进注释挡不住事，得有闸。** 现由 contract/perf-ids.spec.ts 逐个核：
 * 凡被测试/压测当锚点的 ID，必须能取到且不是墓碑。
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
 *
 * ⚠️ 2026-09-14 再下调 entities 下界 35_000 → 20_000。**实测 31116，不是打包出问题。**
 *
 * 09-04 那次之所以没动 entities，是因为当时它**不参与升格**，墓碑比值精确为 1.000
 * （见 `nextjs/scripts/bundle-data.mjs` 那段注释，entities 正是那次的对照组）。
 * 此后两件事同时发生：Entity 开始升格（draft 侧多出墓碑，打包时按规矩跳过），
 * 且 `C-entity` 那几道办竣 **4,456 条併條**——重复人物被合并掉了。
 *
 * 逐项对得上，且方向相反的两类在涨，故判为真数而非漏打包：
 *
 * | | book-index 逐仓实测（09-08）＋已办併條 | meta.json（09-14） |
 * |---|---|---|
 * | entities | production 30,875 ＋ draft 活条 206 = **31,081** | **31,116** |
 * | works    | production 95,357 − 併條 446 = **94,911**        | **94,912** |
 * | books    | 20,853 → 涨                                      | 20,894 |
 * | collections | 76 → 涨                                       | 84 |
 *
 * 漏打包会让四类一起塌，且 deploy 的「Verify production entries bundled」那步会红——它绿的。
 *
 * 新下界按本表 ~±40% 的约定取：31,116 × 0.6 ≈ 18.7k，取整 20_000。
 * Entity 清账仍有余量待办（A3 33／B 3／C 36 待人裁），还会再掉一些，20k 容得下。
 *
 * 10-08 数据发布后 books 实测 60,985，越过原上限 60k（数据包基础闸门绿，批 12/13 新增书目所致），按真实增长处理；
 * 上限按 ~±40% 约定上调到 100k。
 */
export const COUNT_RANGES = {
    works: { min: 60_000, max: 200_000 },
    books: { min: 12_000, max: 100_000 },
    collections: { min: 40, max: 500 },
    entities: { min: 20_000, max: 200_000 },
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
     * 下列数字来自 items/<id>/default/index.json（chapters），属结构性事实，
     * 除非重新整理这部书，否则不会变。
     */
    collated: {
        id: 'd59f2htm01du',
        title: '直齋書錄解題',
        titleSimplified: '直斋书录解题',
        /**
         * default/index.json 的 chapters 条数——章数的唯一可信来源。
         * 曾有 total_juan 等三个统计字段与之并存但长期没人维护、对不上，
         * 2026-09-03 已从数据与前端删除；2026-09-30 起整理本迁到新结构（overview#307），故这里锚 chapters。
         */
        juanFileCount: 56,
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

    /**
     * 阅读页默认版本是维基全文时，直齋的目录条数：维基文库 22 卷（wikisource/index.json 的 chapters）。
     * 阅读页只展示全文版、不列目录型整理本（overview#456），所以 /read/<直齋> 的侧栏是这 22 章，不是整理本的 56 章。
     */
    collatedReaderChapterCount: 22,

    /**
     * 整理本的结构化渲染（分类标题、「N 部书」统计、书名标题、「正文」视图）的守门锚点：要一部整理本**仍是阅读页主版本**的书。
     * 直齋有维基全文版后阅读页只展示全文版（overview#456），整理本的结构化视图在它身上看不到了，所以这几条改锚这部：
     * d59f2s1j1mv4（明朝题本档案汇编，8 卷、每卷是一串 type=book 的条目），manifest 只有 default／collated 一个版本，章目录是平的（一卷…八卷）。
     * （选平目录的书：按章名分组的目录，侧栏顶层按钮数不等于章数。）
     * 数字来自 items/<id>/default/index.json（chapters＝8）与 002.json（「二卷」25 条 book）。
     * 这部书若被加了全文版，整理本会从阅读页消失，这几条用例会红，届时换一部仍只有整理本的书（book-text 里 manifest 只有 default／collated 的）。
     */
    collatedOnly: {
        id: 'd59f2s1j1mv4',
        /** default/index.json 的 chapters 条数 */
        juanFileCount: 8,
        sampleJuanFile: 'juan/002.json',
        /** 章标题（繁简两种写法；本书数据本身是简体）；页面上可能有多个同名标题，用例里取第一个 */
        sampleJuanCategory: '二卷',
        sampleJuanCategorySimplified: '二卷',
        /** 该卷 type=book 的 section 数 */
        sampleJuanBookCount: 25,
        sampleJuanFirstBook: '兵部尚书张凤翼等为老回回就歼有功员役另叙事题本',
        sampleJuanFirstBookSimplified: '兵部尚书张凤翼等为老回回就歼有功员役另叙事题本',
    },

    /**
     * 人物实体：用于验证 Entity 详情页。孔子，已升格到 production。
     *
     * 2026-09-14 换过一次：原值 `1j96hewiuieps` 是**草稿墓碑**
     * （`_promoted_to: hixhd2h9bk4b`，2026-08-25 升的格）。它返回 200、页面也能打开，
     * 所以「人物页可打开」一直是绿的——量的却是跳转 stub 而不是真的人物页。
     * 墓碑与真条目在「HTTP 200 且 main 可见」这个判据上长得一模一样，
     * 故 contract/perf-ids.spec.ts 另立一闸，专门查 `_promoted_to`。
     */
    entity: {
        id: 'hixhd2h9bk4b',
    },
} as const;

/**
 * 空状态样本候选池（档位 1 的用法，虽然池子里装的是具体 ID）。
 *
 * 「这个条目什么都没有」不是稳定事实——它正是本项目每天在消灭的东西。
 * 所以不锚单个 ID：用例运行时逐个拉 entry JSON 验证，取第一个**当下仍然
 * 为空**的（见 fixtures/preconditions.ts 的 pickEmptySample）。某条被整理
 * 了就自动换下一条，全池用尽才跳过。
 *
 * 池子的来源与口径（2026-09-05 扫 book-index 生产库全量）：
 *   空作品   2 / 91,686   —— 判据同 UI：无版本/资源/著录/考证/关联/简介
 *   空人物 451 / 30,159   —— 判据同 UI：works 为空
 * 空作品只有两条，是因为 UI 那句「尚未著錄該作品的版本、資源與書目收錄」
 * 要求上述六项**全部**为空；只差一项就走不到这个分支。
 *
 * 人物候选另经一道筛：排除掉已被某部 Work 的 authors[].entity_id 反向引用
 * 的（451 中有 24 条如此）——那是数据不一致，迟早会被修成有作品。剩下的
 * 再人工剔掉名气大、注定会被整理的（徐弘祖＝徐霞客、王翬、葉方藹、沈作喆）。
 *
 * 池子见底时用例会跳过并提示重新生成。重新生成的口径就是上面两条判据，
 * 扫 book-index 仓即可。
 */
export const EMPTY_STATE_POOL = {
    /** 清史稿藝文志裸题条目，撰人不可考，无人整理 */
    work: [
        'd59f2rxf35ds',  // 詩集（十二卷，清史稿藝文志集部別集類）
        'd59f2s1eob9c',  // 音（一卷，清史稿藝文志經部春秋類輯佚）
    ],
    /** 无关联作品且无作品反向指向的冷僻人物 */
    entity: [
        'hixhd2h9bcme',  // 蔣良驥（清）——原用例所锚，留作首选以延续覆盖
        'hixhd2h9bdpx',  // 王愈擴（清）
        'hixhd2h9bdwe',  // 吳啟昆（清）
        'hixhd2h9bdz7',  // 陸化熙（明）
        'hixhd2h9bdz8',  // 鄒忠允（明）
        'hixhd2h9be34',  // 湯啟祚（清）
        'hixhd2h9be9t',  // 楊暄（明）
        'hixhd2h9bfoq',  // 王偕（元）
        'hixhd2h9bfv1',  // 方宏靜（明）
        'hixhd2h9bg06',  // 翟鳳翥（清）
        'hixhd2h9bg1x',  // 魏麟徵（清）
    ],
} as const;

/** 搜索用例：繁简两种写法都必须能召回结果 */
export const SEARCH_QUERIES = [
    { q: '論語', label: '繁体' },
    { q: '论语', label: '简体' },
] as const;

/**
 * L1 各索引**必须具备**的 settings（2026-09-21 事故后新增）。
 *
 * 事故形态：2026-09-07 works 索引被 delete+create 重建，但收尾的
 * settingsUpdate 没跑（full-reindex.mjs 里 works 走的是 :526 那条单独分支，
 * 与其余三类的 :548 不同路）。后果——works 退回 Meili 默认设置：
 * filterableAttributes 为空。
 *
 * 而前端每次搜索都带 `filter=is_draft = false`（见 meili-storage.ts），
 * 于是 works 查询一律 400 报错；searchAll 用的是 allSettled，「一挂三好」
 * 不触发熔断，works 静默返回空数组。用户看到的就是：搜「史记」有书籍、
 * 有丛编、有人物，**唯独作品是空的**。持续 13 天无人发现。
 *
 * 为什么原有探活全都没抓到：
 *   · health-probe.sh 与本文件既有用例，查询都**不带 filter** —— 不带
 *     filter 的查询在设置丢失时照样 200，看着一切正常；
 *   · /health 是绿的，索引文档数 91400 也是满的。
 * 也就是说：**光探「能不能搜」探不出「前端那条真实查询能不能搜」**。
 *
 * 所以这里锚两层：settings 本身（直接因），以及带 filter 的真实查询（症状）。
 * 断言用「必须包含」而非全等，给日后新增字段留余地。
 */
export const MEILI_INDEX_SETTINGS = {
    works: {
        filterable: ['is_draft', 'type', 'dynasty', 'subtype', 'has_collated', 'has_text', 'has_image'],
        searchable: ['title_search', 'aliases_search', 'author_search', 'pinyin'],
    },
    books: {
        filterable: ['is_draft', 'type', 'dynasty', 'has_text', 'has_image', 'holder'],
        searchable: ['title_search', 'edition_search', 'author_search', 'pinyin'],
    },
    collections: {
        filterable: ['is_draft', 'type'],
        searchable: ['title_search', 'pinyin'],
    },
    entities: {
        filterable: ['is_draft', 'type', 'subtype', 'dynasty'],
        searchable: ['name_search', 'pinyin'],
    },
} as const;

/** book-index 页旧的 5 个页签（10-01 起首页态改为元数据首页，页签已去掉；旧地址仍要能打开） */
export const BOOK_INDEX_TABS = [
    'recommend',
    'catalog',
    'collection',
    'site',
    'feedback',
] as const;
