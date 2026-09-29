/**
 * 新架构（全栈：/item/<id> 服务端渲染＋中间件跳转＋sitemap 分片）特有的行为。
 *
 * 切域名（www 从静态导出换成全栈）之前，这几件事只在 staging 与 ssr-test 上存在，
 * 老用例一条都不碰：它们都从 /book-index?id= 进、在浏览器里等客户端渲染。
 * 而切域名真正要保住的是**搜索引擎和外链看到的东西**——服务端 HTML 里的书名与
 * 头部、旧地址 308 到新地址、被并条目归到目标、查无此条给真 404。这些全是纯
 * HTTP 可判的，所以放在契约层：不开浏览器，几秒跑完（CI 时长预算 1 分钟）。
 *
 * **只读**：ssr-test 接的是正式 KV，本文件不提交反馈、不上报错误、不登录。
 *
 * 站点形态（全栈与否、该不该 noindex、canonical 指向谁）见 fixtures/site-profile.ts。
 *
 * 2026-09-28 实测两站相同的两个站点问题，已由 FX1 修掉，这里改成断言守住：
 *   · 被并条目 308 的 Location 曾是「/item/<目标>, /item/<目标>」（Next 的 ISR 页面抛 redirect
 *     会把 Location 写两遍，vercel/next.js#82117；EdgeOne 拼成一行）——现由中间件出 308，只一个值。
 *   · /sitemap.xml（索引里的「静态页」那一片）曾带 11 万余条旧的 /book-index?id= 地址，
 *     与条目分片重复——全栈构建的 sitemap.ts 现只列静态页。
 */
import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { ANCHORS, DATA_BASE, TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { dataUrl, fetchLatest } from '../fixtures/version';
import { requireUiVersion } from '../fixtures/preconditions';

/* ------------------------------------------------------------------ *
 * 样本（档位 3：经典条目，与 ui/ 现有用例同一批，已由 perf-ids 闸看着）
 * ------------------------------------------------------------------ */

// title 是数据原文（繁体），<title>／JSON-LD 用它；h1 是页面正文里的首屏摘要，直出也是简体（overview#267 QA 回归 P2），
// 所以另给 h1Title（简体）。两处都严格比对，不是「繁简任一」。
const ITEM_SAMPLES = [
    { kind: 'Work', id: ANCHORS.work.id, title: '史記', h1Title: '史记', ldType: 'Book' },
    { kind: 'Book', id: '988fbiuha8', title: '御定佩文韻府', h1Title: '御定佩文韵府', ldType: 'Book' },
    { kind: 'Collection', id: '8rlcsybg2hhf', title: '武英殿聚珍版叢書', h1Title: '武英殿聚珍版丛书', ldType: 'Collection' },
    { kind: 'Entity', id: ANCHORS.entity.id, title: '孔子', h1Title: '孔子', ldType: 'Person' },
] as const;

/** 被并条目候选：运行时核 merged_into 仍在才用，目标取数据里的值而不写死 */
const MERGED_POOL = [
    'd59f2q8ge0ap', // 田穰苴司馬法 → 併入 d59f2evs8ni8（2026-09-28）
];

/**
 * 旧草稿 id（都曾经升格过，现在草稿侧已无条目）。对照表里有它就该 308 到正式 id，
 * 没有就该 404——不许 200 出一个空壳，也不许 307 绕回 /book-index（那是对照表读不到时的兜底）。
 */
const DRAFT_POOL = [
    '1j96hewiuieps', // 孔子旧草稿（2026-08-25 升格为 hixhd2h9bk4b）
    '1eujfe7s94veo', // 史記旧草稿
];

/** 形态合法、正式位、但肯定不存在的 id */
const MISSING_ID = 'nonexistent000';

/** 首访超过这个数只告警、不失败 */
const SLOW_FIRST_VISIT_MS = 10_000;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const noFollow = { maxRedirects: 0 } as const;

function decode(s: string): string {
    return s
        .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 取 <head> 里某个 <meta name=…> 的 content；属性先后不限 */
function metaContent(html: string, name: string): string | null {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        if (!new RegExp(`\\bname=["']${name}["']`, 'i').test(tag)) continue;
        const m = tag.match(/\bcontent=["']([^"']*)["']/i);
        if (m) return decode(m[1]);
    }
    return null;
}

/** <meta property="og:…" content="…">（Open Graph 用 property，不是 name） */
function metaProperty(html: string, prop: string): string | null {
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        if (!new RegExp(`\\bproperty=["']${prop}["']`, 'i').test(tag)) continue;
        const m = tag.match(/\bcontent=["']([^"']*)["']/i);
        if (m) return decode(m[1]);
    }
    return null;
}

