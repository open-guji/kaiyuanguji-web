import Link from 'next/link';

// N1a 视觉样张目录（overview#92）。样张只在 design/n1-samples 分支。
export default function SamplesIndex() {
  return (
    <div className="smp-index">
      <h1>N1 视觉样张</h1>
      <p className="meta" style={{ marginTop: 8 }}>
        布局学新稿，视觉沿用现网。数据为 book-index／book-text 2026-09-28 快照。
      </p>
      <ul>
        <li><Link href="/samples/home">首页首屏</Link></li>
        <li><Link href="/samples/item">条目页 · 史記</Link></li>
        <li><Link href="/samples/reader">阅读页 · 直齋書錄解題（整理本）</Link></li>
      </ul>
    </div>
  );
}
