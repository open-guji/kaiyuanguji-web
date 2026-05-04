#!/usr/bin/env node
/**
 * 搜索质量回归测试套件
 *
 * 直接打 Meili 公开搜索 API，验证排序是否符合预期。覆盖：
 *   A. 完整标题匹配（繁简等价）
 *   B. 拼音（全拼 + 缩写）
 *   C. 部分匹配（前缀 / 子串）
 *   D. 作者名（繁简 + 字号 vs 本名）
 *   E. description / indexed_by 全文
 *   F. books / entities 索引
 *
 * 断言形式：
 *   - firstId / firstTitle / firstTitleContains  — 第 1 名
 *   - topNHasId / topNHasTitleContains           — 前 N 名包含
 *
 * 用法：
 *   node scripts/test-search-quality.mjs              # 默认连生产 https://api.kaiyuanguji.com
 *   node scripts/test-search-quality.mjs --url=...    # 切目标
 *   node scripts/test-search-quality.mjs -v           # verbose（打印每条 case 的前 N 名）
 *   node scripts/test-search-quality.mjs --tag=拼音    # 只跑某 tag
 */

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k, def) => {
    const a = args.find(x => x.startsWith(`${k}=`));
    return a ? a.split('=').slice(1).join('=') : def;
};

const BASE_URL = opt('--url', 'https://api.kaiyuanguji.com').replace(/\/$/, '');
const API_KEY = opt('--key', '1b0b438f7eadd34e1a6b53c76d63bd3614822d3ec9856251c9340a78456c5465');
const VERBOSE = flag('-v') || flag('--verbose');
const FILTER_TAG = opt('--tag', null);
// strict 模式 known issue 也算 fail；默认 known issue 显示但不参与 exit code
const STRICT = flag('--strict');

