/**
 * 取版本目录下的文本 JSON（校对层、待审单、下载导出等本站功能用）。
 * 对读数据本身（char／cord／punct／entity／norm／fig）的读取在 book-index-ui 里（loadReaderChapter），不在这里。
 *
 * storage（cos 数据源，含 h1 哈希寻址）上有 `getTextFile` 就走它；bundle／本地模式没有，退回同域 `/data/items/...`。
 */

/** 同域数据目录：storage 没有 getTextFile 时的退路（也传给 book-index-ui 的 textFileBase） */
export const TEXT_FILE_BASE = '/data/items';

export async function getJson(storage: object | undefined, id: string, key: string, file: string): Promise<unknown> {
    try {
        const getTextFile = (storage as { getTextFile?: (id: string, key: string, file: string) => Promise<unknown> } | undefined)?.getTextFile;
        if (typeof getTextFile === 'function') return (await getTextFile.call(storage, id, key, file)) ?? null;
        const res = await fetch(`${TEXT_FILE_BASE}/${id}/${key}/${file}`);
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}
