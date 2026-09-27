/**
 * h1-roots-dryrun-backend.mjs — runRootsRetention() 在 DRY_RUN 模式下的假「桶」
 *
 * runRootsRetention（h1-sync-core.mjs）不认识 COS，只认识一个四方法 backend
 * （readText/writeText/deleteKey/listPrefix）。真跑时那四个方法直接转发给
 * cos-nodejs-sdk-v5（createCosRootsBackend）；dry-run 时没有真实 COS 可读，
 * 但"在用 root 集合怎么算、哪些分片/roots 文件该删"这套决策逻辑本身值得在
 * dry-run 里也真正跑一遍，不只是打印"如果跑了会怎样"——所以这里用一个本地
 * JSON 文件模拟"整个 h1/ 前缀下的桶内容"（key → 文本内容），持久化在
 * `.next/`，让连续两次 dry-run（比如两个真实相邻提交）能看到「上一轮上传的
 * 指针/roots/manifest 分片」，从而验证「两个 root 同时存在、孤儿判定跟着
 * 在用集合走」这件事，而不是每次都从空桶算起。
 *
 * 这只是 dry-run 的模拟状态，不代表真实 COS 内容，切勿在真实同步路径里使用。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function createDryRunRootsBackend(storeFile) {
    function load() {
        try {
            return existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf-8')) : {};
        } catch {
            return {};
        }
    }
    let store = load();

    function persist() {
        mkdirSync(dirname(storeFile), { recursive: true });
        writeFileSync(storeFile, JSON.stringify(store));
    }

    return {
        async readText(key) {
            return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
        },
        async writeText(key, body) {
            store[key] = body;
            persist();
        },
        async deleteKey(key) {
            delete store[key];
            persist();
        },
        async listPrefix(prefix) {
            return Object.keys(store)
                .filter((k) => k.startsWith(prefix))
                .map((k) => k.slice(prefix.length));
        },
    };
}
