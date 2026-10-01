import { permanentRedirect } from 'next/navigation';

// 用户 9-30 反馈（overview#322）：联系页的内容直接展开放进关于页，旧地址跳到 /about#联系。
// EdgeOne 不认 next.config 的 redirects（31 卡 §B.1），middleware 是 V3 的写域，所以在页面里跳：
// 全栈（测试站）按请求渲染时回 308；静态导出（正式站）构建期生成的页面由 Next 带上跳转。
// Location 头只能是 ASCII：锚点按百分号编码，浏览器解码后对上 id="联系"。
const CONTACT_TARGET = `/about#${encodeURIComponent('联系')}`;

export default function ContactPage() {
  permanentRedirect(CONTACT_TARGET);
}
