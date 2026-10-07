/**
 * data-contract.mjs — 数据包的格式契约（字段表＋纯函数校验器）。
 *
 * 背景：overview#470 P0。数据上线（以后不再经测试站 verify 全套）要靠「上传前在数据包上检查」，
 * 检查分三类：格式契约（本文件）、数量不突降、私有文本等（见 ops/data-package-check.mjs）。
 *
 * 判定分三级（severity）：
 *   block  必有字段缺失（id／type／名字）、出现未知 type、id 与文件名不符、对不上的不变量——强制模式下会阻断上传
 *   warn   字段表里有的字段类型不对（entry.field-type）、建议字段缺失（如 Book 没有 work_id）、非 `_` 的未知字段（可能是新格式）、
 *          索引登记了但没有对应文本目录（P0 先 warn，按实测再定要不要升 block）
 *   info   `_` 起首的未知字段（派生字段，加法兼容）、统计信息
 * 本文件只出 finding，不决定阻不阻断；P0 阶段 data-package-check 只报告（见 overview#470 的验收评论）。
 *
 * 字段表只收**已核实的**字段与类型（取自 2026-10-07 线上旧格式条目 8 个、book-index schema-v2 的
 * build/contract-sample/ 22 个条目；测试夹具在 ops/tests/fixtures/data-contract/）。不在表里的字段不判类型，只记「未知字段」。
 * 旧格式（线上现在的）与 schema-v2 的新格式都必须通过：新格式多出的是 `_` 起首的派生字段，加法兼容。
 *
 * 纯函数、无 IO，便于单测。
 */

export const ENTRY_TYPES = ['work', 'book', 'collection', 'entity'];

/**
 * 已核实的条目字段 → 期望的 JS 类型（'array' 与 'object' 区分数组与对象；'any'＝字段已知但类型不固定，不判类型）。
 * 来源：线上旧格式 2026-10-07 全量打包（book-index main `0b0a5348f76f`，147,007 个条目）里出现过的全部 108 个字段
 * （其中 `null` 视为「没填」，不判类型），加上 book-index schema-v2 的 build/contract-sample/ 里多出来的 `_` 起首派生字段。
 * 字段表之外的字段只记「未知字段」（新字段清单），不判类型。
 */
export const ENTRY_FIELD_TYPES = Object.freeze({
    // 源字段与旧格式汇总字段
    additional_titles: 'array', additional_works: 'array', ai_note: 'string', ai_note2: 'string',
    ai_note_fix: 'string', ai_note_periodfix: 'string', aliases: 'array', alt_names: 'array', appendix: 'array',
    attached_texts: 'array', authenticity: 'string', authenticity_basis: 'string', authors: 'array',
    base_edition: 'array', birth_year: 'number', books: 'array', classification: 'object',
    collection_scale: 'object', collections: 'array', contained_in: 'array', contained_works: 'array',
    contains: 'array', count: 'object', current_location: 'object', dates: 'object', dating: 'object',
    death_year: 'number', description: 'object', dynasty: 'string', dynasty_basis: 'string', edition: 'string',
    edition_type: 'string', editors: 'array', emendated_by: 'array', external_ids: 'object', has_collated: 'boolean',
    has_digitalization: 'boolean', has_full_text: 'boolean', has_image: 'boolean', has_text: 'boolean',
    holder: 'string', id: 'string', indexed_by: 'array', juan_count: 'object', lineage: 'object',
    location_history: 'array', loss_status: 'string', loss_status_basis: 'string', loss_status_note: 'string',
    measure_info: 'string', measures: 'array', merge_history: 'array', merged_from: 'any', merged_in: 'array',
    merged_into: 'string', metadata: 'object', name_basis: 'string', native_place: 'string',
    native_place_basis: 'string', original_title: 'string', page_count: 'object', period: 'string',
    period_basis: 'string', period_upper: 'string', period_upper_basis: 'string', physical_description: 'object',
    primary_name: 'string', provenance: 'array', publication_info: 'object', publish_year: 'string',
    publisher: 'string', related_books: 'array', related_collections: 'array', related_works: 'array',
    resource_groups: 'object', resources: 'array', retired: 'boolean', retired_reason: 'string',
    revised_at: 'string', revision: 'string', schema_version: 'number', section: 'string', sections: 'array',
    sources: 'array', subtype: 'string', text_count: 'number', text_kinds: 'array', title: 'string',
    title_basis: 'string', title_emendation: 'object', title_or_office: 'string', total_volumes: 'number',
    total_works: 'number', type: 'string', updated_at: 'string', version_graph: 'object', volume_count: 'object',
    work_id: 'string', works: 'array', zhsy_id: 'string',
    // `_` 起首：打包时加的标志，以及 schema-v2 的派生字段（加法兼容）
    _authors: 'array', _books: 'array', _catalogs: 'array', _classifications: 'array', _collections: 'array',
    _edition_count: 'number', _has_collated: 'boolean', _has_image: 'boolean', _has_text: 'boolean',
    _isDraft: 'boolean', _lineage_graph_ref: 'string', _member_count: 'number', _member_pages: 'number',
    _member_type: 'string', _members: 'array', _path: 'string', _related: 'array', _siblings: 'array',
    _work: 'object',
    _works: 'array',
    _siblings_more: 'boolean',
    _siblings_total: 'number',
    _lineage_refs: 'object',
    _derived_by: 'array',
    _member_catalog: 'object',
    _related_pages: 'number',
    _related_total: 'number',
    _children: 'array',
});

