/**
 * 大章书首屏正文（overview#586）：章太大不进种子时，服务端只取 `.txt` 的前一小段做 lead。
 * 按字节取会把末尾的汉字切在 UTF-8 中间，这里把解码和收尾做成纯函数，单测直接构造「切在汉字中间」的输入。
 */

/** 解码章首字节：末尾被切断的多字节字符（解码成替换字符 U+FFFD）丢掉；被截断的再收到最后一个换行，保证只给完整段落 */
export function decodeChapterHead(bytes: Uint8Array, truncated: boolean): string {
    let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    text = text.replace(/�+$/, '');
    if (truncated) {
        const cut = text.lastIndexOf('\n');
        // 整段都没有换行（单段超长）就保留已有部分，由 leadParagraphs 按码位截断
        if (cut > 0) text = text.slice(0, cut).trimEnd();
    }
    return text;
}
