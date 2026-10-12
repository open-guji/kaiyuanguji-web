/**
 * Meili 操作与 swap 重建/自检闸（从 full-reindex.mjs 抽出，overview#561）。
 * full-reindex.mjs（旧全量）与 ingest.mjs（搜索机入库）共用同一份，闸的口径不分叉。
 */
import { FOUR_BU, classificationCoverageProblem, classificationRatioProblem } from './work-fields.mjs';
import { checkDocFloor } from './doc-floor.mjs';

// ─── settings ───

// A4（2026-09-27）searchableAttributes 顺序统一改成 书名 > 作者 > 其他名/别名 > （其余）> 简介：
// 简介放最后一位，与「精简版、不抢排面」的口径一致；任务书 §二 明定这个顺序，
// pinyin／indexed_by_search 不在裁定范围内，保持原有相对位置（在别名之后、简介之前）。
export const SETTINGS = {
    works: {
        searchableAttributes: ['title_search', 'author_search', 'aliases_search', 'pinyin', 'description_search', 'indexed_by_search'],
        filterableAttributes: ['type', 'is_draft', 'dynasty', 'subtype', 'has_collated', 'has_text', 'has_image', 'classification', 'loss_status'],
        sortableAttributes: ['completeness', 'juan_count', 'title_chars', 'era_rank', 'title_sort'],
        // #281（2026-09-29）：completeness 提到 exactness 前面。同长度标题平局时先看「分量」，
        // 不再让 exactness 决胜——中文的 exactness 受 jieba 分词左右（简体「三国志」切成一个词、
        // 「三国论」切成「三国」＋「论」），搜「三国」时《三國論》算开头匹配、《三國志》不算，
        // 于是三國論／文／評把三國志、三國演義压到第 5 名以后。换序后 1,973 个压测查询里第 1 名
        // 只变了 14 个（0.7%），且多是变好（春→春秋、金→金史、明→明史、千→千字文）。
        // sort 放最前：搜索页 v4 选了「按年代／按书名」就严格按它排（没带 sort 参数时这条规则不起作用）
        rankingRules: ['sort', 'words', 'typo', 'proximity', 'attribute', 'title_chars:asc', 'completeness:desc', 'exactness'],
    },
    books: {
        searchableAttributes: ['title_search', 'author_search', 'aliases_search', 'edition_search', 'holder_search', 'pinyin', 'description_search'],
        filterableAttributes: ['type', 'is_draft', 'dynasty', 'has_text', 'has_image', 'holder'],
        sortableAttributes: ['completeness', 'title_chars', 'era_rank', 'title_sort'],
        rankingRules: ['sort', 'words', 'typo', 'proximity', 'attribute', 'title_chars:asc', 'exactness', 'completeness:desc'],
    },
    collections: {
        searchableAttributes: ['title_search', 'pinyin'],
        filterableAttributes: ['type', 'is_draft'],
    },
    entities: {
        searchableAttributes: ['name_search', 'pinyin'],
        filterableAttributes: ['type', 'is_draft', 'subtype', 'dynasty'],
        sortableAttributes: ['completeness', 'title_chars', 'era_rank', 'title_sort'],
        rankingRules: ['sort', 'words', 'typo', 'proximity', 'attribute', 'exactness'],
    },
    juans: {
        searchableAttributes: ['content_search', 'juan_name'],
        filterableAttributes: ['work_id'],
        rankingRules: ['words', 'typo', 'proximity', 'attribute', 'exactness'],
    },
};