const NAME_FIELD = { work: 'title', book: 'title', collection: 'title', entity: 'primary_name' };

export function jsType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

const finding = (severity, code, message, extra = {}) => ({ severity, code, message, ...extra });

/**
 * 校验一个条目文件。
 * @param {unknown} doc  解析后的 JSON
 * @param {string} file  文件名（如 "d59f20aowb9c.json"），用来核对 id
 * @returns {{ findings: object[], unknownFields: string[], type: string|null }}
 */
export function checkEntryDoc(doc, file) {
    const findings = [];
    const unknownFields = [];
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
        return { findings: [finding('block', 'entry.not-object', `${file}：不是 JSON 对象`, { file })], unknownFields, type: null };
    }
    const id = doc.id;
    if (typeof id !== 'string' || id === '') findings.push(finding('block', 'entry.id-missing', `${file}：缺 id（或不是字符串）`, { file }));
    else if (`${id}.json` !== file) findings.push(finding('block', 'entry.id-filename', `${file}：id「${id}」与文件名不一致`, { file }));

    const type = typeof doc.type === 'string' ? doc.type : null;
    if (type === null) findings.push(finding('block', 'entry.type-missing', `${file}：缺 type（或不是字符串）`, { file }));
    else if (!ENTRY_TYPES.includes(type)) findings.push(finding('block', 'entry.type-unknown', `${file}：未知 type「${type}」`, { file, value: type }));

    if (type && ENTRY_TYPES.includes(type)) {
        const nameField = NAME_FIELD[type];
        const name = doc[nameField];
        if (typeof name !== 'string' || name.trim() === '') {
            findings.push(finding('block', 'entry.name-missing', `${file}：${type} 缺 ${nameField}`, { file }));
        }
        if (type === 'book' && typeof doc.work_id !== 'string') {
            findings.push(finding('warn', 'entry.book-work_id', `${file}：book 没有 work_id`, { file }));
        }
    }

    for (const [key, val] of Object.entries(doc)) {
        const want = ENTRY_FIELD_TYPES[key];
        if (want === undefined) { unknownFields.push(key); continue; }
        if (val === null || want === 'any') continue; // null＝没填；'any'＝类型不固定
        const got = jsType(val);
        if (got !== want) {
            findings.push(finding('warn', 'entry.field-type', `${file}：字段 ${key} 应为 ${want}，实际 ${got}`, { file, field: key, want, got }));
        }
    }
    return { findings, unknownFields, type };
}

// ─── meta.json／version.json／latest.json ───

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

