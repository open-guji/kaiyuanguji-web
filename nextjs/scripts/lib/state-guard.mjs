/**
 * state-guard.mjs — 同步 state 缓存的「可信度保护」（写前标记 + 远端指针核对）
 *
 * 背景（overview#469、kaiyuanguji-web#275）：三路同步（current/、h1 条目、h1 文本）靠一份本地 state
 * （相对路径 → md5）判断「传不传」，state 存在 actions/cache 里跨次使用。state 只在同步成功后才更新，
 * 所以同步**中途**被取消或失败时，桶已经被改了一部分，缓存里留着的还是更早的旧 state——
 * 下一次拿它判断，会把「桶里已被换成别的内容」的对象当成「没变」而跳过上传（run 37580114922 被取消、
 * 37588367536 取回旧 state 的事故：staging current/ 留着 schema-v2 产物，latest.json 却是 main）。
 *
 * 只比 latest.json／manifest-root.json 这类指针不够：指针是**最后**才翻转的，中途取消时指针还是旧值，
 * 和旧 state 记的一致，照样判「可信」。所以用写前标记（write-ahead）：
 *
 *   1. 要动桶之前（所有上传／删除之前），先往 COS 写一份标记 {generation: G新, status: 'dirty'}；
 *   2. 同步全部成功后：本地 state 存成 {generation: G新, pointer}，再把 COS 标记改成 {G新, 'clean', pointer}；
 *   3. 下一次用缓存里的 state 之前先读 COS 标记：必须 generation 相同、status 为 clean、且 COS 上现行指针
 *      与 state 记的 pointer 一致，才算可信；否则丢掉 state、从 COS 列出重建。
 *
 * 各种中断都落在「不可信」一侧：
 *   - 步骤 1 之前被取消：桶没动过，标记还是上次的 clean/G旧，与缓存 state 一致 → 可信（正确）；
 *   - 步骤 1～2 之间被取消／失败：标记是 dirty/G新，缓存里只会有 G旧或没有 → 不可信 → 重建；
 *   - 步骤 2 里本地 state 已存、COS 标记没改成 clean：标记 dirty → 不可信 → 重建；
 *   - 缓存里的 state 没有 generation（旧格式、首次）或 COS 上没有标记：不可信 → 重建；
 *   - 别的写入者（手工脚本、回滚）改了指针：pointer 对不上 → 不可信 → 重建。
 * 唯一覆盖不到的是「有人手工改桶里的对象、既没碰指针也没碰标记」，这种靠每日定时那次的强制重建兜底。
 *
 * 标记写不进去（步骤 1 失败）时调用方必须中止、不动桶——否则无法保证后面的中断可被发现。
 * 步骤 2 的 COS 标记写失败只警告（后果只是下一次重建）。
 */
import { randomBytes } from 'node:crypto';

export const GUARD_VERSION = 1;

/** 标记对象的 key：<前缀>/_deploy/state-guard-<name>.json（与 cos-sync-decision 的 _deploy/ 同处）。 */
export function guardKey(pathPrefix, name) {
    const p = String(pathPrefix || '').replace(/^\/+|\/+$/g, '');
    return `${p ? `${p}/` : ''}_deploy/state-guard-${name}.json`;
}

