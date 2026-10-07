/**
 * 代码指针 web.json（overview#470 P1）：网站代码的「线上是哪一版」，与数据指针 latest.json 拆开。
 *
 * 背景：webCommitId 原来写在数据指针 latest.json 里，代码上线和数据上线会读改写同一个文件
 * （promote 与「数据没变」快路都改它）。数据流程（data.yml）独立以后，两条流程各管一个文件、各自单写者：
 *   latest.json  只由数据流程写（数据指针）
 *   web.json     只由代码流程写（正式站在根，测试站在 staging/）
 *
 * 字段：{ webCommitId（40 位 commit）, deployedAt（ISO 时间）, runId（GitHub Actions run id）}。
 * 过渡期（SPLIT_DATA_FLOW 切换之前）两边都写：latest.json 里的 webCommitId 照旧由原来的步骤写，
 * 本文件由部署成功之后的一步写。晋升、回滚计划仍以 latest.json 的 webCommitId 为准——回滚到早于本改动的
 * 旧 commit 时，旧 deploy.yml 只会更新 latest.json，web.json 会落后到下一次正常部署；读者按这个口径取。
 */

const SHA_RE = /^[0-9a-f]{40}$/;

export function webPointerKey(prefix = '') {
    const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
    return p ? `${p}/web.json` : 'web.json';
}

/** 生成要写的对象；webCommitId 必须是完整 commit，否则抛错（不写半截指针） */
export function buildWebPointer({ webCommitId, runId = '', now = new Date() } = {}) {
    if (!SHA_RE.test(String(webCommitId || ''))) throw new Error(`webCommitId 不是 40 位 commit：${webCommitId || '（空）'}`);
    return {
        webCommitId,
        deployedAt: now.toISOString(),
        runId: String(runId || ''),
    };
}

/** 读回来的文本 → 指针对象；不是合法指针返回 null */
export function parseWebPointer(text) {
    let j;
    try { j = JSON.parse(text); } catch { return null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    if (!SHA_RE.test(String(j.webCommitId || ''))) return null;
    return {
        webCommitId: j.webCommitId,
        deployedAt: typeof j.deployedAt === 'string' ? j.deployedAt : '',
        runId: typeof j.runId === 'string' ? j.runId : '',
    };
}
