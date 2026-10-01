import { defineMessages } from './define';

/**
 * 服务端直出的 <title>、meta 的固定文字（overview#337）。
 * 服务端拿不到繁简偏好，一律用 getSiteT('zh-Hans') 取简体栏；繁体栏为将来按语言出页留着。
 */
export const seo = defineMessages({
    notFound: '未找到',
    notFoundItem: '未找到條目',
    searchTitle: '{q} - 搜索',
    catalogTitle: '{trail}{page} - 古籍總目',
    catalogDescription: '古籍總目 {trail}：共 {count} 部作品{page}。',
    readHomeTitle: '閱讀',
    readTitle: '{trail}{page} - 閱讀',
    readHomeDescription: '開源古籍閱讀首頁：站上所有能直接閱讀的古籍，有推薦、專題、名著版本，可按四部或年代瀏覽。',
    readPeriodDescription: '作者屬{label}的可直接閱讀的古籍，共 {count} 部{page}。',
    readNodeDescription: '{trail}中可直接閱讀的作品，共 {count} 部{page}。',
    /** 标题里的页码：「（第2页）」 */
    pageSuffix: '（第{n}頁）',
    /** 描述里的页码：「，第 2／5 页」 */
    pageOf: '，第 {page}／{total} 頁',
    readOnline: '{what}，在線閱讀。',
}, {
    notFound: '未找到',
    notFoundItem: '未找到条目',
    searchTitle: '{q} - 搜索',
    catalogTitle: '{trail}{page} - 古籍总目',
    catalogDescription: '古籍总目 {trail}：共 {count} 部作品{page}。',
    readHomeTitle: '阅读',
    readTitle: '{trail}{page} - 阅读',
    readHomeDescription: '开源古籍阅读首页：站上所有能直接阅读的古籍，有推荐、专题、名著版本，可按四部或年代浏览。',
    readPeriodDescription: '作者属{label}的可直接阅读的古籍，共 {count} 部{page}。',
    readNodeDescription: '{trail}中可直接阅读的作品，共 {count} 部{page}。',
    pageSuffix: '（第{n}页）',
    pageOf: '，第 {page}／{total} 页',
    readOnline: '{what}，在线阅读。',
});
