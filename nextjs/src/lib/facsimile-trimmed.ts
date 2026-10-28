/**
 * 书影图源是否已裁去空白：殿本新图源（siku-qiefen-v2）的图地址带 `qiefen2` 段（`iiif/<书>/<册>/qiefen2/<页序>/…`），
 * 这类册本身没有空白可保留，阅读器不显示「书影保留空白」、一律整图（book-index-ui 的 `facsimileTrimmed`）。
 * 不加 manifest 字段：图源换了，地址里的段自然跟着变。
 */
import type { ReaderPageImage } from 'book-index-ui';

const TRIMMED_SEG = /\/qiefen\d+\//;

export function isFacsimileTrimmed(images: ReaderPageImage[] | null | undefined): boolean {
    const url = images?.[0]?.url;
    return typeof url === 'string' && TRIMMED_SEG.test(url);
}
