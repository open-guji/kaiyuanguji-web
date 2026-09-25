// G-25 试验：量云函数出口在哪、回源取数多慢。试验分支专用。
export const dynamic = 'force-dynamic';

async function timed(url: string) {
  const t = Date.now();
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const body = await r.text();
    return { status: r.status, ms: Date.now() - t, bytes: body.length, body: body.slice(0, 300) };
  } catch (e) {
    return { error: String(e), ms: Date.now() - t };
  }
}

export async function GET() {
  const [ip, entry, meili] = await Promise.all([
    timed('https://ipinfo.io/json'),
    timed(`https://data.kaiyuanguji.com/current/entry/d59f2mp0quip.json?cb=${Date.now()}`),
    timed('https://api.kaiyuanguji.com/health'),
  ]);
  return Response.json({
    now: new Date().toISOString(),
    node: process.version,
    region: process.env.TENCENTCLOUD_REGION || process.env.REGION || null,
    envKeys: Object.keys(process.env).filter((k) => /REGION|ZONE|EO_|TENCENT|SCF/i.test(k)),
    ip: ip.body, entry: { ...entry, body: undefined }, meili: { ...meili, body: undefined },
  });
}
