/**
 * ingest 的纯逻辑部分（锁、manifest 校验、state.json 原子写），便于单测。overview#561 一期。
 */
import { statSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export const EXIT = { LOCK_BUSY: 6, FALLBACK_REFUSED: 7, MANIFEST_BAD: 8 };
export const INDEXES = ['works', 'juans', 'books', 'collections', 'entities'];

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 互斥锁（O_EXCL 建文件，内含持有者信息；持有进程已死则视为陈旧并接管）。成功返回 release()；被占返回 { busy: holder }。 */
export function acquireLock(lockPath, info = {}) {
    mkdirSync(dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(lockPath, 'wx');
            writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), ...info }));
            closeSync(fd);
            return { release: () => { try { unlinkSync(lockPath); } catch { /* 已被清 */ } } };
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            let raw = null, holder = null;
            try { raw = readFileSync(lockPath, 'utf-8'); holder = JSON.parse(raw); } catch { /* 写入中或损坏 */ }
            let stale = false;
            if (holder?.pid && holder.host === hostname() && !pidAlive(holder.pid)) stale = true;
            // 建了文件但没写完内容就崩了：空／损坏的锁文件超过 60 秒视为陈旧（正常写入是毫秒级）
            else if (!holder) { try { stale = Date.now() - statSync(lockPath).mtimeMs > 60_000; } catch { /* 已被清 */ } }
            if (stale) {
                // 接管前再读一次：内容变了（别人刚接管并建了新锁）就不删，避免误删对方的活锁
                let again = null;
                try { again = readFileSync(lockPath, 'utf-8'); } catch { /* 已无 */ }
                if (again === raw) { try { unlinkSync(lockPath); } catch { /* 竞争 */ } }
                continue;
            }
            return { busy: holder ?? { unknown: true } };
        }
    }
    return { busy: { unknown: true } };
}

/** 流式读 jsonl.gz，同时算压缩字节的 sha256 与行数；onDocs 逐批回调（batchSize 条）。 */
export async function readJsonlGz(path, { batchSize = 1000, onBatch = async () => {} } = {}) {
    const hash = createHash('sha256');
    const src = createReadStream(path);
    src.on('data', (c) => hash.update(c));
    const rl = createInterface({ input: src.pipe(createGunzip()), crlfDelay: Infinity });
    let n = 0, batch = [];
    for await (const line of rl) {
        if (!line) continue;
        batch.push(JSON.parse(line)); n++;
        if (batch.length >= batchSize) { await onBatch(batch); batch = []; }
    }
    if (batch.length) await onBatch(batch);
    return { count: n, sha256: hash.digest('hex') };
}

/** manifest 结构校验（不含文件内容校验）：返回问题数组，空＝通过。 */
export function manifestProblems(m, { allowPartial = false, requireIndexes = INDEXES } = {}) {
    const p = [];
    if (!m || typeof m !== 'object') return ['manifest 不是对象'];
    if (m.schema !== 1) p.push(`manifest.schema=${m.schema}，本 ingest 只认 1`);
    if (m.partial && !allowPartial) p.push('manifest.partial=true（--limit/--only 的试跑产物），拒绝入库');
    if (!m.indexerVersion) p.push('缺 indexerVersion');
    // prod／derived 必须有（草稿 10-19 起不入搜索，commits.draft 可空）；text 只在要入 juans 时必须
    const need = ['prod', 'derived'];
    if (requireIndexes.includes('juans')) need.push('text');
    for (const k of need) if (!m.commits?.[k]) p.push(`commits.${k} 缺失`);
    for (const i of requireIndexes) {
        if (typeof m.counts?.[i] !== 'number') p.push(`counts.${i} 缺失`);
        if (!/^[0-9a-f]{64}$/.test(m.sha256?.[i] || '')) p.push(`sha256.${i} 缺失或格式不对`);
    }
    const e = m.editionStats;
    if (!e || ['total', 'present', 'positive'].some((k) => typeof e[k] !== 'number')) p.push('editionStats 缺失');
    return p;
}

/** state.json 原子写：先写 .tmp，旧的留作 .prev，再 rename。 */
export function writeState(statePath, state) {
    mkdirSync(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    if (existsSync(statePath)) copyFileSync(statePath, `${statePath}.prev`);
    renameSync(tmp, statePath);
}

export function readState(statePath) {
    try { return JSON.parse(readFileSync(statePath, 'utf-8')); } catch { return null; }
}
