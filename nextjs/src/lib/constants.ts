/**
 * 应用常量
 */

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.kaiyuanguji.com";

// 网站信息
export const SITE_NAME = "开源古籍";
export const SITE_DESCRIPTION =
  "开源古籍项目通过技术手段推动古籍的数字化、校对及开源存储，致力于让传统文化触手可及。";

// GitHub 仓库地址
export const GITHUB_ORG = "open-guji";
export const GITHUB_BASE = "https://raw.githubusercontent.com";
export const JSDELIVR_FASTLY = "https://fastly.jsdelivr.net/gh";
export const JSDELIVR_CDN = "https://cdn.jsdelivr.net/gh";

// 海外默认直接访问 GitHub
export const GITHUB_BOOK_INDEX_DRAFT = `${GITHUB_BASE}/${GITHUB_ORG}/book-index-draft/main/index.json`;
export const GITHUB_BOOK_INDEX = `${GITHUB_BASE}/${GITHUB_ORG}/book-index/main/index.json`;

// Gitee 仓库地址
export const GITEE_ORG = "open-guji";
export const GITEE_BASE = "https://gitee.com";
export const GITEE_BOOK_INDEX_DRAFT = `${GITEE_BASE}/${GITEE_ORG}/book-index-draft/raw/main/index.json`;
export const GITEE_BOOK_INDEX = `${GITEE_BASE}/${GITEE_ORG}/book-index/raw/main/index.json`;

// 数据源类型
export type DataSource = 'github' | 'gitee';
export const SOURCE_COOKIE_NAME = 'og_data_source';

// 导航菜单
export const NAV_ITEMS = [
  { label: "首页", href: "/" },
  { label: "路线图", href: "/roadmap" },
  { label: "古籍助手", href: "/assistant" },
  { label: "古籍索引", href: "/book-index" },
];

// 路线图模块
export const ROADMAP_MODULES = [
  {
    id: "typesetting",
    title: "古籍排版",
    description: "基于 LaTeX/typst 的古籍排版工具",
    image: "/images/typesetting.png",
    href: "/typesetting",
  },
  {
    id: "extraction",
    title: "信息提取",
    description: "OCR 与版面分析技术",
    image: "/images/ocr.png",
    href: "/extraction",
  },
  {
    id: "toolkit",
    title: "数字化工具箱",
    description: "古籍数字化辅助工具",
    image: "/images/toolkit.png",
    href: "/toolkit",
  },
  {
    id: "storage",
    title: "开源存储",
    description: "古籍资源的开源存储与检索",
    image: "/images/toolkit.png",
    href: "/storage",
  },
  {
    id: "intelligence",
    title: "知识图谱与 AI",
    description: "古籍知识图谱与大语言模型",
    image: "/images/intelligence.png",
    href: "/intelligence",
  },
];

// 资源类型标签
export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  work: "作品",
  collection: "丛编",
  book: "书",
};
