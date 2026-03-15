import { BookIndexItem, BookResourceType, BookIndexResponse, BookIndexDetailData } from '@/types';
import {
  DataSource, isLocalMode,
  GITHUB_BOOK_INDEX, GITHUB_BOOK_INDEX_DRAFT, JSDELIVR_FASTLY, JSDELIVR_CDN, GITHUB_ORG, GITHUB_BASE,
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
        // 计算本地资源路径: 从 Book/C/X/E/ID.json 提取 Book/C/X/E/ID
        const pathParts = (book.path || '').split('/');
        pathParts.pop();
        const baseDir = pathParts.join('/');
        const assetPath = baseDir ? `${baseDir}/${book.id}` : book.id;

        items.push({
          id: book.id,
          name: book.title || book.name,
          type: type,
          isDraft,
          rawPath: book.path,
          localPath: book.path,
          assetPath: assetPath,
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

  // 0. 本地模式：从本地 symlink 数据加载
  if (typeof window !== 'undefined' && isLocalMode) {
    try {
      const localItems = await fetchIndexFromSource('/local-data/index.json', true);
      if (localItems.length > 0) {
        console.log('Using local index data from book-index-draft');
        cachedItems[source] = localItems;
        return localItems;
      }
    } catch (e) {
      console.warn('Local index not found, falling back to remote strategies');
    }
  }

  // 定义获取函数
  const fetchStrategy = async (isDraft: boolean) => {
    // 1. 海外 (GitHub): 直接访问 raw.githubusercontent.com
    if (source === 'github') {
      const url = isDraft
        ? GITHUB_BOOK_INDEX_DRAFT
        : GITHUB_BOOK_INDEX;
      return fetchIndexFromSource(url, isDraft);
    }

    // 2. 国内 (Gitee): 使用 jsDelivr (Fastly -> CDN) 加速访问 GitHub 内容
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
    const draftItems = await fetchStrategy(true);
    allItems.push(...draftItems);
  } catch (error) {
    console.warn(`Failed to fetch draft index from ${source}:`, error);
  }

  // 获取正式版
  try {
    const officialItems = await fetchStrategy(false);
    allItems.push(...officialItems);
  } catch (error) {
    console.warn(`Failed to fetch official index from ${source}:`, error);
  }

  // 去重
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
 * 获取古籍详情（JSON）
 */
export async function fetchBookDetail(book: BookIndexItem, source: DataSource = 'github'): Promise<BookIndexDetailData> {
  // 0. 本地模式：从本地加载详情
  if (typeof window !== 'undefined' && isLocalMode && book.localPath) {
    try {
      const url = `/local-data/${book.localPath}`;
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) {
        console.log(`Using local book detail for ${book.id} from ${url}`);
        const detail = await response.json();
        return await enrichDetailWithDigitalAssets(book, detail);
      }
    } catch (e) {
      console.warn('Local detail fetch failed, falling back to remote:', e);
    }
  }

  // 1. 海外 (GitHub): 直接访问 raw.githubusercontent.com
  if (source === 'github') {
    const url = `${GITHUB_BASE}/${GITHUB_ORG}/${book.isDraft ? 'book-index-draft' : 'book-index'}/main/${encodeURI(book.rawPath)}`;
    const response = await fetch(url, { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`Failed to fetch book detail from ${source}: ${response.statusText}`);
    }
    const detail = await response.json();
    return await enrichDetailWithDigitalAssets(book, detail);
  }

  // 2. 国内 (Gitee): 使用 jsDelivr 加速 GitHub 源
  const repo = book.isDraft ? 'book-index-draft' : 'book-index';
  const branch = 'main';

  const fastlyUrl = `${JSDELIVR_FASTLY}/${GITHUB_ORG}/${repo}@${branch}/${encodeURI(book.rawPath)}`;
  const cdnUrl = `${JSDELIVR_CDN}/${GITHUB_ORG}/${repo}@${branch}/${encodeURI(book.rawPath)}`;

  try {
    const response = await fetch(fastlyUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      throw new Error(`Fastly status: ${response.status}`);
    }
    const detail = await response.json();
    return await enrichDetailWithDigitalAssets(book, detail);

  } catch (error) {
    console.warn('Fastly fetch failed, trying fallback CDN:', error);
    const response = await fetch(cdnUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch book detail from CDN: ${response.statusText}`);
    }
    const detail = await response.json();
    return await enrichDetailWithDigitalAssets(book, detail);
  }
}

/**
 * 为详情数据注入数字化资源信息
 */
async function enrichDetailWithDigitalAssets(book: BookIndexItem, detail: BookIndexDetailData): Promise<BookIndexDetailData> {
  const id = book.id;
  if (typeof window !== 'undefined' && isLocalMode) {
    try {
      // 优先使用索引中计算出的 assetPath，否则降级到 ID 目录
      const basePath = book.assetPath ? `/local-data/${book.assetPath}` : `/books/${id}`;

      const manifestUrl = `${basePath}/images/image_manifest.json`;
      const testRes = await fetch(manifestUrl, { method: 'HEAD' });
      if (testRes.ok) {
        detail.digital_assets = {
          image_manifest_url: manifestUrl,
          tex_files: ['ce01.tex'] // TODO: 动态扫描 tex 目录
        };
      }
    } catch (e) {
      // 忽略
    }
  }
  return detail;
}

/**
 * 根据 ID 获取古籍详情
 */
export async function fetchDetailById(id: string, source: DataSource = 'github'): Promise<BookIndexDetailData | null> {
  const book = await findBookById(id, source);
  if (!book) {
    return null;
  }
  return fetchBookDetail(book, source);
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
