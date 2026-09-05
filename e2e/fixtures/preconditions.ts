/**
 * 前置条件 —— 用例跑之前先确认「它断言的那个前提还成立吗」。
 *
 * 这套东西针对的是本仓两类反复出现的**假红**：验收本身没发现任何回归，
 * 但用例的前提悄悄没了，于是红灯照亮，真正的回归反而被淹没。
 *
 *   1. 前端版本没跟上。
 *      新用例断言的是 book-index-ui 新版才有的行为，而它先于版本升级
 *      落到 main —— 那次部署装的还是旧包，用例必然挂。
 *      #177（5c74bd7 人物页版式，4 条）与 #179（dc995da 空状态，3 条）
 *      两次红都是这么来的，各自被下一笔「升级 book-index-ui」冲绿。
 *      → requireUiVersion()：站点比要求的版本旧就跳过，版本升上去后自动生效。
 *
 *   2. 数据样本被整理掉了。
 *      「什么都没有的条目」这个属性正是本项目每天在消灭的东西
 *      （生产库实测：空作品 2 / 91,686，空人物 451 / 30,159）。
 *      把某个 ID 写死在用例里，等于赌它永远没人整理。
 *      → pickEmptySample()：运行时逐个验证候选，取第一个仍然成立的。
 *
 * 两者都选择**跳过**而非失败。这套 e2e 是发版验收门禁，职责是拦住线上回归，
 * 不是督促数据整理；前提不在了就没有可断言的东西，为此挡住部署是错的。
 * 跳过会带着原因出现在 Playwright 报告里，覆盖真的掉了看得见。
 */
import { test, type APIRequestContext } from '@playwright/test';
import { TARGET } from './anchors';
import { dataUrl, fetchLatest, type DataVersion } from './version';

/* ------------------------------------------------------------------ *
 * 前端版本
 * ------------------------------------------------------------------ */

/** 站点 <meta name="bim-ui-version">，由 next.config.ts 注入实际打包的版本 */
let uiVersionCache: string | undefined;

/**
 * 读线上站点实际部署的 book-index-ui 版本。
 * 不开浏览器——直接取 HTML 里的 meta；每个 worker 成功读到一次后就复用。
 *
 * 只缓存成功的结果：读失败若也缓存，一次网络抖动就会让该 worker 里所有带
 * 版本门禁的用例全部静默跳过——正是这套机制要避免的那种「假绿」。
 */
export async function fetchUiVersion(request: APIRequestContext): Promise<string | null> {
    if (uiVersionCache !== undefined) return uiVersionCache;
    const res = await request.get(`${TARGET}/book-index?_=${Date.now()}`);
    if (!res.ok()) return null;
    const html = await res.text();
    const m = html.match(/<meta[^>]+name=["']bim-ui-version["'][^>]+content=["']([^"']*)["']/i);
    if (!m?.[1]) return null;
    uiVersionCache = m[1];
    return uiVersionCache;
}

/** 只比 major.minor.patch，忽略预发布后缀。a<b 返回负数 */
export function cmpVersion(a: string, b: string): number {
    const parse = (v: string) =>
        (v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0));
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
}

/**
 * 声明本用例需要的最低 book-index-ui 版本；站点比它旧就跳过。
 *
 * 这让「先写用例、后升版本」成为安全的两步走：用例可以随重构一起进 main，
 * 在旧版站点上自动休眠，等升级那笔部署一上线就开始真正把关。
 *
 * 站点读不出版本时（meta 尚未随该版本上线）同样跳过——只可能发生在
 * 本次改动上线之前，之后就不会了。
 */
export async function requireUiVersion(
    request: APIRequestContext,
    min: string,
    feature: string,
): Promise<void> {
    const live = await fetchUiVersion(request);
    if (live === null) {
        test.skip(true, `站点未暴露 bim-ui-version，无法确认前端版本；「${feature}」需 >= ${min}`);
        return;
    }
    test.skip(
        cmpVersion(live, min) < 0,
        `线上 book-index-ui ${live} < ${min}，「${feature}」尚未上线——升级版本后本用例自动生效`,
    );
}

/* ------------------------------------------------------------------ *
 * 空状态样本
 * ------------------------------------------------------------------ */

type Entry = Record<string, unknown>;

const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/**
 * 墓碑条目（已合并 / 已升格）。字段确实是空的，但「空」的原因是它被指向了
 * 别处，不是数据稀疏——UI 将来给 merged_into 补上重定向是完全合理的演进
 * （promoted_to 早已如此），那时拿墓碑当空状态样本就会挂。一律不用。
 *
 * 原用例锚的 d59f2q8ge0ap（田穰苴司馬法）正是这种条目：整条只有
 * {id, type, title, merged_into}。
 */
function isTombstone(e: Entry): boolean {
    return Boolean(e.merged_into ?? e._promoted_to ?? e.promoted_to);
}

/**
 * 作品页是否落在「尚未著錄該作品的版本、資源與書目收錄。」那个分支。
 *
 * 对齐 book-index-ui 0.7.3 的判据（dist/index.cjs）：
 *   版本 0 && 资源 buckets 0 && mirrors 0 && !indexed_by && !emendated_by
 *   && 关联作品分组 0 && !description.text
 * 这里按条目源字段判断——源字段全空，UI 就没有任何东西可渲染。
 */
export function isEmptyWork(e: Entry): boolean {
    const desc = e.description as { text?: string } | undefined;
    return (
        !isTombstone(e) &&
        len(e.books) === 0 &&
        len(e.resources) === 0 &&
        len(e.indexed_by) === 0 &&
        len(e.emendated_by) === 0 &&
        len(e.related_works) === 0 &&
        len(e.contained_in) === 0 &&
        !e.collated_edition &&
        !desc?.text
    );
}

/** 人物页是否落在「尚未著錄該人物的關聯作品。」分支：只看关联作品 */
export function isEmptyEntity(e: Entry): boolean {
    return !isTombstone(e) && len(e.works) === 0;
}

export interface EmptySample {
    id: string;
    entry: Entry;
}

/**
 * 从候选池里挑一个**当下仍然为空**的条目。
 *
 * 逐个拉 entry JSON 验证，取第一个满足的。取不到（404，条目被合并/改 ID）
 * 或已被整理过的一律跳过不用。全池皆空时返回 null，由调用方 skip。
 */
export async function pickEmptySample(
    request: APIRequestContext,
    candidates: readonly string[],
    isEmpty: (e: Entry) => boolean,
    version?: DataVersion,
): Promise<EmptySample | null> {
    const v = version ?? (await fetchLatest(request));
    for (const id of candidates) {
        const res = await request.get(dataUrl(`current/entry/${id}.json`, v.commitId));
        if (!res.ok()) continue;          // 条目没了：合并、改 ID 或尚未上线
        const entry = (await res.json()) as Entry;
        if (isEmpty(entry)) return { id, entry };
    }
    return null;
}