function canonicalHref(html: string): string | null {
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
        if (!/\brel=["']canonical["']/i.test(tag)) continue;
        const m = tag.match(/\bhref=["']([^"']*)["']/i);
        if (m) return decode(m[1]);
    }
    return null;
}

type Json = Record<string, unknown>;

function jsonLdBlocks(html: string): Json[] {
    const out: Json[] = [];
    const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    for (let m = re.exec(html); m; m = re.exec(html)) {
        try { out.push(JSON.parse(m[1]) as Json); } catch { /* 坏块由断言报出 */ out.push({ __invalid: m[1].slice(0, 80) }); }
    }
    return out;
}

/** Location 头按规范应是单个 URL；按逗号拆开，重复（见文件头）会拆成多个值、断言失败 */
function locationTargets(res: APIResponse): string[] {
    const raw = res.headers()['location'] ?? '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => new URL(s, TARGET).pathname);
}

async function getEntry(request: APIRequestContext, id: string, commitId: string): Promise<Json | null> {
    const res = await request.get(dataUrl(`current/entry/${id}.json`, commitId));
    return res.ok() ? ((await res.json()) as Json) : null;
}

/**
 * 查 h1 升格对照表（与 nextjs/src/lib/server/item-data.ts 的 resolvePromotion 同一路径）。
 * unknown ＝ 指针或 root 里没有 promotionShards 字段——站点那时会 307 回 /book-index，不在本文件断言范围。
 */
async function lookupPromotion(
    request: APIRequestContext, id: string,
): Promise<{ status: 'absent' } | { status: 'promoted'; to: string } | { status: 'unknown' }> {
    const p = await request.get(`${DATA_BASE}/h1/manifest-root.json?_=${Date.now()}`);
    if (!p.ok()) return { status: 'unknown' };
    const pointer = (await p.json()) as { root?: string };
    if (!pointer.root) return { status: 'unknown' };
    const r = await request.get(`${DATA_BASE}/h1/roots/${pointer.root}`);
    if (!r.ok()) return { status: 'unknown' };
    const root = (await r.json()) as { shardKeyLength?: number; promotionShards?: Record<string, string> };
    if (!root.promotionShards || typeof root.promotionShards !== 'object' || !root.shardKeyLength) {
        return { status: 'unknown' };
    }
    const key = id.slice(-root.shardKeyLength);
    const hash = root.promotionShards[key];
    if (!hash) return { status: 'absent' };
    const s = await request.get(`${DATA_BASE}/h1/promotions/${key}.${hash}.json`);
    if (!s.ok()) return { status: 'unknown' };
    const to = ((await s.json()) as Record<string, string>)[id];
    return typeof to === 'string' && to !== id ? { status: 'promoted', to } : { status: 'absent' };
}

/* ------------------------------------------------------------------ *
 * 闸：声明为静态的站，确实还是静态的
 * ------------------------------------------------------------------ */

test.describe('站点架构声明', () => {
    test('静态站声明仍然成立（否则全栈用例会在这里静默跳过）', async ({ request }) => {
        test.skip(SITE.fullstack, `${SITE.host} 按全栈验收，本条不适用`);
        const res = await request.get(`${TARGET}/item/${ANCHORS.work.id}`, noFollow);
        expect(
            res.status(),
            `${SITE.host} 被当作静态站（全栈用例全部跳过），但 /item/<id> 已返回 ${res.status()}。` +
            '若域名已切到全栈：把它加进 fixtures/site-profile.ts 的 FULLSTACK_HOSTS，或 verify 传 SITE_ARCH=fullstack。',
        ).toBe(404);
    });
});

/* ------------------------------------------------------------------ *
 * 全栈特有行为
 * ------------------------------------------------------------------ */

test.describe('新架构：条目页服务端 HTML', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有 /item/<id> 服务端渲染`);

    for (const s of ITEM_SAMPLES) {
        test(`${s.kind}（${s.title}）：书名、description、canonical、JSON-LD 都在首屏 HTML 里`, async ({ request }) => {
            const url = `${TARGET}/item/${s.id}`;
            const res = await request.get(url, noFollow);
            expect(res.status(), `${url} 应直接 200`).toBe(200);
            const html = await res.text();

            // 书名：<title> 与 SSR 摘要的 <h1> 都要有——客户端组件挂载前搜索引擎只看得到这些
            const title = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '');
            expect(title, '<title> 不含书名').toContain(s.title);
            expect(html, 'SSR 摘要没渲染（缺 data-ssr-item）').toContain(`data-ssr-item="${s.id}"`);
            const h1 = decode(html.match(/<h1\b[^>]*>([^<]*)/i)?.[1] ?? '');
            expect(h1, '服务端 HTML 的 <h1> 不含书名（简体）').toContain(s.h1Title);
            if (s.h1Title !== s.title) expect(h1, '服务端 HTML 的 <h1> 不该还是繁体').not.toContain(s.title);

            const desc = metaContent(html, 'description');
            expect(desc, '缺 <meta name="description">').not.toBeNull();
            expect(desc!.length, 'description 为空').toBeGreaterThan(5);

            expect(canonicalHref(html), 'canonical 不对').toBe(`${SITE.canonicalOrigin}/item/${s.id}`);

            const blocks = jsonLdBlocks(html);
            expect(blocks.filter((b) => '__invalid' in b), 'JSON-LD 有块解析不了').toEqual([]);
            const ld = blocks.find((b) => typeof b.url === 'string' && (b.url as string).endsWith(`/item/${s.id}`));
            expect(ld, `没有指向本条目的 JSON-LD（共 ${blocks.length} 块）`).toBeTruthy();
            expect(ld!['@type'], 'JSON-LD @type').toBe(s.ldType);
            expect(ld!.name, 'JSON-LD name').toBe(s.title);
            expect(ld!.url).toBe(`${SITE.canonicalOrigin}/item/${s.id}`);

            // S4（overview#280）：meta／og／twitter 的 description 是简体；JSON-LD 的 name／description 保持原文，
            // 简体名放 alternateName。书名有繁简差异的样本（s.h1Title !== s.title）才能靠书名判断
            expect(metaProperty(html, 'og:description'), 'og:description 与 meta description 应一致').toBe(desc);
            expect(metaContent(html, 'twitter:description'), 'twitter:description 与 meta description 应一致').toBe(desc);
            if (s.h1Title !== s.title) {
                const ldDesc = String(ld!.description ?? '');
                if (ldDesc.includes(s.title)) {
                    expect(desc, 'meta description 里的书名应是简体').toContain(s.h1Title);
                    expect(desc, 'meta description 不该还是繁体书名').not.toContain(s.title);
                    expect(ldDesc, 'JSON-LD 的 description 应保持原文（繁体）').toContain(s.title);
                }
                const alt = Array.isArray(ld!.alternateName) ? (ld!.alternateName as string[]) : [];
                expect(alt, 'JSON-LD 的 alternateName 应含书名的简体写法').toContain(s.h1Title);
            }

            const robots = metaContent(html, 'robots') ?? '';
            if (SITE.noindex) {
                expect(robots, `${SITE.host} 应全站 noindex`).toMatch(/noindex/);
            } else {
                expect(robots, `${SITE.host} 的条目页不该 noindex`).not.toMatch(/noindex/);
            }
        });
    }
});

test.describe('新架构：跳转与 404', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有中间件与 /item/ 路由`);

    test('/book-index?id=<正式 id> 站外来访 308 到 /item/<id>', async ({ request }) => {
        const id = ANCHORS.work.id;
        const res = await request.get(`${TARGET}/book-index?id=${id}`, noFollow);
        expect(res.status()).toBe(308);
        expect(locationTargets(res)).toEqual([`/item/${id}`]);
    });

    test('/book-index 带其它参数时不改写（详情组件自己的 URL 同步）', async ({ request }) => {
        const res = await request.get(`${TARGET}/book-index?id=${ANCHORS.work.id}&tab=books`, noFollow);
        expect(res.status(), '带 tab 参数被中间件改写了，会丢详情页状态').toBe(200);
    });

    test('被合并的条目 308 到合并目标', async ({ request }) => {
        const v = await fetchLatest(request);
        let picked: { id: string; to: string } | null = null;
        for (const id of MERGED_POOL) {
            const e = await getEntry(request, id, v.commitId);
            const m = e?.merged_into;
            const to = typeof m === 'string' ? m : (m && typeof m === 'object' ? String((m as Json).id ?? '') : '');
            if (to && to !== id) { picked = { id, to }; break; }
        }
        test.skip(picked === null, '候选池里已没有 merged_into 条目，补一条再来');

        const res = await request.get(`${TARGET}/item/${picked!.id}`, noFollow);
        expect(res.status()).toBe(308);
        expect(locationTargets(res), `Location 应是单个合并目标，实际「${res.headers()['location'] ?? ''}」`)
            .toEqual([`/item/${picked!.to}`]);

        const dest = await request.get(`${TARGET}/item/${picked!.to}`, noFollow);
        expect(dest.status(), `合并目标 /item/${picked!.to} 本身应能打开`).toBe(200);
    });

    test('旧草稿 id：对照表里没有就 404，有就 308 到正式 id', async ({ request }) => {
        const v = await fetchLatest(request);
        let checked = 0;
        for (const id of DRAFT_POOL) {
            // 草稿条目若还活着，页面会正常 200——那不是本条要测的
            if (await getEntry(request, id, v.commitId)) continue;
            const p = await lookupPromotion(request, id);
            if (p.status === 'unknown') continue;
            const res = await request.get(`${TARGET}/item/${id}`, noFollow);
            if (p.status === 'absent') {
                expect(res.status(), `${id} 不在升格对照表里，应 404`).toBe(404);
            } else {
                expect(res.status(), `${id} 已升格为 ${p.to}，应 308`).toBe(308);
                expect(locationTargets(res), `Location 应是单个正式 id，实际「${res.headers()['location'] ?? ''}」`)
                    .toEqual([`/item/${p.to}`]);
            }
            checked++;
        }
        test.skip(checked === 0, '草稿候选都还活着，或读不到 h1 升格对照表（站点会 307 兜底）');
    });

    test('不存在的 id 真 404，且带 noindex', async ({ request }) => {
        const res = await request.get(`${TARGET}/item/${MISSING_ID}`, noFollow);
        expect(res.status()).toBe(404);
        const robots = metaContent(await res.text(), 'robots') ?? '';
        expect(robots, '404 页必须 noindex，否则搜索引擎会收一堆空页').toMatch(/noindex/);
    });
});

