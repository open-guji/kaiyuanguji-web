import Link from 'next/link';

// N6 样张目录（overview#259）
export default function N6SamplesIndex() {
  return (
    <div className="n6-index">
      <h1>N6 样张 · 关于与联系</h1>
      <p>
        外壳（顶栏、抽屉、令牌）都是现网 main 的，只换了页脚和下面四页。
        〔 〕里的都是占位，要用户提供真实内容。
      </p>
      <ul>
        <li>
          <Link href="/samples/n6/home">首页 · 方案 A</Link>：开放区下面另起一段「关于与联系」
        </li>
        <li>
          <Link href="/samples/n6/home-b">首页 · 方案 B</Link>：不加新段，在「文本开放 / 代码开源」旁边加第三栏
        </li>
        <li>
          <Link href="/samples/n6/about">关于我们</Link>：左侧目录＋五节
        </li>
        <li>
          <Link href="/samples/n6/contact">联系我们</Link>：新页 /contact
        </li>
      </ul>
      <p>对照现网：<Link href="/">首页</Link> · <Link href="/about">关于</Link></p>
    </div>
  );
}
