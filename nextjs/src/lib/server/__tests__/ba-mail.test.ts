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
