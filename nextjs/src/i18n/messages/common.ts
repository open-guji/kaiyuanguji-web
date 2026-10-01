import { defineMessages } from './define';

/** 通用小件：复制按钮、文章目录、404 页 */
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
});
