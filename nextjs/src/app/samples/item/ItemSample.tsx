'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import data from '../_data/shiji.json';

// 样张二：条目页一屏（《史記》d59f20aowb9c，book-index 真数据快照）。
// 三栏学新稿：左检索导航、中版本表＋著录、右提要卡。字段按现行 schema。
// 视觉：表格不画格线（淡斑马），过滤用文字页签，元数据用浅色小字，只有「有影印」上色块。

type Book = (typeof data.books)[number];

const PERIOD: Record<string, string> = { 'qin-han': '秦漢' };
const ERA_ORDER = ['宋', '元', '明', '清', '民國', '日本'];
// 无确切年份的版本排在本朝之末
const ERA_END: Record<string, number> = { 宋: 1279, 元: 1368, 明: 1644, 清: 1911, 民國: 1949, 日本: 1868 };
const REL: Record<string, string> = {
  studied_by: '研究',
  text_carried_by: '载录',
  preceded_by: '前承',
  followed_by: '后继',
  related: '相关',
};
const LEFT_NAV = ['历代官私书目', '传统丛书子目', '近现代影印汇编', '海内外公藏目录', '类书'];
const FIRST_ROWS = 9;

function sortKey(b: Book) {
  return b.sort_year ?? (b.era ? ERA_END[b.era] ?? 9999 : 9999);
}

export default function ItemSample() {
  const w = data.work;
  const [era, setEra] = useState<string>('全部');
  const [imgOnly, setImgOnly] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lu, setLu] = useState(0);

  const eras = useMemo(() => {
    const s = new Set(data.books.map((b) => b.era).filter(Boolean) as string[]);
    return ['全部', ...ERA_ORDER.filter((e) => s.has(e))];
  }, []);

  const rows = useMemo(
    () =>
      data.books
        .filter((b) => (era === '全部' ? true : b.era === era))
        .filter((b) => (imgOnly ? b.has_image : true))
        .sort((a, b) => sortKey(a) - sortKey(b)),
    [era, imgOnly],
  );
  const shown = expanded ? rows : rows.slice(0, FIRST_ROWS);
  const author = w.authors[0];
  const entry = data.indexed_by[lu];
  const related = [
    ...data.related.filter((r) => r.relation === 'studied_by'),
    ...data.related.filter((r) => r.relation !== 'studied_by'),
  ].slice(0, 6);

  return (
    <div className="item-wrap">
      {/* ---------- 左：检索导航 ---------- */}
      <aside className="item-left">
        <div className="item-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          检索作品、版本、书目
        </div>
        <div className="item-leftnav">
          <p className="cap">检索导航</p>
          <ul>
            <li className="on">
              <a href="#">
                当前典籍 · {w.title}
              </a>
            </li>
            {LEFT_NAV.map((n) => (
              <li key={n}>
                <a href="#">
                  {n}
                  <span className="meta">待录入</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* ---------- 中：版本＋著录 ---------- */}
      <main className="item-main">
        <section className="item-sec">
          <div className="item-sec-head">
            <h2>版本</h2>
            <span className="meta">
              共 {data.books.length} 种<span className="dot" />
              {data.books.filter((b) => b.has_image).length} 种有影印
            </span>
          </div>
          <div className="item-filters">
            {eras.map((e) => (
              <button key={e} className={e === era ? 'on' : undefined} onClick={() => setEra(e)}>
                {e}
              </button>
            ))}
            <span className="spacer" />
            <label>
              <input type="checkbox" checked={imgOnly} onChange={(e) => setImgOnly(e.target.checked)} />
              只看有影印
            </label>
            <span className="meta">按年代排列</span>
          </div>
          <table className="vtable">
            <thead>
              <tr>
                <th>版本</th>
                <th>年代</th>
                <th>馆藏</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id}>
                  <td className="ed">
                    <a href="#">{b.edition || b.title}</a>
                    {b.measure_info && <span className="meta">{b.measure_info}</span>}
                  </td>
                  <td className="yr">
                    {b.era || '—'}
                    {b.sort_year ? ` ${b.sort_year}` : ''}
                  </td>
                  <td className="hd">{b.holder || <span className="muted">—</span>}</td>
                  <td className="im">{b.has_image && <span className="flag">有影印</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > FIRST_ROWS && (
            <a
              href="#"
              className="item-more"
              onClick={(e) => {
                e.preventDefault();
                setExpanded(!expanded);
              }}
            >
              {expanded ? '收起' : `展开其余 ${rows.length - FIRST_ROWS} 种版本`}
            </a>
          )}
        </section>

        <section className="item-sec">
          <div className="item-sec-head">
            <h2>著录</h2>
            <span className="meta">历代书目 {data.indexed_by.length} 家</span>
          </div>
          <div className="lu">
            <ul className="lu-list">
              {data.indexed_by.map((x, i) => (
                <li key={x.source}>
                  <button className={i === lu ? 'on' : undefined} onClick={() => setLu(i)}>
                    {x.source}
                  </button>
                </li>
              ))}
            </ul>
            <div className="lu-body">
              <p className="t">{entry.title_info}</p>
              {entry.section && <p className="meta">{entry.source}<span className="dot" />{entry.section}</p>}
              <blockquote>{entry.summary}</blockquote>
            </div>
          </div>
        </section>
      </main>

      {/* ---------- 右：提要卡 ---------- */}
      <aside className="item-right">
        <div className="s-card">
          <h1>{w.title}</h1>
          <p className="byline">
            <span className="muted">〔{author.dynasty}〕</span>
            {author.name} {author.role}
          </p>
          <p className="cls meta">
            {w.classification.l1}<span className="dot" />{w.classification.l2}
            <span className="dot" />據《{w.classification.source.split('/')[0]}》
          </p>
          <p className="desc">{w.description.text}</p>
          <dl>
            <dt>成书时期</dt>
            <dd>{PERIOD[w.period] ?? w.period}</dd>
            <dt>卷帙</dt>
            <dd>{w.measure_info}<span className="muted">（{w.juan_count.description}）</span></dd>
            <dt>存佚</dt>
            <dd>{w.loss_status === 'extant' ? '今存' : w.loss_status}</dd>
            <dt>著录</dt>
            <dd>{data.indexed_by.length} 家<span className="muted">　考证 {data.emendated_count} 条</span></dd>
          </dl>
          <Link href="/samples/reader" className="s-btn">阅读全文</Link>
          <p className="sub meta">
            数据版本 {w.revision}<span className="dot" />{w.revised_at}
          </p>
        </div>

        <div className="side">
          <h3>收入丛编</h3>
          <ul>
            {data.collected_in.map((c) => (
              <li key={c.id}>
                <a href="#">{c.title}</a>
              </li>
            ))}
          </ul>
        </div>

        <div className="side">
          <h3>
            相关书目<span className="meta">{data.related.length} 部</span>
          </h3>
          <ul>
            {related.map((r) => (
              <li key={r.id}>
                <a href="#">{r.title}</a>
                <span className="meta">{REL[r.relation] ?? r.relation}</span>
              </li>
            ))}
          </ul>
          <a href="#" className="item-more">显示更多（{data.related.length - related.length}）</a>
        </div>
      </aside>
    </div>
  );
}
