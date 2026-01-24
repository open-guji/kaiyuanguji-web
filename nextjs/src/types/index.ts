/**
 * 古籍资源类型
 */
export type BookResourceType = "work" | "collection" | "book";

/**
 * 古籍索引项
 */
export interface BookIndexItem {
  id: string;
  name: string;
  type: BookResourceType;
  isDraft: boolean;
  rawPath: string;
  author?: string;
  collection?: string;
  year?: string;
  holder?: string;
}

/**
 * 内容模型（Markdown 文档）
 */
export interface ContentModel {
  title: string;
  content: string;
  createdAt?: Date;
  tags?: string[];
  author?: string;
}

/**
 * 目录项
 */
export interface TocItem {
  title: string;
  level: number;
  index: number;
}

/**
 * 导航项
 */
export interface NavItem {
  label: string;
  href: string;
  isExternal?: boolean;
}
