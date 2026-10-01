/**
 * data-content-digest.mjs — 打包产物（public/data）的内容摘要，并进 latest.json 的 cacheKey
 *
 * 为什么：cacheKey 原来只由三个数据仓的 commit 合成（latest-cache-key.mjs）。网站自己的打包脚本
 * （总目 catalog/、阅读首页 read/、元数据首页 meta-home/、meta.json、条目里注入的字段……）一改、
 * 数据仓没动，产物变了而 cacheKey 不变 → `current/<文件>?v=<cacheKey>` 的 URL 一字不变，
 * EdgeOne 对这个带参地址继续吐旧内容（10-01 实例：build-meta-home 修了 shelf，COS 上已是新内容，
 * 页面带旧 cacheKey 取到的还是 shelf: null 的旧版，测试站 verify 连挂两轮）。
 *
 * 做法：把「产物本身的内容」也并进 cacheKey——产物有任何一个字节变了键就变，没变键就不变。
 * 比并「打包脚本指纹」精确：脚本指纹把 package-lock 等都算进去（过保守），产物没变也会换键、
 * 让 CDN 白白冷一次；产物摘要只在产物真的变了才换。
 *
 * 纯函数（只读文件，不联网），jest／node --test 直接测。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 目录下所有文件的相对路径（正斜杠），已排序。迭代遍历（不递归）：current/ 有十几万个文件。 */
function listFiles(root) {
    const out = [];
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        const abs = rel ? join(root, rel) : root;
        for (const name of readdirSync(abs)) {
            const childRel = rel ? `${rel}/${name}` : name;
            const st = statSync(join(root, childRel));
            if (st.isDirectory()) stack.push(childRel);
            else out.push(childRel);
        }
    }
    return out.sort();
}

/**
 * 每次打包都会变、但与产物「内容」无关的字段（构建时间戳、耗时）。算摘要前先去掉，否则同样的数据每次打包摘要都不同，
 * 键天天换、CDN 白白变冷。新增会写时间戳／耗时的产物文件时往这里加（有测试守着：同一份输入打两次摘要要一样，
 * 10-01 用真实数据打两遍实测过，只有这两个文件不同）。
 */
export const VOLATILE_JSON = {
    'version.json': (doc) => { delete doc.bundleDate; },
    'search/meta.json': (doc) => {
        delete doc.builtAt;
        for (const idx of doc.indices ?? []) delete idx.buildMs;
    },
};

function contentOf(dir, rel) {
    const buf = readFileSync(join(dir, rel));
    const strip = VOLATILE_JSON[rel];
    if (!strip) return buf;
    try {
        const doc = JSON.parse(buf.toString('utf-8'));
        strip(doc);
        return Buffer.from(JSON.stringify(doc));
    } catch {
        return buf; // 解析不了就按原字节算（宁可多换一次键）
    }
}

/**
 * 目录内容摘要（16 位 hex）：对（相对路径、文件内容哈希）整体再哈希。
 * 只看路径与内容：不看 mtime、权限、遍历顺序，同样的产物在哪台机器上算都一样。
 */
export function computeDataContentDigest(dir) {
    const h = createHash('sha256');
    for (const rel of listFiles(dir)) {
        h.update(rel);
        h.update('\0');
        h.update(createHash('sha256').update(contentOf(dir, rel)).digest('hex'));
        h.update('\n');
    }
    return h.digest('hex').slice(0, 16);
}