test.describe('新架构：阅读页 /read/<id>（N5b；overview#267 起在一级目录）', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由与中间件`);
    test.beforeEach(({ request }) => requireUiVersion(request, '0.10.0', '新阅读器 ReaderShell'));

    const C = ANCHORS.collated;
    const juan = 'juan/011.json';
    /** 地址里的卷号是短形式；卷文件名只在内部用（overview#267 P2-5） */
    const shortJuan = '011';

    /** 取 Location（只应有一个值），换成 path+search */
    const locationOf = (res: APIResponse) =>
        (res.headers()['location'] ?? '').split(',').map((v) => v.trim()).filter(Boolean)
            .map((v) => { const u = new URL(v, TARGET); return u.pathname + u.search; });

    test('每卷各有 <title> 与 canonical，出在首屏 HTML 里', async ({ request }) => {
        const path = `/read/${C.id}?kind=collated&juan=${shortJuan}`;
        const res = await request.get(`${TARGET}${path}`, noFollow);
        expect(res.status(), `${path} 应直接 200`).toBe(200);
        const html = await res.text();
        const title = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '');
        expect(title, '<title> 应含书名与卷号').toContain(`${C.title} · 卷11 · 整理本`);
        expect(canonicalHref(html), 'canonical 应指向本卷（新的一级地址）').toBe(`${SITE.canonicalOrigin}${path}`);
    });

    test('旧入口 ?tab=collated／fulltext 一步 308 到 /read/<id>，保留卷号，不先跳 /item/<id>/read', async ({ request }) => {
        const cases: [string, string][] = [
            [`/book-index?id=${C.id}&tab=collated&juan=${encodeURIComponent(juan)}`, `/read/${C.id}?kind=collated&juan=${shortJuan}`],
            [`/item/${C.id}?tab=collated`, `/read/${C.id}?kind=collated`],
        ];
        for (const [from, to] of cases) {
            const res = await request.get(`${TARGET}${from}`, noFollow);
            expect(res.status(), `${from} 应 308`).toBe(308);
            expect(locationOf(res), `${from}（Location 须只有一个值，且带上卷号）`).toEqual([to]);
        }
    });

    test('旧阅读页地址 /item/<id>/read?… 308 到 /read/<id>?…，查询参数保留；旧卷号同一跳换成短形式', async ({ request }) => {
        const cases: [string, string][] = [
            [`/item/${C.id}/read?kind=collated&juan=${shortJuan}`, `/read/${C.id}?kind=collated&juan=${shortJuan}`],
            [`/item/${C.id}/read?kind=collated&juan=${encodeURIComponent(juan)}`, `/read/${C.id}?kind=collated&juan=${shortJuan}`],
            [`/item/${C.id}/read?kind=fulltext&key=a&juan=001&x=1`, `/read/${C.id}?kind=fulltext&key=a&juan=001&x=1`],
            [`/item/${C.id}/read`, `/read/${C.id}`],
        ];
        for (const [from, to] of cases) {
            const res = await request.get(`${TARGET}${from}`, noFollow);
            expect(res.status(), `${from} 应 308`).toBe(308);
            expect(locationOf(res), `${from}（一步到位，Location 只有一个值）`).toEqual([to]);
        }
    });

    test('旧的说明页 /read/<名>（含 .md）308 到 /read/md/<名>，新地址能打开', async ({ request }) => {
        for (const from of ['/read/assistant', '/read/assistant.md', '/read/roadmap_overview.md']) {
            const res = await request.get(`${TARGET}${from}`, noFollow);
            expect(res.status(), `${from} 应 308`).toBe(308);
            expect(locationOf(res)).toEqual([`/read/md/${from.replace(/^\/read\//, '').replace(/\.md$/, '')}`]);
        }
        const page = await request.get(`${TARGET}/read/md/assistant`, noFollow);
        expect(page.status(), '说明页新地址应 200').toBe(200);
    });

    test('没有这种阅读页、或卷号查不到的给真 404（不出软 404）', async ({ request }) => {
        const res = await request.get(`${TARGET}/read/${ANCHORS.entity.id}`, noFollow);
        expect(res.status(), '人物条目没有阅读页').toBe(404);
        // 旧形式的卷号先 308 到短形式（不查数据），短形式再 404；所以旧形式这条跟着跳，看终点
        const legacyBad = await request.get(`${TARGET}/read/${C.id}?kind=collated&juan=juan%2F999.json`, noFollow);
        expect(legacyBad.status(), '旧形式的卷号先 308 到短形式').toBe(308);
        for (const [what, r] of [
            ['旧形式跟随跳转后', await request.get(`${TARGET}/read/${C.id}?kind=collated&juan=juan%2F999.json`)],
            ['短形式', await request.get(`${TARGET}/read/${C.id}?kind=collated&juan=999`, noFollow)],
        ] as const) {
            expect(r.status(), `乱填的卷号（${what}）应 404`).toBe(404);
            expect(metaContent(await r.text(), 'robots') ?? '', '404 页必须 noindex').toMatch(/noindex/);
        }
    });
});

