/**
 * 文档构建（纯函数）——从 full-reindex.mjs 抽出（overview#561 一期）。
 * runner（render-docs.mjs）与旧的全量脚本共用同一份，保证两条路径出的文档逐字段一致。
 * 约束：不读环境变量、不连 Meili、不碰全局状态；目录一律由参数传入。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { insideRoot } from './shards.mjs';
import * as crypto from 'node:crypto';
import * as OpenCC from 'opencc-js';
import { createToSimplified } from './to-simplified-core.mjs';
import { pinyin as toPinyin } from 'pinyin-pro';
import { classificationL1, derivedClassification, editionCount, hasTextValue, lossStatusValue } from './work-fields.mjs';
import { eraRank, sortTitle } from './sort-fields.mjs';
import { CHAR_FILE_RE, charJsonText, charJsonSnippetText } from './char-text.mjs';
import { readDetailDoc } from './derived-core.mjs';

const t2s = createToSimplified({
    createConverter: () => OpenCC.Converter({ from: 't', to: 'cn' }),
    variants: JSON.parse(readFileSync(new URL('./variant-chars.json', import.meta.url), 'utf-8')),
});

const MD_RE = /[#*`\[\]>]+|^---.*?$/gm;

// 简介进 searchableAttributes 的字符上限（A4，2026-09-27）：O1 的
// full-reindex-allfields.mjs 把详情所有字符串叶子拼成 detail_search 全量索引，
// 内存/盘涨幅偏大；这里只取 description 前 N 字，是"精简版"的口径。
const DESC_SEARCH_MAX_CHARS = 1000;

function mergeSimp(text) {
    if (!text) return '';
    const s = t2s(text);
    return s === text ? text : `${text} ${s}`;
}

function allPinyin(text) {
    if (!text) return '';
    const words = toPinyin(text, { toneType: 'none' });           // "shi ji"
    const compact = words.replace(/\s+/g, '');                     // "shiji"
    const initials = toPinyin(text, { pattern: 'first', toneType: 'none' }).replace(/\s+/g, '');  // "sj"
    return `${words} ${compact} ${initials}`;
}

function titlesToStrings(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(t => {
        if (typeof t === 'string' && t) return [t];
        if (t && typeof t === 'object' && t.book_title) return [t.book_title];
        return [];
    });
}

// ─── doc builders ───

function buildWorkDoc(entry, detail, isDraft = true) {
    const desc = detail.description ?? {};
    const descText = typeof desc === 'string' ? desc : (desc.text || '');
    const indexedBy = Array.isArray(detail.indexed_by) ? detail.indexed_by : [];
    const summaries = indexedBy
        .filter(ib => ib && typeof ib === 'object' && ib.summary)
        .map(ib => ib.summary)
        .join('\n\n');
    const title = entry.title || '';
    const author = entry.author || '';
    const aliases = [
        ...titlesToStrings(detail.additional_titles),
        ...titlesToStrings(detail.attached_texts),
    ];

    let completeness = 0;
    if (entry.has_collated) completeness += 5;
    if (entry.has_text) completeness += 3;
    if (entry.has_image) completeness += 2;
    if (entry.subtype === 'book' || entry.subtype === 'classic') completeness += 2;
    completeness += Math.min(editionCount(detail), 10);

    return {
        id: entry.id,
        type: 'work',
        is_draft: isDraft,
        title,
        author,
        dynasty: entry.dynasty || '',
        role: entry.role || '',
        subtype: entry.subtype || '',
        // 搜索页 v4 的筛选（overview#291 P1a）：部（一级分类，没有的空串）与存佚
        classification: classificationL1(derivedClassification(detail), entry.classification),
        loss_status: lossStatusValue(detail.loss_status, entry.loss_status),
        has_collated: !!entry.has_collated,
        has_text: hasTextValue(entry),   // 有转录全文或整理本（「有文本」筛选，overview#322）
        has_image: !!entry.has_image,
        juan_count: entry.juan_count || 0,
        completeness,
        title_chars: Array.from(title).length,
        era_rank: eraRank(entry.dynasty),
        title_sort: allPinyin(sortTitle(title)),
        title_search: mergeSimp(title),
        author_search: mergeSimp(author),
        aliases_search: aliases.map(mergeSimp).join(' '),
        description_search: mergeSimp(descText.slice(0, DESC_SEARCH_MAX_CHARS)),
        indexed_by_search: mergeSimp(summaries),
        pinyin: `${allPinyin(title)} ${allPinyin(author)}`,
    };
}

// detail 可为 null（读不到 / 解析失败时的退路）：此时只用 shard 里已denormalize 的字段，
// description/aliases 留空，不影响其余字段——与 works 一侧「detailPath 不存在就 continue」
// 不同，books 这条不想因为一个 detail 缺失就整条丢弃（shard 里的 title/author 等仍可搜）。
function buildBookDoc(entry, detail, isDraft = true) {
    const desc = detail?.description ?? {};
    const descText = typeof desc === 'string' ? desc : (desc.text || '');
    const aliases = [
        ...titlesToStrings(detail?.additional_titles),
        ...titlesToStrings(detail?.attached_texts),
    ];
    const title = entry.title || '';
    const author = entry.author || '';
    const edition = entry.edition || '';
    const holder = entry.holder || '';
    return {
        id: entry.id,
        type: 'book',
        is_draft: isDraft,
        title, author, edition, holder,
        dynasty: entry.dynasty || '',          // 撰人朝代
        era: entry.era || '',                  // 刊刻朝代（2026-09 投影自 Book.dating，与 dynasty 不是一回事）
        sort_year: entry.sort_year ?? null,
        has_text: hasTextValue(entry),
        has_image: !!entry.has_image,
        completeness: (entry.has_text ? 3 : 0) + (entry.has_image ? 2 : 0),
        title_chars: Array.from(title).length,
        era_rank: eraRank(entry.era || entry.dynasty),
        title_sort: allPinyin(sortTitle(title)),
        title_search: mergeSimp(title),
        author_search: mergeSimp(author),
        aliases_search: aliases.map(mergeSimp).join(' '),
        edition_search: mergeSimp(edition),
        holder_search: mergeSimp(holder),
        description_search: mergeSimp(descText.slice(0, DESC_SEARCH_MAX_CHARS)),
        pinyin: `${allPinyin(title)} ${allPinyin(author)}`,
    };
}

function buildCollectionDoc(entry, isDraft = true) {
    const title = entry.title || entry.name || '';
    return {
        id: entry.id,
        type: 'collection',
        is_draft: isDraft,
        title,
        completeness: 5,
        title_chars: Array.from(title).length,
        title_search: mergeSimp(title),
        pinyin: allPinyin(title),
    };
}

function yearOf(v) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
}

function buildEntityDoc(entry, isDraft = true) {
    const name = entry.primary_name || entry.title || '';
    return {
        id: entry.id,
        type: 'entity',
        is_draft: isDraft,
        subtype: entry.subtype || 'people',
        primary_name: name,
        dynasty: entry.dynasty || '',
        // schema-v2：生卒年的真源是 dates.birth／dates.death（源记录本体的 birth_year／death_year 已删，不再兼容旧写法）
        birth_year: yearOf(entry.dates?.birth),
        death_year: yearOf(entry.dates?.death),
        cbdb_id: entry.cbdb_id ?? null,
        completeness: entry.cbdb_id ? 1 : 0,
        title_chars: Array.from(name).length,
        era_rank: eraRank(entry.dynasty),
        title_sort: allPinyin(sortTitle(name)),
        name_search: mergeSimp(name),
        pinyin: allPinyin(name),
    };
}

/** snippetSrc：摘要用的文本，缺省同 clean（自校文本传带〔图〕的那份，GUJI-742）。 */
function juanDoc(workId, juanName, clean, snippetSrc = clean) {
    const juanHash = crypto.createHash('md5').update(juanName, 'utf-8').digest('hex').slice(0, 12);
    return {
        id: `${workId}_${juanHash}`,
        type: 'juan',
        work_id: workId,
        juan_name: juanName,
        snippet: snippetSrc.slice(0, 200),
        content_search: mergeSimp(clean.slice(0, 5000)),
    };
}