async function meiliSearch(index, q, limit = 5) {
    const params = new URLSearchParams({ q, limit: String(limit) });
    const r = await fetch(`${BASE_URL}/indexes/${index}/search?${params}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

// ─── 测试用例 ───
const cases = [
    // ─── A. 完整标题匹配（繁简等价 / 异体）───
    { tag: 'A.标题', q: '史记',     firstId: '1eujfe7s94veo', desc: '简体' },
    { tag: 'A.标题', q: '史記',     firstId: '1eujfe7s94veo', desc: '繁体' },
    { tag: 'A.标题', q: '汉书',     firstId: '1euidlec1g8ow', desc: '简体' },
    { tag: 'A.标题', q: '漢書',     firstId: '1euidlec1g8ow', desc: '繁体' },
    { tag: 'A.标题', q: '红楼梦',    firstId: '1evgoj8kp4irk', desc: '简体' },
    { tag: 'A.标题', q: '紅樓夢',    firstId: '1evgoj8kp4irk', desc: '繁体' },
    { tag: 'A.标题', q: '宋史',     firstId: '1ev3bab5e14ow' },
    { tag: 'A.标题', q: '论语',     firstId: '1ev7w0euvaeww', desc: '简体',
      knownIssue: '简繁归一后，"論語雜問"(c=0) 排在 "論語"(c=14) 之前；繁体直搜则正常' },
    { tag: 'A.标题', q: '論語',     firstId: '1ev7w0euvaeww' },
    { tag: 'A.标题', q: '孟子',     firstId: '1ev7xm3w3445c' },
    { tag: 'A.标题', q: '水浒传',    firstId: '1evgowbkc2qyo', desc: '简体' },
    { tag: 'A.标题', q: '水滸傳',    firstId: '1evgowbkc2qyo' },
    { tag: 'A.标题', q: '三国演义',  firstId: '1evglwzzi2ww0', desc: '简体' },
    { tag: 'A.标题', q: '三國演義',  firstId: '1evglwzzi2ww0' },
    { tag: 'A.标题', q: '韓非子',   firstId: '1evincino4a9s' },
    { tag: 'A.标题', q: '韩非子',   firstId: '1evincino4a9s', desc: '简体' },
    { tag: 'A.标题', q: '西游记',   firstId: '1evgoslsegs8w', desc: '简体' },
    { tag: 'A.标题', q: '西遊記',   firstId: '1evgoslsegs8w' },
    { tag: 'A.标题', q: '金瓶梅',   firstId: '1evgoj8abhgjk' },
    { tag: 'A.标题', q: '儒林外史',  firstId: '1evgoyqwyb8cg' },
    { tag: 'A.标题', q: '孙子兵法',  firstId: '1evcmnd8q9s74', desc: '简体' },
    { tag: 'A.标题', q: '孫子兵法',  firstId: '1evcmnd8q9s74' },
    { tag: 'A.标题', q: '文心雕龙',  firstId: '1ev3bezdr5mgw', desc: '简体' },
    { tag: 'A.标题', q: '文心雕龍',  firstId: '1ev3bezdr5mgw' },

    // ─── B. 拼音（全拼 / 带空格 / 缩写）───
    { tag: 'B.拼音', q: 'shiji',         top3HasId: '1eujfe7s94veo' },
    { tag: 'B.拼音', q: 'shi ji',        top3HasId: '1eujfe7s94veo', desc: '带空格' },
    { tag: 'B.拼音', q: 'hongloumeng',   top3HasId: '1evgoj8kp4irk' },
    { tag: 'B.拼音', q: 'lunyu',         top3HasId: '1ev7w0euvaeww' },
    { tag: 'B.拼音', q: 'mengzi',        top3HasId: '1ev7xm3w3445c' },
    { tag: 'B.拼音', q: 'songshi',       top3HasId: '1ev3bab5e14ow' },
    { tag: 'B.拼音', q: 'shuihuzhuan',   top5HasId: '1evgowbkc2qyo' },
    { tag: 'B.拼音', q: 'sgyy',          top3HasId: '1evglwzzi2ww0', desc: '缩写' },
    { tag: 'B.拼音', q: 'xiyouji',       top3HasId: '1evgoslsegs8w' },
    { tag: 'B.拼音', q: 'xyj',           top3HasId: '1evgoslsegs8w', desc: '缩写',
      knownIssue: '3 字缩写歧义：xyj 同时匹配 學易記/逍遙集/學易集/西遊記，无法靠 ranking 区分' },
    { tag: 'B.拼音', q: 'wxdl',          top3HasId: '1ev3bezdr5mgw', desc: '文心雕龍 缩写' },
    { tag: 'B.拼音', q: 'SHIJI',         top3HasId: '1eujfe7s94veo', desc: '大写' },
    { tag: 'B.拼音', q: 'SongShi',       top3HasId: '1ev3bab5e14ow', desc: '混合大小写' },

    // ─── C. 部分匹配（前缀 / 子串）───
    { tag: 'C.部分', q: '红楼',     top3HasId: '1evgoj8kp4irk',
      knownIssue: '前 3 是 紅樓圓夢/復夢/重夢(c=3 或 0)，紅樓夢(c=15) 没排进前 3；completeness 当 tiebreaker 在 prefix-match 场景未生效' },
    { tag: 'C.部分', q: '紅樓',     top3HasId: '1evgoj8kp4irk' },
    { tag: 'C.部分', q: '水浒',     top3HasId: '1evgowbkc2qyo' },
    { tag: 'C.部分', q: '三国',     top3HasId: '1evglwzzi2ww0' },
    { tag: 'C.部分', q: '西游',     top3HasId: '1evgoslsegs8w' },
    { tag: 'C.部分', q: '儒林',     top3HasId: '1evgoyqwyb8cg',
      knownIssue: '同「红楼」case：completeness 高的「儒林外史」未排在前 3，被 儒林宗派/公議/全傳 占据' },

    // ─── D. 作者名（繁简 / 字号 vs 本名）───
    // 放宽到前 10：title 字段权重高于 author，"司馬遷X" 类作品天然排在前面，
    // 但"史記"应能在前 10 看到。这是设计取舍，不是 bug。
    { tag: 'D.作者', q: '司马迁',   top10HasId: '1eujfe7s94veo', desc: '简体' },
    { tag: 'D.作者', q: '司馬遷',   top10HasId: '1eujfe7s94veo' },
    { tag: 'D.作者', q: '班固',     top10HasId: '1euidlec1g8ow',
      knownIssue: 'searchableAttributes 让 title 含「班固」的作品（班固集等）压过 author=班固 的漢書；搜作者名想找他作品的诉求当前优先级不够' },
    { tag: 'D.作者', q: '曹雪芹',   top5HasId: '1evgoj8kp4irk', desc: '字号 vs 本名「曹霑」' },
    { tag: 'D.作者', q: '曹霑',     top3HasId: '1evgoj8kp4irk', desc: '本名' },
    { tag: 'D.作者', q: '罗贯中',   top5HasId: '1evglwzzi2ww0', desc: '简体' },
    { tag: 'D.作者', q: '羅貫中',   top5HasId: '1evglwzzi2ww0' },
    { tag: 'D.作者', q: '韓非',     top3HasId: '1evincino4a9s' },
    { tag: 'D.作者', q: '吴承恩',   top10HasId: '1evgoslsegs8w', desc: '简体' },
    { tag: 'D.作者', q: '吳承恩',   top10HasId: '1evgoslsegs8w' },
    { tag: 'D.作者', q: '吴敬梓',   top10HasId: '1evgoyqwyb8cg', desc: '简体' },
    { tag: 'D.作者', q: '孙武',     top10HasId: '1evcmnd8q9s74', desc: '简体' },
    { tag: 'D.作者', q: '孫武',     top10HasId: '1evcmnd8q9s74' },

    // ─── E. description / indexed_by 全文 ───
    { tag: 'E.全文', q: '通俗小說',  top5HasTitleContains: '通俗', desc: '描述含此词的作品' },
    { tag: 'E.全文', q: '通俗小说',  top5HasTitleContains: '通俗', desc: '简体' },

    // ─── F. books 索引 ───
    { tag: 'F.books', index: 'books', q: '四庫全書', top3HasTitleContains: '四庫', desc: '丛书名' },
    { tag: 'F.books', index: 'books', q: '百衲本',   top5HasTitleContains: '百衲' },
    { tag: 'F.books', index: 'books', q: '宋刻本',   top5HasTitleContains: '宋' },

    // ─── G. entities 索引 ───
    { tag: 'G.人物', index: 'entities', q: '司马迁',  top3HasTitleContains: '司馬遷', desc: '简体' },
    { tag: 'G.人物', index: 'entities', q: '司馬遷',  top3HasTitleContains: '司馬遷' },
    { tag: 'G.人物', index: 'entities', q: '孔子',    top3HasTitleContains: '孔' },
    { tag: 'G.人物', index: 'entities', q: '王羲之',  top3HasTitleContains: '王羲之' },
];

// entities 索引文档没 title 字段，用 primary_name；UI 端 hitToEntry 也是这么 fallback 的
const titleOf = (h) => h?.title || h?.primary_name || '';

// ─── 断言 ───
function check(c, hits) {
    const failures = [];
    if (c.firstId && hits[0]?.id !== c.firstId) {
        failures.push(`firstId 期待 ${c.firstId}，实际 ${hits[0]?.id} (${titleOf(hits[0])})`);
    }
    if (c.firstTitle && titleOf(hits[0]) !== c.firstTitle) {
        failures.push(`firstTitle 期待 ${c.firstTitle}，实际 ${titleOf(hits[0])}`);
    }
    if (c.firstTitleContains && !titleOf(hits[0]).includes(c.firstTitleContains)) {
        failures.push(`firstTitleContains 期待含「${c.firstTitleContains}」，实际 ${titleOf(hits[0])}`);
    }
    for (const [n, key] of [[3, 'top3HasId'], [5, 'top5HasId'], [10, 'top10HasId']]) {
        if (c[key]) {
            const inTopN = hits.slice(0, n).some(h => h.id === c[key]);
            if (!inTopN) failures.push(`${key} 期待 id=${c[key]} 在前 ${n}，前 ${n} 实际：${hits.slice(0,n).map(h=>`${h.id}(${titleOf(h)})`).join(', ')}`);
        }
    }
    for (const [n, key] of [[3, 'top3HasTitleContains'], [5, 'top5HasTitleContains']]) {
        if (c[key]) {
            const inTopN = hits.slice(0, n).some(h => titleOf(h).includes(c[key]));
            if (!inTopN) failures.push(`${key} 期待含「${c[key]}」在前 ${n}，前 ${n} 实际：${hits.slice(0,n).map(titleOf).join(', ')}`);
        }
    }
    return failures;
}

// ─── 跑 ───
const filtered = FILTER_TAG ? cases.filter(c => c.tag.includes(FILTER_TAG)) : cases;
console.log(`目标: ${BASE_URL}`);
console.log(`用例: ${filtered.length}${FILTER_TAG ? `（tag=${FILTER_TAG}）` : ''}\n`);

const groups = new Map();
for (const c of filtered) {
    if (!groups.has(c.tag)) groups.set(c.tag, []);
    groups.get(c.tag).push(c);
}

let pass = 0, fail = 0, knownFail = 0;
const failedCases = [];
const knownIssues = [];

for (const [tag, group] of groups) {
    console.log(`── ${tag} ──`);
    for (const c of group) {
        const idx = c.index || 'works';
        // limit 取所有 topN 断言里的最大 N，至少 5
        let limit = 5;
        for (const k of ['top3HasId','top5HasId','top10HasId','top3HasTitleContains','top5HasTitleContains']) {
            if (c[k]) {
                const m = k.match(/^top(\d+)/);
                if (m) limit = Math.max(limit, parseInt(m[1], 10));
            }
        }
        let hits;
        try {
            hits = (await meiliSearch(idx, c.q, limit)).hits;
        } catch (e) {
            console.log(`  ❌ ${c.q.padEnd(14)} ERROR: ${e.message}`);
            fail++;
            continue;
        }
        const failures = check(c, hits);
        const label = `[${idx}] ${c.q}${c.desc ? ` (${c.desc})` : ''}`;
        if (failures.length === 0) {
            console.log(`  ✅ ${label}`);
            pass++;
        } else if (c.knownIssue && !STRICT) {
            console.log(`  ⚠️  ${label} [known-issue]`);
            for (const f of failures) console.log(`       ${f}`);
            console.log(`       why: ${c.knownIssue}`);
            knownFail++;
            knownIssues.push({ ...c, failures });
        } else {
            console.log(`  ❌ ${label}`);
            for (const f of failures) console.log(`       ${f}`);
            fail++;
            failedCases.push({ ...c, failures, hits: hits.slice(0, 5) });
        }
        if (VERBOSE) {
            for (const [i, h] of hits.slice(0, 5).entries()) {
                console.log(`       ${i+1}. ${h.id} | ${h.title} | author=${h.author || ''}`);
            }
        }
    }
    console.log();
}

console.log('━'.repeat(60));
const total = pass + fail + knownFail;
const knownPart = knownFail ? ` / known-issue ${knownFail}` : '';
console.log(`通过 ${pass} / 失败 ${fail}${knownPart} / 总计 ${total}`);
if (knownFail && !STRICT) {
    console.log(`(known-issue 不计入失败；--strict 开启严格模式)`);
}
process.exit(fail === 0 ? 0 : 1);
