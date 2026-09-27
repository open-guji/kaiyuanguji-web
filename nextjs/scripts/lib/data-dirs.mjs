/**
 * data-dirs.mjs — 数据产物目录的统一解析（S2：数据产物挪出 public/）。
 *
 * 打包／同步脚本以前把产物目录写死在 nextjs/public/ 下：
 *   public/data/          bundle-data.mjs 产出，sync-to-cos.mjs 上传
 *   public/latest.json    bundle-data.mjs 产出（data/ 同级），sync-to-cos.mjs 上传
 *   public/data-h1/       bundle-hashed.mjs 产出，sync-h1-to-cos.mjs 上传
 *   public/data-h1-text/  bundle-hashed-text.mjs 产出，sync-h1-text-to-cos.mjs 上传
 *
 * 这些目录（十几万文件）留在 public/ 会随 `next build` 进 out/，也会拖慢／撑爆
 * 全栈模式的 next build／next start。本模块让它们可以整体挪到 nextjs/ 之外，
 * 生产方与消费方读同一组环境变量，保证读写同一个目录。
 *
 * 环境变量（优先级：单项 > 根目录 > 默认）：
 *   KYG_DATA_ROOT      四项产物的共同根目录；CI 设成如 $RUNNER_TEMP/kyg-data
 *   DATA_OUT_DIR       单独指定 data/ 目录
 *   DATA_LATEST_FILE   单独指定 latest.json 路径（不设则放在 data/ 目录的同级）
 *   H1_OUT_DIR         单独指定 data-h1/ 目录（沿用 A3 已有的变量名）
 *   H1_TEXT_OUT_DIR    单独指定 data-h1-text/ 目录（沿用 A3b 已有的变量名）
 *
 * 都不设时与改动前完全一致（全在 nextjs/public/ 下），本地开发照旧。
 * 相对路径按当前工作目录解析（与 path.resolve 一致）。
 */

import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 默认根目录：nextjs/public */
export const DEFAULT_DATA_ROOT = resolve(__dirname, '..', '..', 'public');

/**
 * 解析四项产物路径。传入 env 便于单测，缺省读 process.env。
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ root: string, dataDir: string, latestFile: string, h1Dir: string, h1TextDir: string }}
 */
export function resolveDataDirs(env = process.env) {
    const pick = (name) => (env[name] && env[name].trim()) || null;
    const root = resolve(pick('KYG_DATA_ROOT') || DEFAULT_DATA_ROOT);
    const dataDir = resolve(pick('DATA_OUT_DIR') || join(root, 'data'));
    return {
        root,
        dataDir,
        latestFile: resolve(pick('DATA_LATEST_FILE') || join(dirname(dataDir), 'latest.json')),
        h1Dir: resolve(pick('H1_OUT_DIR') || join(root, 'data-h1')),
        h1TextDir: resolve(pick('H1_TEXT_OUT_DIR') || join(root, 'data-h1-text')),
    };
}
