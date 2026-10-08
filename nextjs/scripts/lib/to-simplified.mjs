/**
 * 构建脚本用的繁→简入口（overview#448 S0）：与网站服务端（src/lib/server/simplify.ts）同一份逻辑，
 * 只是在这里注入 opencc-js 与异体字表。不要在脚本里自己 new Converter。
 */
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { Converter } from 'opencc-js';
import { createToSimplified } from '../../src/lib/to-simplified-core.mjs';

const require = createRequire(import.meta.url);
const variants = JSON.parse(readFileSync(require.resolve('book-index-ui/variant-chars.json'), 'utf-8'));

export const toSimplified = createToSimplified({
    createConverter: () => Converter({ from: 't', to: 'cn' }),
    variants,
});
