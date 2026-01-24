import { BookIndexItem, BookResourceType, BookIndexResponse } from '@/types';
import {
  DataSource,
  GITHUB_BOOK_INDEX, GITHUB_BOOK_INDEX_DRAFT, JSDELIVR_FASTLY, JSDELIVR_CDN, GITHUB_ORG,
  GITEE_BOOK_INDEX, GITEE_BOOK_INDEX_DRAFT, GITEE_BASE, GITEE_ORG
} from '@/lib/constants';

// 内存缓存 (按数据源缓存)
let cachedItems: Record<string, BookIndexItem[]> = {};

/**
 * 从数据源获取索引数据
 */
async function fetchIndexFromSource(url: string, isDraft: boolean): Promise<BookIndexItem[]> {
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      // 设置超时，防止 GitHub 在国内卡死导致整个流程挂掉
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch from ${url}: ${response.statusText}`);
    }

    const data: BookIndexResponse = await response.json();
    const items: BookIndexItem[] = [];

    // 解析项目
    const processItems = (record: any, type: BookResourceType) => {
      if (!record) return;
      Object.values(record).forEach((book: any) => {
        items.push({
          id: book.id,
          name: book.title || book.name,
          type: type,
          isDraft,
          rawPath: book.path,
          author: book.author,
          collection: book.collection,
          year: book.year,
          holder: book.holder,
        });
      });
    };

    processItems(data.books, BookResourceType.BOOK);
    processItems(data.collections, BookResourceType.COLLECTION);
    processItems(data.works, BookResourceType.WORK);

    return items;
  } catch (err) {
    throw err;
  }
}

/**
 * 获取所有古籍（支持指定数据源）
 */
export async function fetchAllBooks(source: DataSource = 'github'): Promise<BookIndexItem[]> {
  // 返回缓存
  if (cachedItems[source]) {
    return cachedItems[source];
  }

  const allItems: BookIndexItem[] = [];

  // 定义获取函数：支持重试
  const fetchWithFallback = async (isDraft: boolean) => {
    // 无论 source 是 github 还是 gitee，统一使用 jsDelivr 加速 GitHub 源
    // 因为 Gitee OpenAPI 和 Raw 访问均不稳定
    const repo = isDraft ? 'book-index-draft' : 'book-index';
    const branch = 'main';
    const fastlyUrl = `${JSDELIVR_FASTLY}/${GITHUB_ORG}/${repo}@${branch}/index.json`;
    const cdnUrl = `${JSDELIVR_CDN}/${GITHUB_ORG}/${repo}@${branch}/index.json`;

    try {
      return await fetchIndexFromSource(fastlyUrl, isDraft);
    } catch (err) {
      console.warn('Fastly index fetch failed, trying fallback:', err);
      return await fetchIndexFromSource(cdnUrl, isDraft);
    }
  };

  // 获取草稿版
  try {
    const draftItems = await fetchWithFallback(true);
    allItems.push(...draftItems);
  } catch (error) {
    console.warn(`Failed to fetch draft index from ${source}:`, error);
  }

  // 获取正式版
  try {
    const officialItems = await fetchWithFallback(false);
    allItems.push(...officialItems);
  } catch (error) {
    console.warn(`Failed to fetch official index from ${source}:`, error);
  }

  // 去重：如果同一个 ID 既在草稿又在正式版，优先保留正式版
  const uniqueItemsMap = new Map<string, BookIndexItem>();
  allItems.forEach(item => {
    uniqueItemsMap.set(item.id, item);
  });

  const finalItems = Array.from(uniqueItemsMap.values());
  cachedItems[source] = finalItems;
  return finalItems;
}

/**
 * 根据 ID 查找古籍
 */
export async function findBookById(id: string, source: DataSource = 'github'): Promise<BookIndexItem | null> {
  const allBooks = await fetchAllBooks(source);
  return allBooks.find((book) => book.id === id) || null;
}

/**
 * 获取古籍内容（Markdown）
 */
export async function fetchBookContent(book: BookIndexItem, source: DataSource = 'github'): Promise<string> {
  // 无论 source 是 github 还是 gitee，统一使用 jsDelivr 加速 GitHub 源
  const repo = book.isDraft ? 'book-index-draft' : 'book-index';
  const branch = 'main'; // 假设默认都是 main

  // 构造两个 URL: fastly 和 cdn
  const fastlyUrl = `${JSDELIVR_FASTLY}/${GITHUB_ORG}/${repo}@${branch}/${book.rawPath}`;
  const cdnUrl = `${JSDELIVR_CDN}/${GITHUB_ORG}/${repo}@${branch}/${book.rawPath}`;

  try {
    // 尝试 Fastly
    const response = await fetch(fastlyUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000), // 8秒超时
    });

    if (!response.ok) {
      throw new Error(`Fastly status: ${response.status}`);
    }
    return await response.text();

  } catch (error) {
    console.warn('Fastly fetch failed, trying fallback CDN:', error);

    // 失败切换到普通 CDN
    const response = await fetch(cdnUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch book content from CDN: ${response.statusText}`);
    }
    return await response.text();
  }
}

/**
 * 根据 ID 获取古籍内容
 */
export async function fetchContentById(id: string, source: DataSource = 'github'): Promise<string | null> {
  const book = await findBookById(id, source);
  if (!book) {
    return null;
  }
  return fetchBookContent(book, source);
}

/**
 * 清除缓存
 */
export function clearCache(): void {
  cachedItems = {};
}

/**
 * 搜索古籍（按名称或 ID）
 */
export async function searchBooks(query: string, source: DataSource = 'github'): Promise<BookIndexItem[]> {
  const allBooks = await fetchAllBooks(source);

  if (!query.trim()) {
    return allBooks;
  }

  const lowerQuery = query.toLowerCase();
  return allBooks.filter(
    (book) =>
      book.name.toLowerCase().includes(lowerQuery) ||
      book.id.toLowerCase().includes(lowerQuery)
  );
}

/**
 * 获取类型标签文本
 */
export function getTypeLabel(type: BookResourceType): string {
  switch (type) {
    case BookResourceType.WORK:
      return '作品';
    case BookResourceType.COLLECTION:
      return '丛编';
    case BookResourceType.BOOK:
      return '书';
    default:
      return '';
  }
}

/**
 * 获取状态标签文本
 */
export function getStatusLabel(isDraft: boolean): string {
  return isDraft ? '草稿' : '正式';
}
