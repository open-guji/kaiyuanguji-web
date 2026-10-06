/**
 * 本地联调用：KYG_LOCAL_PUBLIC_DATA=1 时把「读本机 public/data/」注册到 globalThis，item-data.ts 读到就用。
 * 只在 Node 端（页面的服务端数据模块）引入；中间件是 Edge 运行时，不要引入本文件。正式构建不设这个变量，这里什么都不做。
 */
import fs from 'node:fs';
import path from 'node:path';

if (process.env.KYG_LOCAL_PUBLIC_DATA === '1') {
    (globalThis as { __kygLocalPublicRead?: (p: string) => string | null }).__kygLocalPublicRead = (relPath: string) => {
        try {
            const file = path.join(process.cwd(), 'public', 'data', ...relPath.split('/'));
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
        } catch {
            return null;
        }
    };
}

export {};