export function newGeneration() {
    return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

export function parseGuardDoc(raw) {
    try {
        const d = JSON.parse(raw);
        if (d?.version !== GUARD_VERSION || typeof d.generation !== 'string' || !d.generation) return null;
        if (d.status !== 'clean' && d.status !== 'dirty') return null;
        return { generation: d.generation, status: d.status, pointer: typeof d.pointer === 'string' ? d.pointer : null };
    } catch {
        return null;
    }
}

export function serializeGuardDoc({ generation, status, pointer = null }) {
    return JSON.stringify({ version: GUARD_VERSION, generation, status, pointer, at: new Date().toISOString() });
}

/**
 * 指针文件（manifest-root.json／text-manifest-root.json／latest.json）里「这一版是谁」的值：
 * h1 指针取 root，latest.json 取 cacheKey；都没有就退回去掉空白的原文。读不出就是 null。
 */
export function pointerOf(raw) {
    if (raw == null) return null;
    try {
        const d = JSON.parse(raw);
        const v = d?.root ?? d?.cacheKey;
        if (typeof v === 'string' && v) return v;
    } catch { /* 不是 JSON，走下面 */ }
    const t = String(raw).trim();
    return t || null;
}

/**
 * 纯函数：本地 state 是否可信。
 * @param {{generation?: string, pointer?: string|null}|null} meta  state 文件里记的
 * @param {{generation: string, status: string}|null} remoteDoc   COS 上的标记（读不到／不合法为 null）
 * @param {string|null} remotePointer  COS 上现行指针的值（不存在为 null）
 */
export function judgeState({ meta, remoteDoc, remotePointer }) {
    if (!meta || !meta.generation) return { trusted: false, reason: 'state 没有版本记录（旧格式或首次）' };
    if (!remoteDoc) return { trusted: false, reason: 'COS 上没有（可用的）版本标记' };
    if (remoteDoc.status !== 'clean') return { trusted: false, reason: '上一次同步没走完（COS 标记仍是 dirty）' };
    if (remoteDoc.generation !== meta.generation) {
        return { trusted: false, reason: `state 版本 ${meta.generation} 与 COS 标记 ${remoteDoc.generation} 不一致（state 不是最近一次成功同步存的）` };
    }
    if (meta.pointer != null && remotePointer !== meta.pointer) {
        return { trusted: false, reason: `COS 上现行指针 ${remotePointer ?? '（不存在）'} 与 state 记的 ${meta.pointer} 不一致` };
    }
    return { trusted: true, reason: 'ok' };
}

/**
 * 读 COS 上的标记与指针，判断 state 是否可信。读取出错一律当不可信（宁可多列一次）。
 * @param {{getText: (key: string) => Promise<string|null>, key: string, meta: object|null, pointerKey: string}} o
 */
export async function checkState({ getText, key, meta, pointerKey }) {
    if (!meta || !meta.generation) return judgeState({ meta, remoteDoc: null, remotePointer: null });
    try {
        const remoteDoc = parseGuardDoc(await getText(key));
        const remotePointer = meta.pointer != null && pointerKey ? pointerOf(await getText(pointerKey)) : null;
        return judgeState({ meta, remoteDoc, remotePointer });
    } catch (e) {
        return { trusted: false, reason: `读取 COS 标记／指针失败（${e.message}）` };
    }
}

/** 动桶之前调用，返回这一轮的 generation。写不进去会抛错——调用方不许继续动桶。 */
export async function markDirty({ putText, key }) {
    const generation = newGeneration();
    await putText(key, serializeGuardDoc({ generation, status: 'dirty' }));
    return generation;
}

/** 同步全部成功后调用。写失败只警告（下一次会因标记仍是 dirty 而重建），返回是否写成。 */
export async function markClean({ putText, key, generation, pointer, warn = console.warn }) {
    try {
        await putText(key, serializeGuardDoc({ generation, status: 'clean', pointer }));
        return true;
    } catch (e) {
        warn(`  ⚠ state 版本标记改 clean 失败（${e.message}）：下一次同步会重建 state，不影响本次发布`);
        return false;
    }
}

/**
 * 给同步脚本用的一站式封装。ops 需要 getObjectText(key)→string|null、putObjectText(key, body, {contentType, cacheControl})
 * （h1-sync-core 的 createCosOps 返回值即是；sync-to-cos.mjs 自己包一层）。
 *   check(meta)            读标记与指针，判断本地 state 是否可信
 *   begin()                动桶之前调用，写 dirty 标记，返回 generation（失败抛错，调用方必须中止）
 *   finish(generation, pointer)  全部成功后调用，改 clean
 */
export function createStateGuard({ ops, pathPrefix, name, pointerKey }) {
    const key = guardKey(pathPrefix, name);
    const putText = (k, body) => ops.putObjectText(k, body, { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' });
    return {
        key,
        check: (meta) => checkState({ getText: (k) => ops.getObjectText(k), key, meta, pointerKey }),
        begin: () => markDirty({ putText, key }),
        finish: (generation, pointer) => markClean({ putText, key, generation, pointer }),
    };
}
