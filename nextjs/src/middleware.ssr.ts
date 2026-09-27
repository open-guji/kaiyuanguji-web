// W2-2（31 卡 §A）：旧详情地址 /book-index?id=<id> → 308 /item/<id>。
//
// 文件名带 .ssr：只有全栈构建（KYG_RENDER_MODE=fullstack，测试站）才认它为中间件
// （Next 按 pageExtensions 找 middleware 文件）；正式站静态导出没有中间件，行为不变。
// EdgeOne 不支持 next.config 的 redirects（31 卡 §B.1），跳转只能写在这里。
//
// 只改写「查询串恰好只有一个合法、正式 id」的请求：
//   - 带 tab／juan／page／mode 等参数的，是详情组件自己的 URL 同步（它仍往 /book-index 推），
//     改写会丢状态，放过；
//   - 草稿 id 可能已升格，要客户端查升格表，放过（/item/<草稿 id> 查不到时也会跳回这里）；
//   - redirected_from／no_redirect 是升格横幅的往返，放过。
import { NextResponse, type NextRequest } from 'next/server';
import { parseItemId } from '@/lib/item-id';

export function middleware(req: NextRequest) {
    const params = req.nextUrl.searchParams;
    const keys = Array.from(params.keys());
    if (keys.length !== 1 || keys[0] !== 'id') return NextResponse.next();
    const id = params.get('id') ?? '';
    if (parseItemId(id)?.status !== 'official') return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = `/item/${id}`;
    url.search = '';
    return NextResponse.redirect(url, 308);
}

export const config = {
    matcher: '/book-index',
};
