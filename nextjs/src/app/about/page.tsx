import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';
import { GITHUB_ORG } from '@/lib/constants';

export const metadata: Metadata = {
  title: '关于开源古籍',
  description: '开源古籍是什么、在做什么、数据从哪里来、以及怎么参与。',
  alternates: { canonical: '/about' },
};

const GITHUB_BASE = `https://github.com/${GITHUB_ORG}`;

// N6（overview#259）：左侧目录＋分节正文。团队一节等用户给了名单再加，不放占位。
const TOC = [
  { id: 'intro', label: '项目介绍' },
  { id: 'license', label: '数据来源与授权' },
  { id: 'thanks', label: '致谢' },
  { id: 'repos', label: '开源仓库' },
  { id: 'contact', label: '联系我们' },
];

const THANKS = [
  { name: '维基文库', note: '部分全文转录自此，CC BY-SA 4.0', href: 'https://zh.wikisource.org/' },
  { name: 'Kanripo（漢籍リポジトリ）', note: '部分全文转录自此，CC BY-SA', href: 'https://www.kanripo.org/' },
];

const REPOS = [
  { name: 'book-index', note: '古籍目录索引（正式）' },
  { name: 'book-index-draft', note: '古籍目录索引（草稿）' },
  { name: 'book-text', note: '整理本与全文' },
  { name: 'open-guji-cv', note: '图片数字化引擎' },
  { name: 'kaiyuanguji-web', note: '本网站' },
];

export default function AboutPage() {
  return (
    <LayoutWrapper>
      <div className="doc-layout">
        <nav className="doc-toc" aria-label="本页目录">
          <p className="doc-toc-title">关于开源古籍</p>
          <ul>
            {TOC.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`}>{t.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="doc-article">
          <h1>关于开源古籍</h1>
          <p className="doc-lead">
            开源古籍把古籍数字化的全链路公开出来：从扫描图片、预处理、版面与字符识别、人工校对，到索引与知识关联、排版还原，再到开放发布，每一段的代码与数据都公开在 GitHub 上。
          </p>

          <section id="intro">
            <h2>项目介绍</h2>
            <dl className="doc-dl">
              <dt>古籍目录索引</dt>
              <dd>
                汇集历代目录学著录与公开馆藏书目，做一部尽量准确完整、可供程序直接调用的在线古籍目录，收录作品、版本、丛编与相关人物。
                <span className="doc-meta">已上线</span>
              </dd>
              <dt>整理本与全文</dt>
              <dd>
                把古籍原文整理成结构化文本，收录已校勘的整理本与全文，与目录索引共用同一套编号互相关联。
                <span className="doc-meta">已上线</span>
              </dd>
              <dt>图片初步数字化</dt>
              <dd>
                用自研 OCR 与版面分析模型让机器先做第一遍识别，再靠人工校对把工作量压缩到「只看差异」。
                <span className="doc-meta">规划中</span>
              </dd>
            </dl>
          </section>

          <section id="license">
            <h2>数据来源与授权</h2>
            <p>
              索引数据来自历代目录学著录、公开馆藏书目，以及各类可获取的古籍扫描与文本资源；具体来源在每条索引自己的资源字段里逐条标注，可以顺着链接查到出处。
            </p>
            <table className="doc-table">
              <tbody>
                <tr>
                  <th scope="row">整理本及本站自行整理的文本（book-text）</th>
                  <td>CC0 1.0 Universal，公有领域，可自由使用，无需署名</td>
                </tr>
                <tr>
                  <th scope="row">转录自第三方的全文</th>
                  <td>
                    沿用来源许可，不适用 CC0：如维基文库为 CC BY-SA 4.0，Kanripo 为 CC BY-SA。每部全文的阅读页顶部标有来源名称、原始链接和许可，转载时请按对应许可署名并以相同许可发布
                  </td>
                </tr>
                <tr>
                  <th scope="row">图片数字化引擎（open-guji-cv）</th>
                  <td>Apache License 2.0</td>
                </tr>
                <tr>
                  <th scope="row">古籍目录索引（book-index、book-index-draft）</th>
                  <td>仓库根目录目前未声明许可文件</td>
                </tr>
              </tbody>
            </table>
            <p className="doc-note">
              本站呈现的内容不是最终事实来源——GitHub 上的数据仓库才是，本站只是一个展示端。随时可以去仓库核对原始数据、看改动历史，或者直接提交修改。
            </p>
          </section>

          <section id="thanks">
            <h2>致谢</h2>
            <p>项目的探索离不开开放知识社群的积累，特此致谢：</p>
            <ul className="doc-rows">
              {THANKS.map((t) => (
                <li key={t.name}>
                  <a href={t.href} target="_blank" rel="noopener noreferrer">
                    {t.name}
                  </a>
                  <span className="doc-meta">{t.note}</span>
                </li>
              ))}
            </ul>
          </section>

          <section id="repos">
            <h2>开源仓库</h2>
            <ul className="doc-rows">
              {REPOS.map((r) => (
                <li key={r.name}>
                  <a href={`${GITHUB_BASE}/${r.name}`} target="_blank" rel="noopener noreferrer">
                    {r.name}
                  </a>
                  <span className="doc-meta">{r.note}</span>
                </li>
              ))}
              <li>
                <a href={GITHUB_BASE} target="_blank" rel="noopener noreferrer">
                  github.com/{GITHUB_ORG}
                </a>
                <span className="doc-meta">全部仓库</span>
              </li>
            </ul>
          </section>

          <section id="contact">
            <h2>联系我们</h2>
            <p>
              发现错误、缺了资源，或想参与整理、校对、开发，见<Link href="/contact">联系我们</Link>。
              内测阶段的功能范围与已知限制见<Link href="/beta">内测说明</Link>，隐私相关见<Link href="/privacy">隐私说明</Link>。
            </p>
          </section>
        </article>
      </div>
    </LayoutWrapper>
  );
}
