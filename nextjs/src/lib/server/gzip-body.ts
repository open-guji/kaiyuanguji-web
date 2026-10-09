// 函数出口自己 gzip（overview#487 的发现：EdgeOne 不替函数输出做边缘压缩，函数看到的 Accept-Encoding 恒为 identity，
// 但函数自带 Content-Encoding 时网关会按客户端头转码——gzip 透传、br 转 br、identity 解成明文）。
// 只能在 Node 运行时（云函数）用；中间件跑在边缘运行时，不要从那里引这个文件。
import { gzipSync } from 'node:zlib';

export function gzipText(text: string): Buffer {
    return gzipSync(Buffer.from(text, 'utf-8'));
}
