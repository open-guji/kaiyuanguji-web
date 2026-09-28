import Link from 'next/link';
import SampleShell from '../_components/SampleShell';
import { CONTACT_HREF } from '../_components/links';

const GH = 'https://github.com/open-guji';

const TOC = [
  { id: 'intro', label: '项目介绍' },
  { id: 'license', label: '数据来源与授权' },
  { id: 'thanks', label: '致谢' },
  { id: 'team', label: '团队' },
  { id: 'repos', label: '开源仓库' },
  { id: 'contact', label: '联系我们' },
];

// 致谢：前两项现网 /about 已写明在用；其余三项是新稿首页「致谢」里列的，是否确实用到待用户确认
const THANKS = [
  { name: '维基文库', note: '部分全文转录自此，CC BY-SA 4.0', href: 'https://zh.wikisource.org/' },
  { name: 'Kanripo（漢籍リポジトリ）', note: '部分全文转录自此，CC BY-SA', href: 'https://www.kanripo.org/' },
  { name: 'Wikimedia Commons', note: '〔新稿所列，是否用到待确认〕', href: 'https://commons.wikimedia.org/' },
  { name: 'Internet Archive', note: '〔新稿所列，是否用到待确认〕', href: 'https://archive.org/' },
  { name: '书格', note: '〔新稿所列，是否用到待确认〕', href: 'https://www.shuge.org/' },
  { name: '中国哲学书电子化计划（CText）', note: '〔新稿所列，是否用到待确认〕', href: 'https://ctext.org/' },
];

const REPOS = [
  { name: 'book-index', note: '古籍目录索引（正式）' },
  { name: 'book-index-draft', note: '古籍目录索引（草稿）' },
  { name: 'book-text', note: '整理本与全文' },
  { name: 'open-guji-cv', note: '图片数字化引擎' },
  { name: 'kaiyuanguji-web', note: '本网站' },
];

export default function N6About() {
  return (
    <SampleShell>
      <div className="n6-doc">
        <nav className="n6-toc" aria-label="本页目录">
          <p className="n6-toc-title">关于开源古籍</p>
          <ul>
            {TOC.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`}>{t.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="n6-article">
          <h1>关于开源古籍</h1>
          <p className="n6-lead">
            把古籍数字化的全链路公开出来：从扫描图片、版面与字符识别、人工校对，到索引、排版与开放发布，每一段的代码和数据都放在 GitHub 上。
          </p>

          <section id="intro">
            <h2>项目介绍</h2>
            <dl className="n6-dl">
              <dt>古籍目录索引</dt>
              <dd>
                汇集历代目录学著录与公开馆藏书目，收录作品、版本、丛编与人物，可供程序直接调用。
                <span className="n6-meta">已上线 · 11 万+ 条</span>
              </dd>
              <dt>整理本与全文</dt>
              <dd>
                把原文整理成结构化文本，与目录索引共用同一套编号。
                <span className="n6-meta">已上线</span>
              </dd>
              <dt>图片初步数字化</dt>
              <dd>
                用自研 OCR 与版面分析模型先做第一遍识别，人工只看差异。
                <span className="n6-meta">规划中</span>
              </dd>
            </dl>
          </section>

          <section id="license">
            <h2>数据来源与授权</h2>
            <p>
              索引数据来自历代目录学著录、公开馆藏书目和各类可获取的古籍扫描与文本资源，每条索引在自己的资源字段里逐条标注出处。
            </p>
            <table className="n6-table">
              <tbody>
                <tr>
                  <th scope="row">整理本及本站自行整理的文本</th>
                  <td>CC0 1.0，公有领域，可自由使用，无需署名</td>
                </tr>
                <tr>
                  <th scope="row">转录自第三方的全文</th>
                  <td>沿用来源许可（如维基文库 CC BY-SA 4.0），阅读页顶部逐部标明</td>
                </tr>
                <tr>
                  <th scope="row">网站与工具代码</th>
                  <td>Apache-2.0</td>
                </tr>
                <tr>
                  <th scope="row">目录索引仓</th>
                  <td>仓库根目录暂未声明许可文件，以仓库为准</td>
                </tr>
              </tbody>
            </table>
            <p className="n6-note">本站只是这些数据的展示端，GitHub 上的仓库才是真源；随时可以去核对原始数据、看改动历史。</p>
          </section>

          <section id="thanks">
            <h2>致谢</h2>
            <p>项目的探索离不开开放知识社群的积累，特此致谢：</p>
            <ul className="n6-rows">
              {THANKS.map((t) => (
                <li key={t.name}>
                  <a href={t.href} target="_blank" rel="noopener noreferrer">
                    {t.name}
                  </a>
                  <span className="n6-meta">{t.note}</span>
                </li>
              ))}
            </ul>
          </section>

          <section id="team">
            <h2>团队</h2>
            <p className="n6-ph">〔团队成员、参与机构、顾问名单待用户提供；不提供则整节不放〕</p>
          </section>

          <section id="repos">
            <h2>开源仓库</h2>
            <ul className="n6-rows">
              {REPOS.map((r) => (
                <li key={r.name}>
                  <a href={`${GH}/${r.name}`} target="_blank" rel="noopener noreferrer">
                    {r.name}
                  </a>
                  <span className="n6-meta">{r.note}</span>
                </li>
              ))}
              <li>
                <a href={GH} target="_blank" rel="noopener noreferrer">
                  github.com/open-guji
                </a>
                <span className="n6-meta">全部仓库</span>
              </li>
            </ul>
          </section>

          <section id="contact">
            <h2>联系我们</h2>
            <p>
              发现错误、缺了资源，或想参与整理、校对、开发，见<Link href={CONTACT_HREF}>联系我们</Link>页。
              内测范围与已知限制见<Link href="/beta">内测说明</Link>，隐私相关见<Link href="/privacy">隐私说明</Link>。
            </p>
          </section>
        </article>
      </div>
    </SampleShell>
  );
}
