/**
 * @jest-environment node
 *
 * DBG：GET /api/version 与「构建时写进文件」的构建信息。
 *
 * 要钉住的几件事：
 *   1. 构建信息从 git／构建变量推出，target 与 deploy.yml 三条构建支路对得上；
 *   2. 写进 version.js 的标记区是幂等的（正式站 build 后双跑再 build 一次，同一文件被写两遍）；
 *   3. 写进去之后 version.js 仍是能 import 的模块，/api/version 回的正是写进去的那份；
 *   4. 接口 no-store、公开、不带任何密钥／内网地址；数据指针只读自家数据域名。
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bi = require('../../../scripts/lib/build-info.cjs');

const REPO_VERSION_JS = join(__dirname, '../../../../edge-functions/api/version.js');
const SHA = 'a'.repeat(40);

const POINTER = {
  commitId: '501935e5be70',
  fullCommitId: '501935e5be70c1b5c99ac2e326052443a6f09c71',
  productionCommitId: '2e1064e5abb74bfc0ae75c0ef4caf9640be66846',
  textCommitId: '70d445a2af9cb7e97ed9f9e5168174ce7855b790',
  bundleDate: '2026-09-28T01:05:47.737Z',
  webCommitId: SHA,
  somethingElse: 'should-not-leak',
};

function okFetch(json: unknown) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => json } as unknown as Response;
  };
  return Object.assign(f, { calls });
}

describe('resolveTarget：与 deploy.yml 三条构建支路对应', () => {
  it('静态导出 → production', () => {
    expect(bi.resolveTarget({})).toBe('production');
    expect(bi.resolveTarget({ NEXT_PUBLIC_SITE_ENV: '' })).toBe('production');
  });
  it('测试站 → staging（全栈也算 staging）', () => {
    expect(bi.resolveTarget({ NEXT_PUBLIC_SITE_ENV: 'staging', KYG_RENDER_MODE: 'fullstack' })).toBe('staging');
  });
  it('正式站配置的全栈（双跑）→ ssr-test', () => {
    expect(bi.resolveTarget({ NEXT_PUBLIC_SITE_ENV: '', KYG_RENDER_MODE: 'fullstack' })).toBe('ssr-test');
  });
  it('KYG_DEPLOY_TARGET 显式覆盖', () => {
    expect(bi.resolveTarget({ KYG_DEPLOY_TARGET: 'x', KYG_RENDER_MODE: 'fullstack' })).toBe('x');
  });
});

describe('computeBuildInfo', () => {
  it('web 取 git HEAD（本仓就是 git 仓）', () => {
    const info = bi.computeBuildInfo({ env: {}, bimUi: '0.9.8', now: new Date('2026-09-28T00:00:00Z') });
    expect(info.web).toMatch(/^[0-9a-f]{40}$/);
    expect(info).toMatchObject({ bimUi: '0.9.8', builtAt: '2026-09-28T00:00:00.000Z', target: 'production', dataBase: 'https://data.kaiyuanguji.com' });
  });
  it('不在 git 仓里时退到 GITHUB_SHA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bi-'));
    const info = bi.computeBuildInfo({ cwd: dir, env: { GITHUB_SHA: SHA } });
    expect(info.web).toBe(SHA);
  });
  it('测试站读 staging/ 数据指针；非自家域名一律回默认', () => {
    expect(bi.computeBuildInfo({ env: { NEXT_PUBLIC_COS_BASE: 'https://data.kaiyuanguji.com/staging/' } }).dataBase)
      .toBe('https://data.kaiyuanguji.com/staging');
    expect(bi.computeBuildInfo({ env: { NEXT_PUBLIC_COS_BASE: 'http://10.0.0.1/x' } }).dataBase)
      .toBe('https://data.kaiyuanguji.com');
  });
});

describe('injectBuildInfo / writeBuildInfo', () => {
  const info = { web: SHA, bimUi: '0.9.8', builtAt: '2026-09-28T00:00:00.000Z', target: 'staging', dataBase: 'https://data.kaiyuanguji.com/staging' };

  it('仓库里的 version.js 有标记区，且默认是 null', () => {
    const src = readFileSync(REPO_VERSION_JS, 'utf-8');
    expect(src).toContain(bi.MARK_START);
    expect(src).toContain(bi.MARK_END);
    expect(src).toMatch(/const BUILD_INFO = null;/);
  });

  it('幂等：写两遍与写一遍相同，只替换标记之间', () => {
    const src = readFileSync(REPO_VERSION_JS, 'utf-8');
    const once = bi.injectBuildInfo(src, info);
    expect(bi.injectBuildInfo(once, info)).toBe(once);
    expect(once.replace(/const BUILD_INFO = .*;/, 'const BUILD_INFO = null;')).toBe(src);
    // 第二次换成别的 target（正式站 build 后双跑再 build）→ 只剩新的一份
    const twice = bi.injectBuildInfo(once, { ...info, target: 'ssr-test' });
    expect(twice.match(/^const BUILD_INFO = /gm)).toHaveLength(1);
    expect(twice).toContain('"target":"ssr-test"');
  });

  it('标记缺失返回 null；writeBuildInfo 遇到则报错（不许静默产出无版本的接口）', () => {
    expect(bi.injectBuildInfo('const x = 1;', info)).toBeNull();
    const root = mkdtempSync(join(tmpdir(), 'bi-'));
    mkdirSync(join(root, 'edge-functions/api'), { recursive: true });
    mkdirSync(join(root, 'nextjs'));
    writeFileSync(join(root, 'edge-functions/api/version.js'), 'export const x = 1;');
    expect(() => bi.writeBuildInfo(join(root, 'nextjs'), info)).toThrow(/标记区/);
  });

  it('两份 version.js（仓库根＋nextjs/edge-functions 拷贝）都写，缺哪份跳哪份', () => {
    const root = mkdtempSync(join(tmpdir(), 'bi-'));
    mkdirSync(join(root, 'edge-functions/api'), { recursive: true });
    mkdirSync(join(root, 'nextjs'));
    copyFileSync(REPO_VERSION_JS, join(root, 'edge-functions/api/version.js'));
    expect(bi.writeBuildInfo(join(root, 'nextjs'), info)).toHaveLength(1);
    mkdirSync(join(root, 'nextjs/edge-functions/api'), { recursive: true });
    copyFileSync(REPO_VERSION_JS, join(root, 'nextjs/edge-functions/api/version.js'));
    expect(bi.writeBuildInfo(join(root, 'nextjs'), info)).toHaveLength(2);
    for (const f of ['edge-functions/api/version.js', 'nextjs/edge-functions/api/version.js']) {
      expect(readFileSync(join(root, f), 'utf-8')).toContain(`"web":"${SHA}"`);
    }
  });

  it('写进去之后仍是可 import 的模块，/api/version 回的就是写进去的那份', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bi-'));
    const f = join(dir, 'version.js');
    writeFileSync(f, bi.injectBuildInfo(readFileSync(REPO_VERSION_JS, 'utf-8'), info));
    const realFetch = globalThis.fetch;
    const fake = okFetch(POINTER);
    globalThis.fetch = fake as unknown as typeof fetch;
    try {
      const mod = await import(f);
      const res: Response = await mod.onRequestGet();
      const j = await res.json();
      expect(j).toMatchObject({ web: SHA, bimUi: '0.9.8', data: '501935e5be70', builtAt: info.builtAt, target: 'staging' });
      expect(fake.calls[0]).toMatch(/^https:\/\/data\.kaiyuanguji\.com\/staging\/latest\.json\?cb=/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('GET /api/version', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let v: any;
  beforeAll(async () => {
    v = await import('../../../../edge-functions/api/version.js');
  });

  const info = { web: SHA, bimUi: '0.9.8', builtAt: '2026-09-28T00:00:00.000Z', target: 'production', dataBase: 'https://data.kaiyuanguji.com' };

  it('回 web／bimUi／data／builtAt／target，数据指针只转出白名单字段', async () => {
    const f = okFetch(POINTER);
    const body = await v.buildVersionBody(info, f);
    expect(body).toMatchObject({ web: SHA, bimUi: '0.9.8', data: '501935e5be70', builtAt: info.builtAt, target: 'production', webMatchesPointer: true });
    expect(body.dataPointer.somethingElse).toBeUndefined();
    expect(f.calls[0]).toMatch(/^https:\/\/data\.kaiyuanguji\.com\/latest\.json\?cb=/);
  });

  it('dataBase 被篡改成别的地址也只读自家数据域名', async () => {
    const f = okFetch(POINTER);
    await v.buildVersionBody({ ...info, dataBase: 'http://169.254.169.254' }, f);
    expect(f.calls[0]).toMatch(/^https:\/\/data\.kaiyuanguji\.com\/latest\.json/);
  });

  it('数据指针读不到：data=null＋dataError，接口本身不挂', async () => {
    const body = await v.buildVersionBody(info, async () => { throw new Error('boom'); });
    expect(body.data).toBeNull();
    expect(body.web).toBe(SHA);
    expect(body.dataError).toMatch(/boom/);
    const body2 = await v.buildVersionBody(info, async () => ({ ok: false, status: 404 }));
    expect(body2.dataError).toMatch(/404/);
  });

  it('代码指针 web.json（overview#470 P1）：读到就转出三个字段；读不到是 null，不算错误', async () => {
    const WEB = { webCommitId: SHA, deployedAt: '2026-10-07T01:00:00.000Z', runId: '9', secret: 'no' };
    const f = async (url: string) => {
      const json = url.includes('/web.json') ? WEB : POINTER;
      return { ok: true, status: 200, json: async () => json } as unknown as Response;
    };
    const body = await v.buildVersionBody(info, f);
    expect(body.webPointer).toEqual({ webCommitId: SHA, deployedAt: '2026-10-07T01:00:00.000Z', runId: '9' });
    const g = async (url: string) => (url.includes('/web.json')
      ? ({ ok: false, status: 404 } as unknown as Response)
      : ({ ok: true, status: 200, json: async () => POINTER } as unknown as Response));
    const body2 = await v.buildVersionBody(info, g);
    expect(body2.webPointer).toBeNull();
    expect(body2.dataError).toBeUndefined();
    expect(body2.webMatchesPointer).toBe(true);
  });

  it('web.json 里的 webCommitId 不是 40 位小写 commit：当作没有（null）', async () => {
    for (const bad of ['abc', 'A'.repeat(40), `${SHA}0`, 'not-a-sha']) {
      const f = async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('/web.json') ? { webCommitId: bad } : POINTER) } as unknown as Response);
      const body = await v.buildVersionBody(info, f);
      expect(body.webPointer).toBeNull();
    }
  });

  it('两个指针同时发出，不是读完一个再读下一个（超时不叠加）', async () => {
    const started: string[] = [];
    const f = (url: string) => {
      started.push(url.includes('/web.json') ? 'web' : 'latest');
      return new Promise<Response>(() => { /* 一直不返回，模拟卡住 */ });
    };
    jest.useFakeTimers();
    try {
      const p = v.buildVersionBody(info, f);
      await Promise.resolve();
      expect(started.sort()).toEqual(['latest', 'web']);
      jest.advanceTimersByTime(3100);
      const body = await p;
      expect(body.webPointer).toBeNull();
      expect(body.dataError).toMatch(/timeout/);
    } finally { jest.useRealTimers(); }
  });

  it('仓库里未构建的那份：web=null、target=unknown、带说明', async () => {
    const body = await v.buildVersionBody(null, okFetch(POINTER));
    expect(body).toMatchObject({ web: null, bimUi: null, target: 'unknown', data: '501935e5be70' });
    expect(body.note).toMatch(/未写入/);
  });

  it('响应头 no-store、公开；回包里没有任何 token／secret 字样', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = okFetch(POINTER) as unknown as typeof fetch;
    try {
      const res: Response = await v.onRequestGet({ request: new Request('https://x/api/version'), env: { ERROR_VIEW_TOKEN: 'sekrit-value-123' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toMatch(/no-store/);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const text = await res.text();
      expect(text).not.toMatch(/sekrit|token|secret/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