test.describe('用户意见（overview#267）：总目不要页脚、页脚黑底、关于页精简', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站`);

    const footerOf = (html: string) => html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0] ?? '';

    test('/catalog 没有页脚；/about、/feedback、/privacy 有', async ({ request }) => {
        const catalog = await (await request.get(`${TARGET}/catalog`, noFollow)).text();
        expect(footerOf(catalog), '古籍总目页不该有页脚').toBe('');
        for (const path of ['/about', '/feedback', '/privacy']) {
            const html = await (await request.get(`${TARGET}${path}`, noFollow)).text();
            const footer = footerOf(html);
            expect(footer, `${path} 应有页脚`).toContain('og-footer');
            expect(footer, `${path} 的页脚不该再有「开放协议」`).not.toContain('开放协议');
        }
    });

    test('/about 只剩数据来源与授权、致谢、联系我们三节；底色用 og-paper', async ({ request }) => {
        const html = await (await request.get(`${TARGET}/about`, noFollow)).text();
        expect(html).toContain('数据来源与授权');
        expect(html).toContain('致谢');
        expect(html).not.toContain('项目介绍');
        expect(html).not.toContain('开源仓库');
        expect(html).toContain('og-paper');
    });

    test('顶栏搜索入口叫「古籍元数据」', async ({ request }) => {
        const html = await (await request.get(`${TARGET}/about`, noFollow)).text();
        expect(html).toMatch(/<a[^>]*href="\/book-index"[^>]*>古籍元数据<\/a>/);
        expect(html).not.toContain('>古籍索引<');
    });
});

test.describe('QA 回归 P2（overview#267）：条目页直出简体、旧入口没有内容不跳 404', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有条目页 SSR 与中间件`);

    // 档位 3：经典条目。程甲本（Book）、史記（Work）、武英殿聚珍版叢書（Collection）、朱熹（Entity）
    const SAMPLES: [string, string, RegExp, string][] = [
        ['程甲本 Book', '96kzkdm8e8', /红楼梦/, '紅樓夢'],
        ['史記 Work', 'd59f20aowb9c', /史记/, '史記'],
        ['武英殿聚珍版叢書 Collection', '8rlcsybg2hhf', /丛书/, '叢書'],
        ['朱熹 Entity', 'hixhd2h9bgah', /朱熹/, ''],
    ];

    for (const [name, id, simp, trad] of SAMPLES) {
        test(`${name}：关 JS 直出的首屏摘要是简体`, async ({ request }) => {
            const res = await request.get(`${TARGET}/item/${id}`, noFollow);
            expect(res.status()).toBe(200);
            const html = await res.text();
            const article = html.match(/<article[^>]*data-ssr-item[^>]*>[\s\S]*?<\/article>/)?.[0] ?? '';
            expect(article, '直出 HTML 里没有首屏摘要 article').not.toBe('');
            const text = decode(article.replace(/<[^>]+>/g, ''));
            expect(text, `${name} 的首屏摘要应是简体`).toMatch(simp);
            if (trad) expect(text, `${name} 的首屏摘要不该还是繁体`).not.toContain(trad);
        });
    }

    // 詩序考（d59f2pra0vsw）：Work，条目 JSON 里没有 has_collated／has_text
    const NO_CONTENT = 'd59f2pra0vsw';
    for (const [from, to] of [
        [`/book-index?id=${NO_CONTENT}&tab=collated`, `/item/${NO_CONTENT}`],
        [`/book-index?id=${NO_CONTENT}&tab=fulltext`, `/item/${NO_CONTENT}`],
        [`/item/${NO_CONTENT}?tab=fulltext`, `/item/${NO_CONTENT}`],
    ]) {
        test(`条目没有这类内容：${from} → 308 ${to}（不跳只会 404 的阅读页）`, async ({ request }) => {
            const res = await request.get(`${TARGET}${from}`, noFollow);
            expect(res.status(), `${from} 应 308`).toBe(308);
            const loc = (res.headers()['location'] ?? '').split(',').map((v) => v.trim()).filter(Boolean)
                .map((v) => { const u = new URL(v, TARGET); return u.pathname + u.search; });
            expect(loc).toEqual([to]);
        });
    }
});

