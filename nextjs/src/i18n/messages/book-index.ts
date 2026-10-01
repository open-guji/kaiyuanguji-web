import { defineMessages } from './define';

/** 元数据首页与检索页 /book-index、条目页 /item/<id> 的网站自有文字（组件库里的文字由组件库自己的字典管） */
export const bookIndex = defineMessages({
    loading: '加載中...',
    meta: {
        searchLabel: '檢索古籍元數據',
        searchPlaceholder: '書名、作者、版本，如：史記、蘇軾',
        search: '檢索',
        hint: '結果頁可按朝代、部類、資源、存佚篩選',
    },
    searchDegraded: '搜索服務暫時不可用，當前為簡易搜索（僅按書名、作者匹配），結果可能不全。',
    detail: {
        redirectedBefore: '已自動跳轉到正式版本（原草稿 ',
        redirectedAfter: '）',
        returnToDraft: '返回草稿',
        backToIndex: '返回索引',
        digitalTab: '數字化',
    },
    citation: {
        revisedAt: '最近校訂 {date}',
        promoted: '已升級',
        draftIdTitle: '原草稿 ID: {id}',
        report: '這條有誤？',
    },
    rail: {
        placeholder: '檢索作品、版本、書目',
        label: '檢索古籍索引',
    },
    feedbackSubmitFailed: '提交失敗',
    digital: {
        loading: '加載數字化資源中...',
        tex: 'TeX 源碼',
        render: '排版預覽',
        images: '影印影像',
        noTex: '無 TeX 源碼',
        webtex: 'WebTeX 排版',
        scanImages: '影印本影像',
        noImages: '無影像資源',
        typeset: '排版',
        image: '影像',
        syncLock: '同步鎖定',
    },
}, {
    loading: '加载中...',
    meta: {
        searchLabel: '检索古籍元数据',
        searchPlaceholder: '书名、作者、版本，如：史记、苏轼',
        search: '检索',
        hint: '结果页可按朝代、部类、资源、存佚筛选',
    },
    searchDegraded: '搜索服务暂时不可用，当前为简易搜索（仅按书名、作者匹配），结果可能不全。',
    detail: {
        redirectedBefore: '已自动跳转到正式版本（原草稿 ',
        redirectedAfter: '）',
        returnToDraft: '返回草稿',
        backToIndex: '返回索引',
        digitalTab: '数字化',
    },
    citation: {
        revisedAt: '最近校订 {date}',
        promoted: '已升级',
        draftIdTitle: '原草稿 ID: {id}',
        report: '这条有误？',
    },
    rail: {
        placeholder: '检索作品、版本、书目',
        label: '检索古籍索引',
    },
    feedbackSubmitFailed: '提交失败',
    digital: {
        loading: '加载数字化资源中...',
        tex: 'TeX 源码',
        render: '排版预览',
        images: '影印影像',
        noTex: '无 TeX 源码',
        webtex: 'WebTeX 排版',
        scanImages: '影印本影像',
        noImages: '无影像资源',
        typeset: '排版',
        image: '影像',
        syncLock: '同步锁定',
    },
});