/**
 * 一部整理本的各章正文 → juans 文档。
 *
 * 正文在 book-text：`{TEXT_DIR}/Work/c1/c2/c3/{id}/`，只认新结构（overview#307）：
 * `manifest.json` 里 kind=collated 的公开版本（主版本 default 或别的 key），章目录 `<key>/index.json` 的 chapters
 * （`file` 不带扩展名，如 `001`）。每章优先读 `<key>/NNN.md`；没有 md 时退到 `<key>/NNN.json`（has_json），
 * 拼各节 title + content。两种来源都没有就跳过这一章。
 */
const TEXT_KEY_RE = /^[a-z][a-z0-9-]*$/;
/**
 * 条目详情：schema-v2 的 build 产物优先；生产库缺产物抛错并计 missing、草稿库读源档（规则见 derived-core.mjs readDetailDoc）。
 * opts：{ isDraft, stats }。读不了抛错，由调用方按原样处理。
 */
function readDetail(detailPath, id, derivedDir = '', opts = {}) {
    return readDetailDoc(detailPath, id, derivedDir, opts);
}

function readJsonSafe(path) {
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}
/**
 * @param textDir book-text 根目录
 * @param workEntry 条目（Work 或 Book）：用 id、path 找 book-text 目录
 * @param opts.workId 写进 juans 文档 work_id 的值，缺省＝条目 id（Book 传它所属的 work_id）
 * @param opts.kinds 收哪些版本类型；Work 默认 ['collated']，Book 传 ['self_collated']（overview#525）
 */
