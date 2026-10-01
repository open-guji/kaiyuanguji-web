import { defineMessages } from './define';

/**
 * 关于页（app/about）的界面文字。
 * 「Kanripo（漢籍リポジトリ）」是专名，繁简都不改，不进字典，写在页面代码里。
 */
export const about = defineMessages({
    tocAria: '本頁目錄',
    title: '關於開源古籍',
    toc: {
        license: '數據來源與授權',
        thanks: '致謝',
        contact: '聯繫我們',
    },
    lead: '開源古籍把古籍數字化的全鏈路公開出來：從掃描圖片、預處理、版面與字符識別、人工校對，到索引與知識關聯、排版還原，再到開放發布，每一段的代碼與數據都公開在 GitHub 上。',
    license: {
        p1: '索引數據來自歷代目錄學著錄、公開館藏書目，以及各類可獲取的古籍掃描與文本資源；每條索引的來源都在它自己的資源字段裡逐條標註，順著鏈接可以查到出處。',
        p2: '本站自己整理的數據——古籍目錄索引和古籍文本——都以 CC0 公有領域發布；轉錄自第三方的文本沿用來源許可；代碼以 Apache-2.0 開源。',
        bookIndex: {
            what: '古籍目錄索引（book-index）',
            note: '作品、版本、叢編、人物條目，只存元數據',
            license: 'CC0 1.0 Universal，公有領域，可自由複製、改編、再發布，無需署名',
        },
        bookText: {
            what: '古籍文本（book-text）',
            note: '本站整理的古籍文本與輯佚',
            license: 'CC0 1.0 Universal，公有領域，可自由複製、改編、再發布，無需署名',
        },
        thirdParty: {
            what: '轉錄自第三方的文本',
            note: '維基文庫、Kanripo 等',
            license: '沿用來源許可，不適用 CC0：維基文庫為 CC BY-SA 4.0，Kanripo 為 CC BY-SA。每部文本的閱讀頁頂部標有來源名稱、原始鏈接和許可，轉載時請按對應許可署名，並以相同許可發布',
        },
        code: {
            what: '代碼',
            note: '網站、排版（luatex-cn）、資源抓取（bookget-py）、圖片數字化（open-guji-cv）等',
            license: 'Apache License 2.0',
        },
    },
    thanks: {
        intro: '項目的探索離不開開放知識社群的積累，特此致謝：',
        wikisource: '維基文庫',
        wikisourceNote: '部分文本轉錄自此，CC BY-SA 4.0',
        kanripoNote: '部分文本轉錄自此，CC BY-SA',
    },
    contact: {
        intro: '發現錯誤、缺了資源、有建議，或者想參與整理、校對、開發，都可以從下面找到我們。',
        feedbackTitle: '反饋與糾錯',
        feedbackDesc: '最快的方式。提交後可以在反饋頁看到處理進展；想參與的話，類型選「想參與」並留下聯繫方式，我們會聯繫你。',
        feedbackBtn: '去反饋',
        bookDataIssue: '書目數據有誤：',
        siteIssue: '網站問題：',
        prWelcome: '也歡迎直接提 PR',
        email: '郵箱',
        emailNote: '合作、授權等不便公開的事',
        groups: '交流群',
        wechatAlt: '微信群「開源古籍交流群」二維碼',
        wechatCaption: '微信群：微信掃碼加入',
        qqAlt: 'QQ 群「開源古籍交流群」二維碼',
        qqGroup: 'QQ 群：{group}',
        qqHint: 'QQ 掃碼或搜索群號加入',
        moreBefore: '內測階段的功能範圍與已知限制見',
        betaLink: '內測說明',
        moreMiddle: '，隱私相關見',
        privacyLink: '隱私說明',
        moreAfter: '。',
    },
}, {
    tocAria: '本页目录',
    title: '关于开源古籍',
    toc: {
        license: '数据来源与授权',
        thanks: '致谢',
        contact: '联系我们',
    },
    lead: '开源古籍把古籍数字化的全链路公开出来：从扫描图片、预处理、版面与字符识别、人工校对，到索引与知识关联、排版还原，再到开放发布，每一段的代码与数据都公开在 GitHub 上。',
    license: {
        p1: '索引数据来自历代目录学著录、公开馆藏书目，以及各类可获取的古籍扫描与文本资源；每条索引的来源都在它自己的资源字段里逐条标注，顺着链接可以查到出处。',
        p2: '本站自己整理的数据——古籍目录索引和古籍文本——都以 CC0 公有领域发布；转录自第三方的文本沿用来源许可；代码以 Apache-2.0 开源。',
        bookIndex: {
            what: '古籍目录索引（book-index）',
            note: '作品、版本、丛编、人物条目，只存元数据',
            license: 'CC0 1.0 Universal，公有领域，可自由复制、改编、再发布，无需署名',
        },
        bookText: {
            what: '古籍文本（book-text）',
            note: '本站整理的古籍文本与辑佚',
            license: 'CC0 1.0 Universal，公有领域，可自由复制、改编、再发布，无需署名',
        },
        thirdParty: {
            what: '转录自第三方的文本',
            note: '维基文库、Kanripo 等',
            license: '沿用来源许可，不适用 CC0：维基文库为 CC BY-SA 4.0，Kanripo 为 CC BY-SA。每部文本的阅读页顶部标有来源名称、原始链接和许可，转载时请按对应许可署名，并以相同许可发布',
        },
        code: {
            what: '代码',
            note: '网站、排版（luatex-cn）、资源抓取（bookget-py）、图片数字化（open-guji-cv）等',
            license: 'Apache License 2.0',
        },
    },
    thanks: {
        intro: '项目的探索离不开开放知识社群的积累，特此致谢：',
        wikisource: '维基文库',
        wikisourceNote: '部分文本转录自此，CC BY-SA 4.0',
        kanripoNote: '部分文本转录自此，CC BY-SA',
    },
    contact: {
        intro: '发现错误、缺了资源、有建议，或者想参与整理、校对、开发，都可以从下面找到我们。',
        feedbackTitle: '反馈与纠错',
        feedbackDesc: '最快的方式。提交后可以在反馈页看到处理进展；想参与的话，类型选「想参与」并留下联系方式，我们会联系你。',
        feedbackBtn: '去反馈',
        bookDataIssue: '书目数据有误：',
        siteIssue: '网站问题：',
        prWelcome: '也欢迎直接提 PR',
        email: '邮箱',
        emailNote: '合作、授权等不便公开的事',
        groups: '交流群',
        wechatAlt: '微信群「开源古籍交流群」二维码',
        wechatCaption: '微信群：微信扫码加入',
        qqAlt: 'QQ 群「开源古籍交流群」二维码',
        qqGroup: 'QQ 群：{group}',
        qqHint: 'QQ 扫码或搜索群号加入',
        moreBefore: '内测阶段的功能范围与已知限制见',
        betaLink: '内测说明',
        moreMiddle: '，隐私相关见',
        privacyLink: '隐私说明',
        moreAfter: '。',
    },
});
