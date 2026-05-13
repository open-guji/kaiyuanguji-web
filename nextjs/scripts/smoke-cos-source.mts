/**
 * Phase 2 烟雾测试：直接调用 cos-storage 接口，验证整条链路在 Node 下也工作。
 *
 * 运行：
 *   NEXT_PUBLIC_COS_BASE=https://data.kaiyuanguji.com npx tsx scripts/smoke-cos-source.mts
 */

process.env.NEXT_PUBLIC_COS_BASE ??= 'https://data.kaiyuanguji.com';
process.env.NEXT_PUBLIC_DATA_SOURCE ??= 'cos';

const { resolveCosVersion, getCosDataBaseUrl, getCosSearchBaseUrl, createCosStorage } =
    await import('../src/lib/cos-storage.ts');

async function probe<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    process.stdout.write(`  ${name.padEnd(40)} `);
    const t0 = Date.now();
    try {
        const r = await fn();
        console.log(`✓ ${Date.now() - t0}ms`);
        return r;
    } catch (e) {
        console.log(`✗ ${Date.now() - t0}ms — ${(e as Error).message}`);
        return null;
    }
}

console.log('\n=== 1. version resolution ===');
const commit = await probe('resolveCosVersion()', () => resolveCosVersion());
console.log(`  commitId  = ${commit}`);

const dataBase = await probe('getCosDataBaseUrl()', () => getCosDataBaseUrl());
console.log(`  data base = ${dataBase}`);

const searchBase = await probe('getCosSearchBaseUrl()', () => getCosSearchBaseUrl());
console.log(`  search base = ${searchBase}`);

console.log('\n=== 2. CosStorage proxy resolves lazily ===');
const storage = createCosStorage();

await probe('getCounts() via Proxy', async () => {
    const counts = await storage.getCounts?.();
    if (!counts) throw new Error('getCounts returned undefined');
    return counts;
}).then(c => c && console.log(`  counts:`, JSON.stringify(c)));

console.log('\n=== 3. getEntry roundtrip (BundleStorage chunks fetch) ===');
// 用一个已知的 Work ID — 从 chunks 抽样里看到的脂砚斋庚辰本
const testId = '11pde4bf0xatc';
await probe(`getEntry("${testId}")`, async () => {
    const entry = await storage.getEntry?.(testId);
    if (!entry) throw new Error('getEntry returned null');
    return entry;
}).then(e => e && console.log(`  entry: id=${e.id} title=${e.title} type=${e.type}`));

console.log('\n=== 4. CDN cache 命中验证（同样请求第二次应当更快）===');
// 重新构造一个，因为内部已经 cached
const t2 = await probe(`getEntry("${testId}") 2nd time`, async () => {
    const entry = await storage.getEntry?.(testId);
    return entry;
});

console.log('\n=== done ===');
