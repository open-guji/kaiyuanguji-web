/**
 * 测试与压测里写死的条目 ID，必须在数据桶里真的存在。
 *
 * 为什么单开一道闸：2026-09-14 从生产错误日志倒查出来，`perf/` 的三条详情页场景
 * 全烂了——D1 `aTNoXY45BGY3` 与 E1 `1ev3bb403quio` 早已 404，D3 `1j96hewiuieps`
 * 是草稿墓碑；夜跑的 perf-prod 每晚把「找不到」页当成「作品详情 論語」的性能基线，
 * **烂了 26 晚一次都没红过**，还每晚往生产的错误自收里打一条 404（共 30 条）。
 *
 * 它烂得这么安静，是因为 smoke 只在 `--strict-404` 时才把 404 算作失败，而 CI
 * 没开这个开关；perf 那边更是只量字节数与耗时——**一个 404 页面照样有字节数、
 * 照样能量出耗时**，看数字完全看不出来。anchors.ts 开头早把 `aTNoXY45BGY3`
 * 写成「前车之鉴」，却始终没人把它换掉：光写进注释挡不住事，得有闸。
 *
 * 本闸的判据很窄，也正因为窄才不会误报：凡是被测试/压测拿来当锚点的条目 ID，
 * 都必须能在当前发布的数据里取到，且不是墓碑。
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANCHORS, DATA_BASE } from '../fixtures/anchors';
import { fetchLatest, dataUrl } from '../fixtures/version';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 直接从 perf 的源码里扫 ID，而不是让两边共享常量。
 * 这样**新加的场景自动纳入本闸**——共享常量只能盯住已经共享的那几个，
 * 而这次出事的恰恰是「写在场景表里没人再看一眼」的字面量。
 */
function idsFromPerfSources(): { id: string; where: string }[] {
    const out: { id: string; where: string }[] = [];
    for (const rel of ['perf/smoke.ts', 'perf/scenarios.ts']) {
        const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
        for (const line of src.split('\n')) {
            // 只认场景 path 里的 ?id=/&id=，注释里提到的旧 ID 不算
            const m = /path: *'[^']*[?&]id=([A-Za-z0-9]+)/.exec(line);
            if (m) out.push({ id: m[1], where: rel });
        }
    }
    return out;
}

test.describe('测试锚点 ID 契约', () => {
    test('perf 场景里的每个详情 ID 都能在数据桶里取到，且不是墓碑', async ({ request }) => {
        const v = await fetchLatest(request);
        const refs = idsFromPerfSources();

        // 扫 0 个 ID 的「全过」与真正的全过输出一模一样——先把扫到多少印出来
        console.log(`扫到 ${refs.length} 个 perf 场景 ID：${refs.map((r) => r.id).join(', ')}`);
        expect(refs.length, 'perf 源码里一个场景 ID 都没扫到，说明这个闸没在看它该看的东西').toBeGreaterThanOrEqual(3);

        const dead: string[] = [];
        for (const { id, where } of refs) {
            const res = await request.get(dataUrl(`current/entry/${id}.json`, v.commitId));
            if (!res.ok()) {
                dead.push(`${id}（${where}）HTTP ${res.status()}`);
                continue;
            }
            const entry = await res.json();
            if (entry._promoted_to) {
                dead.push(`${id}（${where}）是草稿墓碑，已升格为 ${entry._promoted_to}`);
            }
        }

        expect(
            dead,
            `这些 ID 已失效，量到的不是真页面：\n  ${dead.join('\n  ')}\n` +
            '换成当前正式条目的 ID 即可；别只在注释里记一笔。',
        ).toEqual([]);
    });

    test('anchors 里的稳定锚点仍然存在且不是墓碑', async ({ request }) => {
        const v = await fetchLatest(request);
        const anchors = [
            { id: ANCHORS.work.id, name: '作品锚点' },
            ...(ANCHORS.entity?.id ? [{ id: ANCHORS.entity.id, name: '人物锚点' }] : []),
        ];
        console.log(`核 ${anchors.length} 个锚点：${anchors.map((a) => a.id).join(', ')}`);

        for (const a of anchors) {
            const res = await request.get(dataUrl(`current/entry/${a.id}.json`, v.commitId));
            expect(res.ok(), `${a.name} ${a.id} 取不到（HTTP ${res.status()}）`).toBeTruthy();
            const entry = await res.json();
            expect(entry._promoted_to, `${a.name} ${a.id} 是墓碑，应换成 ${entry._promoted_to}`).toBeFalsy();
        }
    });
});

test.describe('数据源', () => {
    test('DATA_BASE 指向线上数据桶', () => {
        expect(DATA_BASE).toContain('kaiyuanguji.com');
    });
});