test.describe('阅读首页 /read（overview#267 第 16 项）', () => {
    // 数据是构建期「可读条目」索引（current/read/…）。线上数据 CDN 在下一次数据同步前还没有这份索引：
    // 那时首页显示「正在准备」（200），节点页 404；同步之后首页列出整理本、书本与四部入口。
    // 这里只验两种数据状态下都成立的部分：导航、首页 200＋h1＋canonical、参数校验；
    // 列表内容由本地带索引的实测与 PR 截图覆盖。
    test('顶栏有「阅读」指向 /read，页面 200 且有 h1', async ({ request }) => {
        const home = await (await request.get(`${TARGET}/`, noFollow)).text();
        expect(home).toMatch(/<a[^>]*href="\/read"[^>]*>阅读<\/a>/);
        const res = await request.get(`${TARGET}/read`, noFollow);
        expect(res.status()).toBe(200);
        const html = await res.text();
        expect(html).toMatch(/<h1[^>]*>阅读<\/h1>/);
        expect(html).toMatch(/<link[^>]*rel="canonical"[^>]*href="[^"]*\/read"/);
    });

    test('参数不对真 404：乱码节点、页码非法、没有节点却翻页、不存在的节点', async ({ request }) => {
        for (const q of ['node=..%2Fx', 'node=%E5%8F%B2%E9%83%A8', 'node=cshi&page=0', 'node=cshi&page=x', 'page=2', 'node=cnopenope00']) {
            expect((await request.get(`${TARGET}/read?${q}`, noFollow)).status(), q).toBe(404);
        }
    });
});

