/**
 * @jest-environment node
 *
 * 资源加载失败按指纹限量入库（11-27：自动化浏览器一天刷 6 万条 logo／字体失败）。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;

beforeAll(async () => {
  fn = await import('../../../../edge-functions/api/track-error.js');
});

function memKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(k: string) {
      const v = store.get(k);
      return v ? JSON.parse(v) : null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
  };
}

test('指纹去掉查询串：同一字体换版本号算同一种', () => {
  const a = fn.resourceFingerprint('resource', '资源加载失败: link', 'https://x/a.font.woff2?v=1');
  const b = fn.resourceFingerprint('resource', '资源加载失败: link', 'https://x/a.font.woff2?v=2');
  expect(a).toBe(b);
  expect(a).not.toBe(fn.resourceFingerprint('resource', '资源加载失败: link', 'https://x/b.font.woff2'));
});

test('每小时每种最多 RESOURCE_PER_HOUR 条，过了窗口重新计', async () => {
  const kv = memKv();
  const t0 = 1_800_000_000;
  let ok = 0;
  for (let i = 0; i < fn.RESOURCE_PER_HOUR + 10; i++) if (await fn.allowResourceReport(kv, 'fp', t0 + i)) ok++;
  expect(ok).toBe(fn.RESOURCE_PER_HOUR);
  expect(await fn.allowResourceReport(kv, 'other', t0)).toBe(true);
  expect(await fn.allowResourceReport(kv, 'fp', t0 + 3600)).toBe(true);
  expect([...kv.store.keys()].every((k) => k.startsWith('ratelimit:err:'))).toBe(true);
});

test('计数坏了放行', async () => {
  const kv = { async get() { throw new Error('boom'); }, async put() {} };
  expect(await fn.allowResourceReport(kv, 'fp')).toBe(true);
});

test('POST：超限的资源错误回 200 但不写记录，JS 错误不受限', async () => {
  const kv = memKv();
  const g = globalThis as unknown as Record<string, unknown>;
  g.ERROR_KV = kv;
  const post = (b: object) =>
    fn.onRequestPost({ request: new Request('https://www.openguji.com/api/track-error', { method: 'POST', body: JSON.stringify(b) }), env: {} });
  try {
    for (let i = 0; i < fn.RESOURCE_PER_HOUR + 5; i++) {
      const res = await post({ kind: 'resource', message: '资源加载失败: img', resource: 'https://www.openguji.com/images/logo-52.webp' });
      expect(res.status).toBe(200);
    }
    for (let i = 0; i < 5; i++) await post({ kind: 'js', message: 'boom' });
    const errs = [...kv.store.keys()].filter((k) => k.startsWith('err_'));
    expect(errs.length).toBe(fn.RESOURCE_PER_HOUR + 5);
  } finally {
    delete g.ERROR_KV;
  }
});
