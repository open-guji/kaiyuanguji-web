// 古籍索引类型定义

export enum BookResourceType {
  WORK = 'work',           // 作品
  COLLECTION = 'collection', // 丛编
  BOOK = 'book',           // 书
}

export interface BookIndexItem {
  id: string;              // 唯一ID
  name: string;            // 古籍名称
  type: BookResourceType;  // 资源类型
  isDraft: boolean;        // 是否为草稿
  rawPath: string;         // GitHub 原始文件路径
  author?: string;         // 作者
  collection?: string;     // 收录于
  year?: string;           // 年份
  holder?: string;         // 现藏于
}

// GitHub API 返回的 JSON 结构
export interface BookIndexResponse {
  books?: Array<{
    id: string;
    title: string;
    path: string;
    author?: string;
    collection?: string;
    year?: string;
    holder?: string;
  }>;
  collections?: Array<{
    id: string;
    title: string;
    path: string;
    author?: string;
    year?: string;
  }>;
  works?: Array<{
    id: string;
    title: string;
    path: string;
    author?: string;
    year?: string;
  }>;
}
