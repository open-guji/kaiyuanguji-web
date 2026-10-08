// 网站代码「线上是哪一版」的统一读法（overview#470 P1，方案 A）。规则和理由见 ops/code_pointer.py 的文件头；
// 这里是 Node 版，行为必须与它逐例一致（ops/tests/code-pointer.test.mjs 与 test_code_pointer.py 用同一张用例表对拍）。
const SHA = /^[0-9a-f]{40}$/;
export const MARKER_KEY = 'codePointer';
export const MARKER_VALUE = 'web.json';

const commitOf = (doc) => (doc && typeof doc === 'object' && typeof doc.webCommitId === 'string' && SHA.test(doc.webCommitId) ? doc.webCommitId : '');

/**
 * @param {object|null} latest 数据指针
 * @param {object|null} web    代码指针
 * @returns {{ commit: string, source: string, marked: boolean, mismatch: boolean, notes: string[] }}
 */
export function resolveCodeCommit(latest, web) {
    const marked = !!latest && typeof latest === 'object' && latest[MARKER_KEY] === MARKER_VALUE;
    const lc = commitOf(latest);
    const wc = commitOf(web);
    const mismatch = !!(lc && wc && lc !== wc);
    const notes = [];
    let commit;
    let source;
    if (marked) {
        if (wc) {
            commit = wc; source = 'web.json';
            if (mismatch) {
                notes.push(`latest.json 已标 codePointer：以 web.json 为准（web.json=${wc.slice(0, 12)}，latest.json=${lc.slice(0, 12)}）；`
                    + '开关打开后 latest.json 的 webCommitId 不再更新，不一致是正常的');
            }
        } else {
            commit = lc; source = 'latest.json（web.json 缺失，退回）';
            notes.push('latest.json 已标 codePointer，但 web.json 读不到或不合法，退回 latest.json 的 webCommitId'
                + `（${lc.slice(0, 12) || '空'}）——它可能已经过期，核对结果仅供参考`);
        }
    } else {
        commit = lc; source = 'latest.json';
        if (mismatch) notes.push(`（参考）web.json=${wc.slice(0, 12)} 与 latest.json=${lc.slice(0, 12)} 不同；latest.json 未标 codePointer，以 latest.json 为准`);
    }
    return { commit, source, marked, mismatch, notes };
}
