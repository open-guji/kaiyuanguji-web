import Link from 'next/link';
import data from '../_data/zhizhai.json';

// 样张三：阅读页一屏（《直齋書錄解題》整理本，book-text 真数据快照，卷十一「正史類」）。
// 布局学新稿阅读器：目录在左、正文居中、书影在右（书影尚未接入，先放占位）。
// 正文宋体横排；工具条全用文字／图标，不放按钮。

const QUALITY: Record<string, string> = { rough: '粗校', fine: '精校' };

export default function SampleReader() {
  const cur = data.toc.find((t) => t.n === data.current)!;
  const q = data.text_quality;

  return (
    <>
      <header className="rd-bar">
        <Link href="/samples/item" className="back" aria-label="返回条目">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          <span>条目</span>
        </Link>
        <p className="ttl">
          {data.title}
          <span className="meta">
            〔{data.dynasty}〕{data.author} 撰<span className="dot" />整理本
          </span>
        </p>
        <div className="rd-tools">
          <button className="rd-toc-btn" aria-label="目录">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h10M4 18h16" />
            </svg>
            目录
          </button>
          <button className="hide-m">横排</button>
          <span className="sep hide-m" />
          <button aria-label="缩小字号">A−</button>
          <button aria-label="放大字号">A+</button>
          <span className="sep" />
          <button>繁</button>
          <span className="sep hide-m" />
          <button className="hide-m">书影</button>
        </div>
      </header>

      <div className="rd-wrap">
        <nav className="rd-toc" aria-label="目录">
          <p className="cap">目录 · {data.toc.length} 类</p>
          <ul>
            {data.toc.map((t) => (
              <li key={t.n} className={t.n === data.current ? 'on' : undefined}>
                <a href="#">
                  <span className="n">{t.n}</span>
                  {t.title}
                  <span className="c">{t.count}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="rd-text">
          <div className="rd-col">
            <h1 className="juan">{cur.title}</h1>
            <p className="juan-meta meta">
              第 {cur.n} 类<span className="dot" />
              {data.juan.sections.length} 条<span className="dot" />
              底本 {q?.source_note}（{QUALITY[q?.grade ?? ''] ?? q?.grade}）<span className="dot" />
              修订 {data.revision}
            </p>
            {data.juan.sections.map((s, i) => (
              <section key={i} className="rd-entry">
                <h3>
                  <a href={s.work_id ? `/book-index?id=${s.work_id}` : '#'}>{s.title}</a>
                </h3>
                {s.content ? (
                  <p>{s.content}</p>
                ) : (
                  <p className="from">解题见上条{s.content_from ? `　${s.content_from}` : ''}</p>
                )}
              </section>
            ))}
          </div>
        </article>

        <aside className="rd-img" aria-label="书影">
          <div className="rd-img-box">
            <div className="frame" aria-hidden="true" />
            <b>书影对照</b>
            <span>规划中：接入影像后，在此与正文逐页对看</span>
          </div>
        </aside>
      </div>
    </>
  );
}
