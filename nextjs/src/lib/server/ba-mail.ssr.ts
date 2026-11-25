// 发信：默认腾讯云邮件推送（SES，API 3.0 的 SendEmail，TC3-HMAC-SHA256 签名）；
// MAIL_PROVIDER=tencent（默认）｜resend｜log。没配密钥时只记日志不发（测试站联调用）。
import { createHash, createHmac } from 'node:crypto';

const SUBJECT = '开源古籍 登录链接';
const bodyText = (url: string) => `点击下面的链接登录开源古籍（10 分钟内有效，只能用一次）：\n\n${url}\n\n不是你本人操作请忽略这封邮件。`;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

/** 腾讯云 API 3.0 签名（TC3-HMAC-SHA256）。导出给单测。 */
export function tc3Headers(o: { secretId: string; secretKey: string; service: string; host: string; action: string; version: string; region: string; payload: string; timestamp: number }) {
  const date = new Date(o.timestamp * 1000).toISOString().slice(0, 10);
  const ct = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${ct}\nhost:${o.host}\nx-tc-action:${o.action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(o.payload)].join('\n');
  const scope = `${date}/${o.service}/tc3_request`;
  const toSign = ['TC3-HMAC-SHA256', String(o.timestamp), scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(`TC3${o.secretKey}`, date), o.service), 'tc3_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${o.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': ct,
    Host: o.host,
    'X-TC-Action': o.action,
    'X-TC-Timestamp': String(o.timestamp),
    'X-TC-Version': o.version,
    'X-TC-Region': o.region,
  };
}

async function sendTencent(to: string, url: string) {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  const from = process.env.MAIL_FROM; // 必须是控制台里已验证发信域名下的地址，格式「别名 <地址>」，别名不能含冒号
  const templateId = Number(process.env.TENCENT_SES_TEMPLATE_ID); // 腾讯云邮件推送只能用模板发信（Simple 已废弃）；模板正文里用 {{url}}
  if (!secretId || !secretKey || !from || !Number.isInteger(templateId) || templateId <= 0) { console.log('[ba] 腾讯云邮件推送密钥、MAIL_FROM 或 TENCENT_SES_TEMPLATE_ID 未配，链接不发送'); return; }
  const host = 'ses.tencentcloudapi.com';
  const payload = JSON.stringify({
    FromEmailAddress: from,
    Destination: [to],
    Subject: SUBJECT,
    Template: { TemplateID: templateId, TemplateData: JSON.stringify({ url }) },
    TriggerType: 1, // 触发类（验证码／登录链接这类即时邮件）
  });
  const headers = tc3Headers({ secretId, secretKey, service: 'ses', host, action: 'SendEmail', version: '2020-10-02', region: process.env.TENCENT_SES_REGION || 'ap-guangzhou', payload, timestamp: Math.floor(Date.now() / 1000) });
  const res = await fetch(`https://${host}/`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(8000) });
  const j = (await res.json().catch(() => null)) as { Response?: { Error?: { Code: string; Message: string } } } | null;
  if (!res.ok || j?.Response?.Error) throw new Error(`mail tencent ${res.status} ${j?.Response?.Error?.Code || ''}`);
}

async function sendResend(to: string, url: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) { console.log('[ba] RESEND_API_KEY／MAIL_FROM 未配，链接不发送'); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject: SUBJECT, text: bodyText(url) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`mail resend ${res.status}`);
}

export async function sendLoginMail(to: string, url: string): Promise<void> {
  const p = process.env.MAIL_PROVIDER || 'tencent';
  if (p === 'resend') return sendResend(to, url);
  if (p === 'log') { console.log('[ba] MAIL_PROVIDER=log，不发信'); return; }
  return sendTencent(to, url);
}