test.describe('条目页多余查询参数 308 到干净地址（overview#280 S1）', () => {
    const ID = ANCHORS.work.id;

    test('utm／fbclid 等多余参数 → 一个 Location 的 308，指向 /item/<id>', async ({ request }) => {
        for (const q of ['utm_source=x&utm_medium=y', 'fbclid=abc', 'spm=1.2.3']) {
            const res = await request.get(`${TARGET}/item/${ID}?${q}`, noFollow);
            expect(res.status(), q).toBe(308);
            const loc = res.headers()['location'] ?? '';
            expect(loc.includes(','), `Location 有两个值：${loc}`).toBe(false);
            expect(new URL(loc, TARGET).pathname + new URL(loc, TARGET).search, q).toBe(`/item/${ID}`);
        }
    });

    test('白名单参数保留，多余的去掉；干净地址与只带白名单参数的地址不跳', async ({ request }) => {
        const mixed = await request.get(`${TARGET}/item/${ID}?utm_source=x&tab=lineage&page=2`, noFollow);
        expect(mixed.status()).toBe(308);
        const to = new URL(mixed.headers()['location'] ?? '', TARGET);
        expect(to.pathname + to.search).toBe(`/item/${ID}?tab=lineage&page=2`);
        for (const q of ['', '?tab=lineage']) {
            const r = await request.get(`${TARGET}/item/${ID}${q}`, noFollow);
            expect(r.status(), q).toBe(200);
        }
    });
});

