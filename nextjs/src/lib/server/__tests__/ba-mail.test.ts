/**
 * @jest-environment node
 */
import { tc3Headers } from '../ba-mail.ssr';

describe('腾讯云 TC3 签名', () => {
  const base = { secretId: 'AKIDtest', secretKey: 'key', service: 'ses', host: 'ses.tencentcloudapi.com', action: 'SendEmail', version: '2020-10-02', region: 'ap-hongkong', payload: '{"a":1}', timestamp: 1700000000 };
  test('结构与确定性', () => {
    const h = tc3Headers(base);
    expect(h.Authorization).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDtest\/2023-11-14\/ses\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/);
    expect(tc3Headers(base).Authorization).toBe(h.Authorization);
    expect(h['X-TC-Action']).toBe('SendEmail');
    expect(h['X-TC-Version']).toBe('2020-10-02');
  });
  test('载荷变了签名就变', () => {
    expect(tc3Headers({ ...base, payload: '{"a":2}' }).Authorization).not.toBe(tc3Headers(base).Authorization);
  });
});

describe('腾讯云只能用模板发信', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; (global as any).fetch = undefined; });
  test('请求体带 Template，不带 Simple', async () => {
    Object.assign(process.env, { MAIL_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'k', MAIL_FROM: 'a <b@c.d>', TENCENT_SES_TEMPLATE_ID: '123' });
    const seen: any[] = [];
    (global as any).fetch = jest.fn(async (_u: string, init: any) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ Response: {} }) }; });
    const { sendLoginMail } = await import('../ba-mail.ssr');
    await sendLoginMail('x@y.z', 'https://s/api/ba/magic-link/verify?token=abcdefghijklmnopqrstuvwxyz012345&callbackURL=%2F');
    expect(seen[0].Template).toEqual({ TemplateID: 123, TemplateData: '{"url":"api/ba/magic-link/verify?token=abcdefghijklmnopqrstuvwxyz012345&callbackURL=%2F"}' });
    expect(seen[0].Simple).toBeUndefined();
    expect(seen[0].Destination).toEqual(['x@y.z']);
  });
  test('没配模板 ID 不发', async () => {
    Object.assign(process.env, { MAIL_PROVIDER: 'tencent', TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'k', MAIL_FROM: 'a <b@c.d>' });
    delete process.env.TENCENT_SES_TEMPLATE_ID;
    (global as any).fetch = jest.fn();
    const { sendLoginMail } = await import('../ba-mail.ssr');
    await sendLoginMail('x@y.z', 'u');
    expect((global as any).fetch).not.toHaveBeenCalled();
  });
});
