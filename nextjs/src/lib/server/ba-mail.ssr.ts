// 发信：Resend REST（RESEND_API_KEY、MAIL_FROM）。没配密钥时只记日志不发（测试站联调用）。
export async function sendLoginMail(to: string, url: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'open-guji <login@mail.openguji.com>';
  if (!key) { console.log('[ba] no RESEND_API_KEY, link not sent'); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to,
      subject: '开放古籍 登录链接',
      text: `点击下面的链接登录开放古籍（10 分钟内有效，只能用一次）：\n\n${url}\n\n不是你本人操作请忽略这封邮件。`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`mail HTTP ${res.status}`);
}