test.describe('站点自己的 404 页（overview#267 P2-4）', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，404 行为不同`);

    for (const path of ['/no-such-page', '/item/zzzzzzzzzz', '/catalog?node=zzz']) {
        test(`${path}：真 404，中文 title，noindex，未匹配路由带回首页／总目／搜索三个入口`, async ({ request }) => {
            const res = await request.get(`${TARGET}${path}`, noFollow);
            expect(res.status(), `${path} 应 404`).toBe(404);
            const html = await res.text();
            expect(decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? ''), 'title 应是中文').toContain('找不到这个页面');
            expect(metaContent(html, 'robots') ?? '', '404 页必须 noindex').toMatch(/noindex/);
            expect(html, '应是站点自己的页，不是 Next 默认英文页').not.toContain('This page could not be found');
            expect(html).toContain('找不到这个页面');
            // 页面调 notFound() 时 Next 先流出错误壳、内容走客户端渲染，首屏 HTML 里没有链接；
            // 三个入口只在未匹配路由（直接渲染 not-found）的 HTML 里断言
            if (path === '/no-such-page') {
                for (const href of ['href="/"', 'href="/catalog"', 'href="/book-index"']) expect(html, `缺入口 ${href}`).toContain(href);
            }
        });
    }
});

test.describe('新架构：sitemap', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有 sitemap 分片`);

    test('sitemap-index.xml 可取，条目分片条数合理', async ({ request }) => {
        const res = await request.get(`${TARGET}/sitemap-index.xml`);
        expect(res.status()).toBe(200);
        const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        expect(locs.length, 'sitemap 索引为空').toBeGreaterThan(0);
        for (const l of locs) expect(l.startsWith(`${SITE.canonicalOrigin}/`), `索引里的 ${l} 不在 ${SITE.canonicalOrigin}`).toBe(true);

        const paths = locs.map((l) => new URL(l).pathname);
        expect(paths, '索引里没有静态页 sitemap.xml').toContain('/sitemap.xml');
        const shards = paths.filter((p) => /^\/sitemaps\/(work|book|collection|entity)-\d{3}\.xml$/.test(p));
        for (const t of ['work', 'book', 'collection', 'entity']) {
            expect(shards.some((p) => p.includes(`/${t}-`)), `缺 ${t} 分片`).toBe(true);
        }

        // 分片按被测站取（ssr-test 的 <loc> 指向 www，而 www 切域名前还没有这些文件）
        const counts = await Promise.all(shards.map(async (p) => {
            const r = await request.get(`${TARGET}${p}`);
            expect(r.status(), `${p} 取不到`).toBe(200);
            const xml = await r.text();
            const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            expect(urls.length, `${p} 是空的`).toBeGreaterThan(0);
            expect(urls.length, `${p} 超过单片 5 万条上限`).toBeLessThanOrEqual(50_000);
            expect(urls[0], `${p} 的地址形态不对`).toMatch(new RegExp(`^${SITE.canonicalOrigin.replace(/\./g, '\\.')}/item/[0-9a-z]{6,20}$`));
            return urls.length;
        }));
        const total = counts.reduce((a, b) => a + b, 0);
        test.info().annotations.push({ type: 'sitemap', description: `${shards.length} 个条目分片，共 ${total} 条` });
        // gen-sitemaps.mjs 的闸是 ≥10 万；2026-09-28 staging 实测 146,670
        expect(total, '条目 sitemap 总数不在合理区间').toBeGreaterThanOrEqual(100_000);
        expect(total).toBeLessThanOrEqual(400_000);

        // 总目与阅读首页的分类节点页（overview#280 S3，#242）
        expect(paths, '索引里没有分类节点页分片').toContain('/sitemaps/nodes-001.xml');
        const nodesXml = await (await request.get(`${TARGET}/sitemaps/nodes-001.xml`)).text();
        const nodeUrls = [...nodesXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
        expect(nodeUrls.filter((u) => u.includes('/catalog?node=')).length, '总目节点页太少').toBeGreaterThanOrEqual(20);
        for (const u of nodeUrls) expect(u, u).toMatch(/\/(catalog|read)\?node=[0-9a-z]{1,24}$/);

        // 静态页 sitemap 不再列旧详情地址（条目只由上面的分片列，见文件头）
        const legacy = await request.get(`${TARGET}/sitemap.xml`);
        expect(legacy.status(), '/sitemap.xml 取不到').toBe(200);
        const n = ((await legacy.text()).match(/\/book-index\?id=/g) ?? []).length;
        expect(n, `/sitemap.xml 仍有 ${n} 条旧 /book-index?id= 地址，与条目分片重复`).toBe(0);
    });

    test('sitemap.xml 静态页清单有 /catalog、/read、/contact', async ({ request }) => {
        const xml = await (await request.get(`${TARGET}/sitemap.xml`)).text();
        const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
        for (const p of ['/catalog', '/read', '/contact']) expect(paths, `sitemap.xml 缺 ${p}`).toContain(p);
    });
});

