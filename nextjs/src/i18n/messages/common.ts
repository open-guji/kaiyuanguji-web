import { defineMessages } from './define';

/** 通用小件：复制按钮、文章目录、404 页、检索框候选 */
export const common = defineMessages({
    copy: {
        done: '已複製',
        title: '複製 {label}',
        defaultLabel: '內容',
        aria: '複製 {text}',
        ariaWithLabel: '複製 {label}: {text}',
    },
    toc: '目錄',
    notFound: {
        title: '找不到這個頁面',
        body: '地址可能寫錯了，或者這一頁已經移走。可以從下面幾處繼續找。',
        home: '回首頁',
        catalog: '去古籍總目',
        search: '去搜索',
    },
    error: {
        title: '頁面沒能打開',
        body: '多半是網絡一時不通。點「重試」或刷新一下通常就好；還不行，請稍後再來。',
        retry: '重試',
        reload: '刷新頁面',
    },
    suggest: {
        label: '檢索候選',
        history: '最近檢索',
        clear: '清空',
        remove: '刪除「{q}」',
        types: { work: '作品', book: '書', collection: '叢編', entity: '人物' },
    },
}, {
    copy: {
        done: '已复制',
        title: '复制 {label}',
        defaultLabel: '内容',
        aria: '复制 {text}',
        ariaWithLabel: '复制 {label}: {text}',
    },
    toc: '目录',
    notFound: {
        title: '找不到这个页面',
        body: '地址可能写错了，或者这一页已经移走。可以从下面几处继续找。',
        home: '回首页',
        catalog: '去古籍总目',
        search: '去搜索',
    },
    error: {
        title: '页面没能打开',
        body: '多半是网络一时不通。点「重试」或刷新一下通常就好；还不行，请稍后再来。',
        retry: '重试',
        reload: '刷新页面',
    },
    suggest: {
        label: '检索候选',
        history: '最近检索',
        clear: '清空',
        remove: '删除「{q}」',
        types: { work: '作品', book: '书', collection: '丛编', entity: '人物' },
    },
});
