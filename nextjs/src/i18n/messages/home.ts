import { defineMessages } from './define';

/** 首页：首屏、「我们在做的事」、「文本开放／代码开源」 */
export const home = defineMessages({
    kicker: '古籍數字化開放平台',
    title: '讓科技賦予古籍數字生命',
    lead: '把散在各處的歷代書目、存世版本與文本聚到一起，建一座開放、可查證、自由使用的古籍文庫。',
    count: '已收錄 11 萬+ 條古籍索引',
    examples: {
        shiji: '史記',
        siku: '四庫全書',
        hongloumeng: '紅樓夢程甲本',
    },
    search: {
        placeholder: '書名、作者、版本，如：史記、蘇軾',
        aria: '搜索古籍索引',
        submit: '搜索',
    },
    featuresTitle: '我們在做的事',
    featuresMeta: '古籍元數據、資源收集已上線，其餘在陸續推進',
    live: '已上線',
    planned: '規劃中',
    plannedMore: '還有 {count} 項規劃中：{list}',
    plannedSep: '、',
    expand: '展開',
    collapse: '收起規劃中的 {count} 項',
    features: {
        metadata: {
            title: '古籍元數據',
            text: '以作品為綱，把歷代官私書目的著錄與存世各版本匯到同一條目下，一眼看清一部書的來龍去脈。',
            cta: '進入古籍總目',
        },
        resources: {
            title: '資源收集',
            text: '收集網上已有的文字資源和影印資源，逐條掛到對應的作品與版本下，順著鏈接就能查到出處。',
        },
        imageText: {
            title: '圖文對讀',
            text: '識別出的每個字對回書影上的位置，讀文字時隨時對看原書。',
        },
        fullText: {
            title: '全文檢索',
            text: '在書名、作者之外，檢索古籍文本；異體、繁簡自動歸併。',
        },
        proofread: {
            title: '協同校對',
            text: '字圖對照著改錯字、補標點，校對結果回流到公開文本。',
        },
        model: {
            title: '古籍專用模型',
            text: '用校好的文本訓練斷句、標點、專名識別，反過來加快整理。',
        },
    },
    open: {
        label: '開放',
        textBadge: '許可：CC0',
        textTitle: '文本開放',
        textSub: '古籍文本以 CC0 公有領域發布，可自由複製、改編、再發布，無需署名。',
        // 「…詳見」＋〔關於我們〕＋「的『數據來源與授權』。」
        textNoteBefore: '轉錄自維基文庫、Kanripo 的文本沿用來源許可（CC BY-SA），每部文本的閱讀頁頂部標有來源與許可，詳見',
        textNoteLink: '關於我們',
        textNoteAfter: '的「數據來源與授權」。',
        codeBadge: '許可：Apache-2.0',
        codeTitle: '代碼開源',
        codeSub: '網站、排版、資源抓取等工具以 Apache-2.0 開源。',
        codeAll: '在 GitHub 查看全部 →',
        repos: {
            bookText: '古籍文本與輯佚',
            bookIndex: '古籍目錄索引，只存元數據：作品、版本、叢編、人物條目',
            luatexCn: '基於 LuaTeX 的中文排版包：古籍豎排版式復刻，以及現代中文排版，已上 CTAN',
            bookgetPy: '古籍數字資源下載與管理工具，支持 37 個數字圖書館站點，走 IIIF',
        },
    },
}, {
    kicker: '古籍数字化开放平台',
    title: '让科技赋予古籍数字生命',
    lead: '把散在各处的历代书目、存世版本与文本聚到一起，建一座开放、可查证、自由使用的古籍文库。',
    count: '已收录 11 万+ 条古籍索引',
    examples: {
        shiji: '史记',
        siku: '四库全书',
        hongloumeng: '红楼梦程甲本',
    },
    search: {
        placeholder: '书名、作者、版本，如：史记、苏轼',
        aria: '搜索古籍索引',
        submit: '搜索',
    },
    featuresTitle: '我们在做的事',
    featuresMeta: '古籍元数据、资源收集已上线，其余在陆续推进',
    live: '已上线',
    planned: '规划中',
    plannedMore: '还有 {count} 项规划中：{list}',
    plannedSep: '、',
    expand: '展开',
    collapse: '收起规划中的 {count} 项',
    features: {
        metadata: {
            title: '古籍元数据',
            text: '以作品为纲，把历代官私书目的著录与存世各版本汇到同一条目下，一眼看清一部书的来龙去脉。',
            cta: '进入古籍总目',
        },
        resources: {
            title: '资源收集',
            text: '收集网上已有的文字资源和影印资源，逐条挂到对应的作品与版本下，顺着链接就能查到出处。',
        },
        imageText: {
            title: '图文对读',
            text: '识别出的每个字对回书影上的位置，读文字时随时对看原书。',
        },
        fullText: {
            title: '全文检索',
            text: '在书名、作者之外，检索古籍文本；异体、繁简自动归并。',
        },
        proofread: {
            title: '协同校对',
            text: '字图对照着改错字、补标点，校对结果回流到公开文本。',
        },
        model: {
            title: '古籍专用模型',
            text: '用校好的文本训练断句、标点、专名识别，反过来加快整理。',
        },
    },
    open: {
        label: '开放',
        textBadge: '许可：CC0',
        textTitle: '文本开放',
        textSub: '古籍文本以 CC0 公有领域发布，可自由复制、改编、再发布，无需署名。',
        textNoteBefore: '转录自维基文库、Kanripo 的文本沿用来源许可（CC BY-SA），每部文本的阅读页顶部标有来源与许可，详见',
        textNoteLink: '关于我们',
        textNoteAfter: '的「数据来源与授权」。',
        codeBadge: '许可：Apache-2.0',
        codeTitle: '代码开源',
        codeSub: '网站、排版、资源抓取等工具以 Apache-2.0 开源。',
        codeAll: '在 GitHub 查看全部 →',
        repos: {
            // 原字面量误作「輯佚」（繁体漏进简体页，用户报的），简体栏改正为「辑佚」
            bookText: '古籍文本与辑佚',
            bookIndex: '古籍目录索引，只存元数据：作品、版本、丛编、人物条目',
            luatexCn: '基于 LuaTeX 的中文排版包：古籍竖排版式复刻，以及现代中文排版，已上 CTAN',
            bookgetPy: '古籍数字资源下载与管理工具，支持 37 个数字图书馆站点，走 IIIF',
        },
    },
});