/** meta.json：四个计数、resourceCounts、subtypeStats。 */
export function checkMeta(meta) {
    const findings = [];
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
        return [finding('block', 'meta.not-object', 'meta.json 不是对象')];
    }
    for (const k of ['works', 'books', 'collections', 'entities']) {
        if (!Number.isInteger(meta[k]) || meta[k] < 0) findings.push(finding('block', 'meta.count', `meta.${k} 缺失或不是非负整数：${JSON.stringify(meta[k])}`, { field: k }));
    }
    const rc = meta.resourceCounts;
    if (rc === null || typeof rc !== 'object') findings.push(finding('block', 'meta.resourceCounts', 'meta.resourceCounts 缺失'));
    else for (const k of ['hasText', 'hasImage']) {
        if (!Number.isInteger(rc[k]) || rc[k] < 0) findings.push(finding('block', 'meta.resourceCounts', `meta.resourceCounts.${k} 缺失或不是非负整数`, { field: k }));
    }
    const st = meta.subtypeStats;
    if (st === null || typeof st !== 'object') findings.push(finding('block', 'meta.subtypeStats', 'meta.subtypeStats 缺失'));
    else {
        for (const [k, v] of Object.entries(st)) {
            if (!Number.isInteger(v) || v < 0) findings.push(finding('block', 'meta.subtypeStats', `meta.subtypeStats.${k} 不是非负整数`, { field: k }));
        }
        // e2e/contract/data-pipeline.spec.ts：各项之和必须等于 works（未标注 subtype 的 Work 记入 book）
        const sum = Object.values(st).reduce((n, v) => n + (Number.isInteger(v) ? v : 0), 0);
        if (Number.isInteger(meta.works) && sum !== meta.works) {
            findings.push(finding('block', 'meta.subtype-sum', `subtypeStats 各项之和 ${sum} ≠ works ${meta.works}`));
        }
    }
    return findings;
}

/** version.json：data/ 下，commitId 等是完整 40 位。 */
export function checkVersion(v) {
    const findings = [];
    if (v === null || typeof v !== 'object') return [finding('block', 'version.not-object', 'version.json 不是对象')];
    for (const k of ['commitId', 'productionCommitId', 'textCommitId']) {
        if (typeof v[k] !== 'string' || !HEX(40).test(v[k])) findings.push(finding('block', 'version.commit', `version.${k} 不是 40 位十六进制：${JSON.stringify(v[k])}`, { field: k }));
    }
    if (typeof v.bundleDate !== 'string' || Number.isNaN(Date.parse(v.bundleDate))) findings.push(finding('block', 'version.bundleDate', 'version.bundleDate 缺失或不是时间'));
    return findings;
}

/**
 * latest.json（发布指针，bundle 时输出到数据根，sync-to-cos 再补 cacheKey）：
 * commitId 12 位、其余 commit 40 位（e2e/contract/data-pipeline.spec.ts 的口径）。dataFormat 可选，只报告。
 */
export function checkLatest(l, { requireCacheKey = false } = {}) {
    const findings = [];
    if (l === null || typeof l !== 'object') return [finding('block', 'latest.not-object', 'latest.json 不是对象')];
    if (typeof l.commitId !== 'string' || !HEX(12).test(l.commitId)) findings.push(finding('block', 'latest.commitId', `latest.commitId 应为 12 位十六进制：${JSON.stringify(l.commitId)}`, { field: 'commitId' }));
    for (const k of ['fullCommitId', 'productionCommitId', 'textCommitId']) {
        if (typeof l[k] !== 'string' || !HEX(40).test(l[k])) findings.push(finding('block', 'latest.commit', `latest.${k} 应为 40 位十六进制：${JSON.stringify(l[k])}`, { field: k }));
    }
    if (typeof l.bundleDate !== 'string' || Number.isNaN(Date.parse(l.bundleDate))) findings.push(finding('block', 'latest.bundleDate', 'latest.bundleDate 缺失或不是时间'));
    if (requireCacheKey && (typeof l.cacheKey !== 'string' || !HEX(16).test(l.cacheKey))) findings.push(finding('block', 'latest.cacheKey', 'latest.cacheKey 应为 16 位十六进制'));
    if (l.dataFormat !== undefined && !Number.isInteger(l.dataFormat)) findings.push(finding('block', 'latest.dataFormat', 'latest.dataFormat 若有应为整数'));
    return findings;
}

// ─── 分类树（read/tree.json、catalog/tree.json）、文本索引分片、阅读清单 ───

/**
 * 树：数组，每个节点 { id: string, label: string, count: 非负整数, children?: 节点[] }。
 * @returns {{ findings: object[], topCount: number, nodes: number, countSum: number }}
 */
