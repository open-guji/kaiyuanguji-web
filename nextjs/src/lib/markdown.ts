import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

export interface MarkdownContent {
  content: string;
  frontmatter: {
    title?: string;
    description?: string;
    [key: string]: any;
  };
}

export interface TOCItem {
  id: string;
  text: string;
  level: number;
}

/**
 * 读取 Markdown 文件并解析 frontmatter
 */
export async function getMarkdownContent(filename: string): Promise<MarkdownContent> {
  const contentDir = path.join(process.cwd(), 'public', 'content');
  const fullPath = path.join(contentDir, `${filename}.md`);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Markdown file not found: ${filename}`);
  }

  const fileContents = fs.readFileSync(fullPath, 'utf8');
  const { data, content } = matter(fileContents);

  return {
    content,
    frontmatter: data,
  };
}

/**
 * 从 Markdown 内容中提取目录（TOC）
 */
export function extractTOC(markdown: string): TOCItem[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const toc: TOCItem[] = [];
  let match;

  while ((match = headingRegex.exec(markdown)) !== null) {
    const level = match[1].length;
    const text = match[2].trim();

    // 生成 ID（转换为 kebab-case）
    const id = text
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9\s-]/g, '') // 保留中文、字母、数字、空格、连字符
      .replace(/\s+/g, '-') // 空格转连字符
      .replace(/-+/g, '-') // 多个连字符合并
      .replace(/^-|-$/g, ''); // 去除首尾连字符

    toc.push({
      id,
      text,
      level,
    });
  }

  return toc;
}

/**
 * 为 Markdown 标题添加 ID 属性（用于锚点跳转）
 */
export function addHeadingIds(markdown: string): string {
  return markdown.replace(/^(#{1,6})\s+(.+)$/gm, (match, hashes, text) => {
    const id = text
      .toLowerCase()
      .replace(/[^\u4e00-\u9fa5a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return `${hashes} ${text} {#${id}}`;
  });
}

/**
 * 获取所有可用的 Markdown 文件列表
 */
export function getAvailableMarkdownFiles(): string[] {
  const contentDir = path.join(process.cwd(), 'public', 'content');

  if (!fs.existsSync(contentDir)) {
    return [];
  }

  return fs
    .readdirSync(contentDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.replace(/\.md$/, ''));
}