export function createMeiliOps({ url, key, allowShrink = false }) {
// ─── HTTP ───

async function meiliRequest(method, path, body) {
    const r = await fetch(`${url}${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`${method} ${path}: ${r.status} ${t}`);
    }
    return r.json();
}

async function waitForTask(taskUid, timeoutMs = 600_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const t = await meiliRequest('GET', `/tasks/${taskUid}`);
        if (['succeeded', 'failed', 'canceled'].includes(t.status)) {
            if (t.status !== 'succeeded') {
                throw new Error(`task ${taskUid} ${t.status}: ${JSON.stringify(t.error || t)}`);
            }
            return t;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`task ${taskUid} timed out`);
}

async function pushBatch(indexUid, docs) {
    // 防御性：过滤掉空 ID（Meili 拒绝接受任何含空 id 的批次）
    const valid = docs.filter(d => d && d.id && typeof d.id === 'string' && /^[A-Za-z0-9_-]+$/.test(d.id));
    if (valid.length < docs.length) {
        console.warn(`  [${indexUid}] dropped ${docs.length - valid.length} doc(s) with invalid id`);
    }
    if (valid.length === 0) return null;
    const r = await meiliRequest('POST', `/indexes/${indexUid}/documents`, valid);
    return r.taskUid;
}

async function configureSettings(indexUid, settings) {
    const t = await meiliRequest('PATCH', `/indexes/${indexUid}/settings`, settings);
    await waitForTask(t.taskUid);
}

// ─── swap 式重建（A4，2026-09-27）───
//
// 此前是先 DELETE 整个索引再重建：DELETE 生效到重建完之间，线上这个索引是空的
// ——O1 实测每晚约 8 分钟空窗，其间该类目搜索恒为 0 结果。
// 改法：新数据全部先建到 `<idx>_tmp`（settings 也配在 tmp 上），自检通过后
// 用 Meili 的 /swap-indexes 原子换名，线上流量在换名前后都读得到完整数据、
// 中间没有「索引不存在/为空」的窗口；自检不通过就直接删掉 tmp，`<idx>` 原封不动。

function tmpIndexUid(indexUid) {
    return `${indexUid}_tmp`;
}

async function indexExists(indexUid) {
    try {
        await meiliRequest('GET', `/indexes/${indexUid}`);
        return true;
    } catch {
        return false;
    }
}

/** 保证 indexUid 存在（可以是空的）——只有当它已存在时 /swap-indexes 才能把 tmp 换进去。 */
async function ensureIndexExists(indexUid, primaryKey = 'id') {
    if (await indexExists(indexUid)) return;
    const t = await meiliRequest('POST', '/indexes', { uid: indexUid, primaryKey });
    await waitForTask(t.taskUid);
}

/** 把 tmp 索引清空重建（每轮重建都从空的开始，不残留上一轮失败的半成品）。 */
async function createFreshTmpIndex(indexUid, primaryKey = 'id') {
    const tmp = tmpIndexUid(indexUid);
    if (await indexExists(tmp)) {
        const t = await meiliRequest('DELETE', `/indexes/${tmp}`);
        await waitForTask(t.taskUid).catch(() => {});
    }
    const t = await meiliRequest('POST', '/indexes', { uid: tmp, primaryKey });
    await waitForTask(t.taskUid);
    return tmp;
}

/** 索引条数：{state:'ok',docs} 读到了；{state:'absent'} 明确 404（没建过）；{state:'unreadable',error} 其它情况一律读不到。 */
async function docCount(indexUid) {
    try {
        const st = await meiliRequest('GET', `/indexes/${indexUid}/stats`);
        if (typeof st.numberOfDocuments !== 'number') return { state: 'unreadable', error: 'stats 里没有 numberOfDocuments' };
        return { state: 'ok', docs: st.numberOfDocuments };
    } catch (e) {
        if (/: 404 /.test(e.message)) return { state: 'absent' };
        return { state: 'unreadable', error: e.message };
    }
}

/** 自检没过：删 tmp、线上原封不动，返回 false。 */
async function discardTmp(indexUid, tmp, failures) {
    console.error(`❌ [${indexUid}] 自检未通过，放弃本次更新：`);
    for (const f of failures) console.error(`   · ${f}`);
    console.error(`   已删除 ${tmp}，线上 ${indexUid} 保持不变（未 swap）`);
    await meiliRequest('DELETE', `/indexes/${tmp}`).catch(() => {});
    return false;
}

/**
 * 自检通过则原子 swap（tmp → 正式名），线上无空窗；不通过则删 tmp、退出非 0、
 * 保留旧索引不动。selfTestFn 收 tmp 的 indexUid，返回 { ok, failures }。
 */
/** 自检＋文档数下限闸，不 swap、不删 tmp。返回 { ok, failures }。 */
async function verifyTmp(indexUid, selfTestFn) {
    const tmp = tmpIndexUid(indexUid);
    const { ok, failures } = await selfTestFn(tmp);
    // 文档数下限闸（overview#122）：新建的比线上少一半以上，多半是脚本读不到数据，别把空的换上去。
    // 线上或 tmp 的条数读不到（接口出错、没有数值）时也不换：没有可靠的基线就不放行。只有线上索引明确 404（还没建过）才算「线上没有」。
    if (ok && !allowShrink) {
        const live = await docCount(indexUid);
        const fresh = await docCount(tmp);
        if (live.state === 'unreadable') failures.push(`文档数下限：读不到线上 ${indexUid} 的条数（${live.error}），无法确认新索引没有缩水`);
        else if (fresh.state !== 'ok') failures.push(`文档数下限：读不到新建的 ${tmp} 的条数（${fresh.error || '索引不存在'}）`);
        else {
            const floor = checkDocFloor(live.state === 'ok' ? live.docs : null, fresh.docs);
            if (!floor.ok) failures.push(`文档数下限：${floor.reason}`);
            else console.log(`📏 [${indexUid}] 下限闸通过：线上 ${live.state === 'ok' ? live.docs : '（无）'} 条 → 新 ${fresh.docs} 条`);
        }
    }
    return { ok: ok && failures.length === 0, failures };
}

/** 把已验过的 tmp 换上位并删旧。 */
async function swapTmp(indexUid) {
    const tmp = tmpIndexUid(indexUid);
    await ensureIndexExists(indexUid); // 首次跑：正式名还不存在，先占一个空的才有得 swap
    const swapTask = await meiliRequest('POST', '/swap-indexes', [{ indexes: [indexUid, tmp] }]);
    await waitForTask(swapTask.taskUid);
    // swap 后 tmp 名下是旧数据（或首次跑时的空占位），删掉腾地方
    const delTask = await meiliRequest('DELETE', `/indexes/${tmp}`);
    await waitForTask(delTask.taskUid).catch(() => {});
    console.log(`✅ [${indexUid}] 已 swap 生效，旧索引已删`);
    return true;
}

async function swapOrDiscard(indexUid, selfTestFn) {
    const tmp = tmpIndexUid(indexUid);
    const { ok, failures } = await verifyTmp(indexUid, selfTestFn);
    if (!ok) return await discardTmp(indexUid, tmp, failures);
    return await swapTmp(indexUid);
}

const iterAllRoots = (typeDir) => iterAllRootsIn(ROOTS, typeDir);


/**
 * 按前端真实查询形态验证一个索引（swap 前测 tmp，测过才让它上位）—— 2026-09-21
 * 事故后定的判法，2026-09-27（A4）从「重建完事后全局补测」改成「每个索引建完
 * 就近测，作为 swap 前的准入闸」，判法本身不变。
 *
 * 事故：2026-09-07 works 被删并重建，但收尾的 configureSettings 没跑到，
 * settings 永久缺失、退回 Meili 默认，而前端每条搜索都带 `filter=is_draft = false`，
 * 于是 works 一律 400，用户搜「史记」看不到任何**作品**，只有书籍/丛编/人物。
 * 持续 13 天无人发现——脚本本身报「成功」，/health 绿，文档数满格，裸查询
 * （不带 filter）照样 200 有结果，只有**照抄前端形态的查询**才暴露得出来。
 *
 * checkHits=false 用于 juans：前端查整理本正文走 work_id 过滤，形态与其余
 * 四类（is_draft 过滤）不同，硬套会全部判假失败。
 */
async function checkIndexHealth(testUid, settingsKey, { checkHits = true } = {}) {
    const failures = [];
    const want = SETTINGS[settingsKey];
    if (!want) return { ok: true, failures };

    let settings;
    try {
        settings = await meiliRequest('GET', `/indexes/${testUid}/settings`);
    } catch (e) {
        return { ok: false, failures: [`读 settings 失败 — ${e.message}`] };
    }
    const gotFilterable = settings.filterableAttributes ?? [];
    const missingFilter = (want.filterableAttributes ?? []).filter(a => !gotFilterable.includes(a));
    if (missingFilter.length) {
        failures.push(`filterableAttributes 缺 [${missingFilter.join(', ')}]（实得 [${gotFilterable.join(', ')}]）`);
    }
    const gotSearchable = settings.searchableAttributes ?? [];
    if (gotSearchable.length === 1 && gotSearchable[0] === '*') {
        failures.push(`searchableAttributes 仍是默认 ['*']，settings 未生效`);
    }

    if (checkHits) {
        // 前端那条查询能不能真跑通——比对着 settings 逐条核对更可信：
        // settings 对不对是间接证据，查询通不通才是用户实际遇到的。
        try {
            const r = await meiliRequest(
                'GET',
                `/indexes/${testUid}/search?q=&limit=1&filter=${encodeURIComponent('is_draft = false')}`,
            );
            if (typeof r.estimatedTotalHits === 'number' && r.estimatedTotalHits === 0) {
                failures.push(`带 is_draft 过滤查到 0 条 —— 该类内容对用户恒为空`);
            }
        } catch (e) {
            failures.push(`前端形态查询失败 — ${e.message}（前端每条搜索都带此 filter，该索引对用户恒为空）`);
        }
    }

    // works 新增的筛选字段（overview#291 P1a）：带它们的过滤要能跑通。0 条命中没关系（可能数据里就没有），
    // 报 400 才是问题——说明 filterableAttributes 没生效，搜索页的部类／存佚筛选会整个报错。
    if (settingsKey === 'works') {
        try {
            await meiliRequest(
                'GET',
                `/indexes/${testUid}/search?q=&limit=1&filter=${encodeURIComponent('is_draft = false AND classification IN ["史部"] AND loss_status IN ["extant"]')}`,
            );
        } catch (e) {
            failures.push(`带 classification／loss_status 的过滤失败 — ${e.message}（搜索页 v4 的部类、存佚筛选会报错）`);
        }

        // 部类覆盖闸（overview#345）：过滤能跑通不等于字段有值——四部各查一次，任何一部 0 条就是没读到部类
        try {
            const hitsByBu = {};
            for (const bu of FOUR_BU) {
                const r = await meiliRequest(
                    'GET',
                    `/indexes/${testUid}/search?q=&limit=1&filter=${encodeURIComponent(`is_draft = false AND classification = "${bu}"`)}`,
                );
                hitsByBu[bu] = r.estimatedTotalHits;
            }
            const problem = classificationCoverageProblem(hitsByBu);
            if (problem) failures.push(problem);
            const ratioOf = async (uid) => {
                const q = async (flt) => (await meiliRequest('GET', `/indexes/${uid}/search?q=&limit=1&filter=${encodeURIComponent(flt)}`)).estimatedTotalHits;
                const total = await q('is_draft = false');
                const withBu = await q(`is_draft = false AND classification IN [${FOUR_BU.map((b) => `"${b}"`).join(', ')}]`);
                return total > 0 ? withBu / total : NaN;
            };
            let liveRatio = null;
            try { const r = await ratioOf('works'); liveRatio = Number.isFinite(r) ? r : null; } catch { /* 无基线 */ }
            const ratioProblem = classificationRatioProblem(liveRatio, await ratioOf(testUid));
            if (ratioProblem) failures.push(ratioProblem);
        } catch (e) {
            failures.push(`部类覆盖检查失败 — ${e.message}`);
        }
    }

    return { ok: failures.length === 0, failures };
}

    return { meiliRequest, waitForTask, pushBatch, configureSettings, tmpIndexUid, indexExists, ensureIndexExists, createFreshTmpIndex, docCount, swapOrDiscard, verifyTmp, swapTmp, discardTmp, checkIndexHealth };
}