export function checkTree(tree, label) {
    const findings = [];
    let nodes = 0;
    let countSum = 0;
    if (!Array.isArray(tree)) {
        return { findings: [finding('block', 'tree.not-array', `${label} 不是数组`)], topCount: 0, nodes: 0, countSum: 0 };
    }
    if (tree.length === 0) findings.push(finding('block', 'tree.empty', `${label} 是空的`));
    const walk = (list, path, top) => {
        for (const n of list) {
            nodes++;
            const where = `${label}${path}`;
            if (n === null || typeof n !== 'object') { findings.push(finding('block', 'tree.node', `${where}：节点不是对象`)); continue; }
            if (typeof n.id !== 'string' || n.id === '') findings.push(finding('block', 'tree.node-id', `${where}：节点缺 id`));
            if (typeof n.label !== 'string' || n.label === '') findings.push(finding('block', 'tree.node-label', `${where}：节点（${n.id}）缺 label`));
            if (!Number.isInteger(n.count) || n.count < 0) findings.push(finding('block', 'tree.node-count', `${where}：节点（${n.id}）count 不是非负整数`));
            else if (top) countSum += n.count;
            if (n.children !== undefined) {
                if (!Array.isArray(n.children)) findings.push(finding('block', 'tree.children', `${where}：节点（${n.id}）children 不是数组`));
                else walk(n.children, `/${n.label ?? n.id}`, false);
            }
        }
    };
    walk(tree, '', true);
    return { findings, topCount: tree.length, nodes, countSum };
}

/** index/texts/<0-f>.json：{ <owner id>: [ { key, kind, label, ... } ] }。 */
export function checkTextIndexShard(shard, name) {
    const findings = [];
    let owners = 0;
    let versions = 0;
    if (shard === null || typeof shard !== 'object' || Array.isArray(shard)) {
        return { findings: [finding('block', 'texts-index.not-object', `index/texts/${name} 不是对象`)], owners, versions };
    }
    for (const [id, list] of Object.entries(shard)) {
        owners++;
        if (!Array.isArray(list) || list.length === 0) { findings.push(finding('block', 'texts-index.versions', `index/texts/${name}：${id} 的版本列表为空或不是数组`)); continue; }
        for (const v of list) {
            versions++;
            if (v === null || typeof v !== 'object' || typeof v.key !== 'string' || v.key === '') findings.push(finding('block', 'texts-index.version', `index/texts/${name}：${id} 有版本缺 key`));
        }
    }
    return { findings, owners, versions };
}

/** items/<id>/manifest.json：{ id, versions: [ { key, ... } ] }；id 必须等于目录名。 */
export function checkTextManifest(m, dirName) {
    const findings = [];
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return [finding('block', 'manifest.not-object', `items/${dirName}/manifest.json 不是对象`)];
    if (m.id !== dirName) findings.push(finding('block', 'manifest.id', `items/${dirName}/manifest.json：id「${m.id}」与目录名不一致`));
    if (!Array.isArray(m.versions) || m.versions.length === 0) findings.push(finding('block', 'manifest.versions', `items/${dirName}/manifest.json：versions 为空或不是数组`));
    else for (const v of m.versions) {
        if (v === null || typeof v !== 'object' || typeof v.key !== 'string' || v.key === '') { findings.push(finding('block', 'manifest.version-key', `items/${dirName}/manifest.json：有版本缺 key`)); break; }
        if (v.chapters_total !== undefined && !(Number.isInteger(v.chapters_total) && v.chapters_total >= 0)) { findings.push(finding('warn', 'manifest.chapters_total', `items/${dirName}/manifest.json：chapters_total 不是非负整数`)); break; }
    }
    return findings;
}

/** meta-home/sections.json：counts 必须与 meta.json 一致。 */
export function checkMetaHome(sections, meta) {
    if (sections === null || typeof sections !== 'object') return [finding('block', 'meta-home.not-object', 'meta-home/sections.json 不是对象')];
    const findings = [];
    const c = sections.counts;
    if (c === null || typeof c !== 'object') return [finding('block', 'meta-home.counts', 'meta-home/sections.json 缺 counts')];
    for (const k of ['works', 'books', 'collections', 'entities']) {
        if (meta && Number.isInteger(meta[k]) && c[k] !== meta[k]) findings.push(finding('block', 'meta-home.counts-mismatch', `meta-home counts.${k}=${c[k]} 与 meta.${k}=${meta[k]} 不一致`, { field: k }));
    }
    return findings;
}
