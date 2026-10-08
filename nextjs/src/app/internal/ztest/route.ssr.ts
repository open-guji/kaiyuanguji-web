// 临时探针（overview#487，只在 exp/fn-compress-probe 分支、只部署测试站；不进任何要合并的 PR）。
// 同一份 ~30 KB 文本，按 ?mode= 返回：plain（不压）、gzip／br（Node 里自己压并带 Content-Encoding）。
// 另把函数实际看到的 Accept-Encoding 回在 X-Seen-AE 头里：看网关有没有在到函数之前改写它。
import { NextResponse, type NextRequest } from 'next/server';
import { gzipSync, brotliCompressSync } from 'node:zlib';

export const dynamic = 'force-dynamic';

const BODY = Array.from({ length: 700 }, (_, i) => `{"id":"d59f${i.toString(36).padStart(8, '0')}","title":"史記${i}","author":"司馬遷","dynasty":"西漢"}`).join(',\n');

export async function GET(req: NextRequest) {
    const mode = new URL(req.url).searchParams.get('mode') || 'plain';
    const base: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Vary': 'Accept-Encoding',
        'X-Seen-AE': req.headers.get('accept-encoding') ?? '(none)',
        'X-Probe-Mode': mode,
    };
    const raw = Buffer.from(BODY, 'utf-8');
    if (mode === 'gzipc') {
        // 带 CDN 缓存头的 gzip：看缓存命中时不同 Accept-Encoding 的客户端各拿到什么
        const z = gzipSync(raw);
        return new NextResponse(z, { status: 200, headers: { ...base, 'Cache-Control': 'public, s-maxage=600', 'Content-Encoding': 'gzip', 'Content-Length': String(z.byteLength) } });
    }
    if (mode === 'plainc') {
        return new NextResponse(raw, { status: 200, headers: { ...base, 'Cache-Control': 'public, s-maxage=600', 'Content-Length': String(raw.byteLength) } });
    }
    if (mode === 'gzip') {
        const z = gzipSync(raw);
        return new NextResponse(z, { status: 200, headers: { ...base, 'Content-Encoding': 'gzip', 'Content-Length': String(z.byteLength) } });
    }
    if (mode === 'br') {
        const z = brotliCompressSync(raw);
        return new NextResponse(z, { status: 200, headers: { ...base, 'Content-Encoding': 'br', 'Content-Length': String(z.byteLength) } });
    }
    return new NextResponse(raw, { status: 200, headers: { ...base, 'Content-Length': String(raw.byteLength) } });
}
