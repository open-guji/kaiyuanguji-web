/**
 * 网站特有类型定义
 *
 * 通用索引类型已由 book-index-ui 提供，此文件仅保留网站特有的类型。
 */

/** 数字化资源信息（本地开发模式专用） */
export interface DigitalAssets {
  tex_files?: string[];
  image_manifest_url?: string;
}
