import { permanentRedirect } from 'next/navigation';

// 用户 9-30 反馈（overview#322）：联系页的内容直接展开放进关于页，旧地址 308 到 /about#联系。
// EdgeOne 不认 next.config 的 redirects（31 卡 §B.1），middleware 是 V3 的写域，所以在页面里跳。
//
// 必须按请求渲染（force-dynamic）：不加的话 /contact 在构建期被预渲染成静态页，permanentRedirect
// 只写进 RSC 载荷，线上回的是 200 加页面内跳转，不是 308（测试站 verify 实测，run 36812017662）。
// force-dynamic 与静态导出不兼容，所以本页只在全栈构建里存在（文件名带 .ssr，同 catalog、read）；
// 静态导出里没有 /contact。
export const dynamic = 'force-dynamic';

// Location 头只能是 ASCII：锚点按百分号编码，浏览器解码后对上 id="联系"。
const CONTACT_TARGET = `/about#${encodeURIComponent('联系')}`;

export default function ContactPage() {
  permanentRedirect(CONTACT_TARGET);
}