function buildJuanDocs(textDir, workEntry, { workId = workEntry.id, kinds = ['collated'] } = {}) {
    if (!textDir) return [];
    const relPath = workEntry.path || '';
    if (!relPath) return [];
    const itemDir = resolve(textDir, dirname(relPath), workEntry.id);
    if (!insideRoot(textDir, itemDir)) return [];
    const manifest = readJsonSafe(join(itemDir, 'manifest.json'));
    if (!manifest || manifest.visibility === 'internal' || !Array.isArray(manifest.versions)) return [];
    const docs = [];
    let badChapters = 0;
    for (const v of manifest.versions) {
        if (!kinds.includes(v?.kind) || v.visibility === 'internal' || typeof v.key !== 'string' || !TEXT_KEY_RE.test(v.key)) continue;
        const keyDir = join(itemDir, v.key);
        const chapters = readJsonSafe(join(keyDir, 'index.json'))?.chapters;
        if (!Array.isArray(chapters)) continue;
        for (const c of chapters) {
            // 严格按索引给的文件名读：file 就是不带扩展名的章号（如 001），读 <file>.md／<file>.json，不再剥扩展名。
            // 2026-10-10 全量核对 book-text（HEAD，16 万余章）：无一章带扩展名，故无需容忍；不合规的章计数告警，不静默跳过。
            const stem = typeof c?.file === 'string' ? c.file : '';
            if (!stem || !/^[0-9A-Za-z_-]+$/.test(stem)) { badChapters++; continue; }
            const name = c.title || stem;
            let clean = '';
            if (v.kind === 'self_collated') {
                // 自校文本（original）main 上只有 char.json 真源，没有 md／json：取原字拼章正文（不套 norm）
                const cf = typeof c?.char_file === 'string' ? c.char_file : '';
                // 检索文本跳过图片格／图列；摘要在原处放〔图〕（GUJI-742）
                let snip = '';
                if (CHAR_FILE_RE.test(cf)) {
                    const raw = readJsonSafe(join(keyDir, cf));
                    clean = charJsonText(raw).replace(/\s+/g, ' ').trim();
                    snip = charJsonSnippetText(raw).replace(/\s+/g, ' ').trim();
                }
                if (!clean) continue;
                docs.push(juanDoc(workId, name, clean, snip || clean));
                continue;
            }
            try {
                const mdPath = join(keyDir, `${stem}.md`);
                if (existsSync(mdPath)) clean = readFileSync(mdPath, 'utf-8').replace(MD_RE, ' ').replace(/\s+/g, ' ').trim();
            } catch { clean = ''; }
            if (!clean && c.has_json) {
                const secs = readJsonSafe(join(keyDir, `${stem}.json`))?.sections;
                if (Array.isArray(secs)) {
                    clean = secs.map(sec => [sec?.title, sec?.content].filter(Boolean).join(' ')).join(' ').replace(/\s+/g, ' ').trim();
                }
            }
            if (!clean) continue;
            docs.push(juanDoc(workId, name, clean));
        }
    }
    if (badChapters) console.warn(`⚠️  juans: ${workId} 有 ${badChapters} 章的 file 不合规（须为不带扩展名的章号，如 001），已跳过`);
    return docs;
}

/** 版本数覆盖统计（非草稿 works）：交给 manifest，由 ingest 端做 editionCoverageProblem 闸。累加进 stats。 */
function addEditionStats(stats, detail, isDraft) {
    if (isDraft) return;
    stats.total++;
    if (typeof detail?._edition_count === 'number') { stats.present++; if (detail._edition_count > 0) stats.positive++; }
}

export { buildWorkDoc, buildBookDoc, buildCollectionDoc, buildEntityDoc, buildJuanDocs, juanDoc, readDetail, readJsonSafe, addEditionStats };
