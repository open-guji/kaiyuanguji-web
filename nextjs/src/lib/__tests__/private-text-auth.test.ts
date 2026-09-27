/**
 * @jest-environment node
 *
 * P1-私有文本后端 /api/private-text 的鉴权闸。
 * 覆盖任务卡完成判据点名的四条：未登录 401／reviewer 403／internal 200／缺配置 503。
 */

class MockKV {
  m = new Map<string, unknown>();
  async put(k: string, v: unknown) { this.m.set(k, v); }
  async get(k: string) { return this.m.has(k) ? this.m.get(k) : null; }
}

const JWT_SECRET = 'test-jwt-secret-32bytes-long-1234567890';

function b64url(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function signJWT(payload: Record<string, unknown>, secret: string) {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

function ctx(url: string, env: Record<string, unknown>, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return { request: new Request(url, { headers }), env, params: { path: ['Work', 'q', '4', 'g', 'd59ezak6jq4g', 'full_text', 'shidian-01', '001.md'] } };
}
async function jsonBody(res: Response) { return JSON.parse(await res.text()); }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
let kv: MockKV;
const baseEnv = () => ({
  AUTH_JWT_SECRET: JWT_SECRET,
  AUTH_KV: kv,
  PRIVATE_COS_READ_SECRET_ID: 'ak-test',
  PRIVATE_COS_READ_SECRET_KEY: 'sk-test',
  PRIVATE_COS_BUCKET: 'test-bucket',
  PRIVATE_COS_REGION: 'ap-singapore',
});

const originalFetch = global.fetch;

beforeAll(async () => {
  fn = await import('../../../../edge-functions/api/private-text/[[path]].js');
});
beforeEach(() => {
  kv = new MockKV();
  global.fetch = jest.fn(async () => new Response('# 春秋序\n\n春秋序……', {
    status: 200,
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe('未登录', () => {
  it('无 session cookie → 401', async () => {
    const res = await fn.onRequestGet(ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md', baseEnv()));
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).success).toBe(false);
  });

  it('session cookie 签名不对 → 401', async () => {
    const res = await fn.onRequestGet(
      ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md', baseEnv(), 'session=not-a-real-jwt'),
    );
    expect(res.status).toBe(401);
  });
});

describe('角色不符', () => {
  it('reviewer 登录 → 403', async () => {
    await kv.put('member:reviewer@example.com', { role: 'reviewer', joinedAt: 1 });
    const session = await signJWT({ sub: 'reviewer@example.com', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const res = await fn.onRequestGet(
      ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md', baseEnv(), `session=${session}`),
    );
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).success).toBe(false);
  });

  it('editor 登录 → 403（同 reviewer，非 internal/admin 一律拦）', async () => {
    await kv.put('member:editor@example.com', { role: 'editor', joinedAt: 1 });
    const session = await signJWT({ sub: 'editor@example.com', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const res = await fn.onRequestGet(
      ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md', baseEnv(), `session=${session}`),
    );
    expect(res.status).toBe(403);
  });
});

describe('internal 角色', () => {
  it('internal 登录 → 200，原样转发 COS 内容', async () => {
    await kv.put('member:staff@example.com', { role: 'internal', joinedAt: 1 });
    const session = await signJWT({ sub: 'staff@example.com', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const res = await fn.onRequestGet(
      ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md', baseEnv(), `session=${session}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.text()).toContain('春秋序');
    // 校验签名请求确实带上了预期的 COS 对象路径与鉴权头
    const fetchMock = global.fetch as jest.Mock;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toContain('test-bucket.cos.ap-singapore.myqcloud.com');
    expect(calledUrl).toContain('/private/book-text-private/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md');
    expect(calledInit.headers.Authorization).toMatch(/^q-sign-algorithm=sha1&q-ak=ak-test&/);
  });

  it('admin 登录同样放行（角色白名单含 admin）', async () => {
    await kv.put('member:boss@example.com', { role: 'admin', joinedAt: 1 });
    const session = await signJWT({ sub: 'boss@example.com', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const res = await fn.onRequestGet(
      ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md', baseEnv(), `session=${session}`),
    );
    expect(res.status).toBe(200);
  });
});

describe('缺配置', () => {
  it('未配置 AUTH_JWT_SECRET → 503', async () => {
    const env = baseEnv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (env as any).AUTH_JWT_SECRET;
    const res = await fn.onRequestGet(ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md', env));
    expect(res.status).toBe(503);
  });

  it('已登录 internal，但私有 COS 凭据未配置 → 503（不会误判成 401/403）', async () => {
    await kv.put('member:staff2@example.com', { role: 'internal', joinedAt: 1 });
    const session = await signJWT({ sub: 'staff2@example.com', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const env = baseEnv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (env as any).PRIVATE_COS_READ_SECRET_KEY;
    const res = await fn.onRequestGet(
      ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/001.md', env, `session=${session}`),
    );
    expect(res.status).toBe(503);
  });
});

describe('路径与上游边界', () => {
  it('路径含 .. 上跳段 → 400，且不会去请求 COS', async () => {
    await kv.put('member:staff3@example.com', { role: 'internal', joinedAt: 1 });
    const session = await signJWT({ sub: 'staff3@example.com', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const c = ctx('https://x/api/private-text/../../etc/passwd', baseEnv(), `session=${session}`);
    c.params = { path: ['..', '..', 'etc', 'passwd'] };
    const res = await fn.onRequestGet(c);
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 09-27 00:45Z 协调者验收第一轮：原实现在解码前查 `..`，这四条编码变体都能绕过去。
  describe('编码过的上跳/越权字符，解码后才现形 → 400', () => {
    async function internalCtx(pathSegments: string[]) {
      await kv.put('member:staff-enc@example.com', { role: 'internal', joinedAt: 1 });
      const session = await signJWT(
        { sub: 'staff-enc@example.com', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 },
        JWT_SECRET,
      );
      const c = ctx('https://x/api/private-text/x', baseEnv(), `session=${session}`);
      c.params = { path: pathSegments };
      return c;
    }

    it('%2e%2e（编码后的 ..）→ 400', async () => {
      const res = await fn.onRequestGet(await internalCtx(['%2e%2e', 'etc', 'passwd']));
      expect(res.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('a%2F..%2Fb（段内编码斜杠，解码后炸出 .. ）→ 400', async () => {
      const res = await fn.onRequestGet(await internalCtx(['a%2F..%2Fb']));
      expect(res.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('%5c（编码后的反斜杠）→ 400', async () => {
      const res = await fn.onRequestGet(await internalCtx(['%5c..%5cetc']));
      expect(res.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('%zz（非法转义序列，decodeURIComponent 会抛错）→ 400', async () => {
      const res = await fn.onRequestGet(await internalCtx(['%zz']));
      expect(res.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  it('COS 对象不存在 → 404', async () => {
    global.fetch = jest.fn(async () => new Response('NoSuchKey', { status: 404 })) as unknown as typeof fetch;
    await kv.put('member:staff4@example.com', { role: 'internal', joinedAt: 1 });
    const session = await signJWT({ sub: 'staff4@example.com', iat: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET);
    const res = await fn.onRequestGet(
      ctx('https://x/api/private-text/Work/q/4/g/d59ezak6jq4g/full_text/shidian-01/999.md', baseEnv(), `session=${session}`),
    );
    expect(res.status).toBe(404);
  });
});