test.describe('新架构：API', () => {
    test('/api/feedback GET 可读（只读，不提交）', async ({ request }) => {
        const res = await request.get(`${TARGET}/api/feedback`);
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { success?: boolean; items?: unknown };
        expect(body.success).toBe(true);
        expect(Array.isArray(body.items), 'items 不是数组').toBe(true);
    });

    test('/api/version（有就测）', async ({ request }) => {
        const res = await request.get(`${TARGET}/api/version`);
        test.skip(res.status() === 404, `${SITE.host} 没有 /api/version`);
        expect(res.status()).toBe(200);
        const body = await res.json().catch(() => null);
        expect(body, '/api/version 返回的不是 JSON').toBeTruthy();
    });
});

/* ------------------------------------------------------------------ *
 * 首访耗时：只记录，不断言
 * ------------------------------------------------------------------ */

test.describe('新架构：条目页首访耗时（只记录）', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站`);

    test('各类条目首访耗时', async ({ request }) => {
        // 带一次性查询串，尽量绕开 CDN 已缓存的那份，量到函数渲染的真实耗时。
        // 参数名用白名单里的 page（lib/item-query.ts）：别的参数会被 S1 的中间件 308 到干净地址，量到的就是 308 而不是渲染
        const bust = Date.now().toString(36);
        const rows = await Promise.all(ITEM_SAMPLES.map(async (s) => {
            const t0 = Date.now();
            try {
                const r = await request.get(`${TARGET}/item/${s.id}?page=${bust}`, { ...noFollow, timeout: 60_000 });
                await r.body();
                return { ...s, ms: Date.now() - t0, status: String(r.status()), cache: r.headers()['eo-cache-status'] ?? '-' };
            } catch (e) {
                return { ...s, ms: Date.now() - t0, status: `错误：${(e as Error).message.split('\n')[0]}`, cache: '-' };
            }
        }));
        for (const r of rows) {
            const line = `${r.kind} ${r.id}：${r.ms} ms（HTTP ${r.status}，EO-Cache-Status ${r.cache}）`;
            test.info().annotations.push({ type: '首访耗时', description: line });
            console.log(`首访耗时 ${line}`);
            if (r.ms > SLOW_FIRST_VISIT_MS) {
                test.info().annotations.push({ type: 'warning', description: `首访超过 ${SLOW_FIRST_VISIT_MS / 1000} 秒：${line}` });
                // GitHub Actions 会把这行渲染成告警
                console.log(`::warning title=条目页首访慢::${SITE.host} ${line}`);
            }
        }
    });
});
