// W2-3（31 卡 §A.6）：发版后按改动精确失效条目页。
//
// 文件名带 .ssr：只在全栈构建（测试站）里存在。deploy.yml 在测试站部署后，
// 用 item-changes.mjs 算出的改动 id 调本接口；这里对每个 id 调 revalidatePath。
// EdgeOne Pages 的全栈项目把 Next 的按需失效接到了自家 CDN（响应头里的 Cache-Tag／
// durable 即此），所以不经 zone purge 也能让 CDN 上的这一页换新——测试站域名
// 不是 zone 的加速域名，purge_url 清不到它（T1 首跑实测）。
// 是否真的在 5 分钟内生效，由 deploy.yml 的实测步骤（item-cache-verify.mjs）每次发版量。
//
// 鉴权：请求头 x-kyg-revalidate 须等于构建期注入的 KYG_REVALIDATE_SECRET
// （CI 由 EDGEONE_API_TOKEN 派生，不需要另建 secret）。没注入就一律 503。
import { timingSafeEqual } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { isValidItemId } from '@/lib/item-id';

export const dynamic = 'force-dynamic';

const MAX_IDS = 5000;

function authorized(given: string | null): boolean {
    const secret = process.env.KYG_REVALIDATE_SECRET || '';
    if (!secret || !given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
    if (!process.env.KYG_REVALIDATE_SECRET) {
        return NextResponse.json({ error: '本构建没有注入 KYG_REVALIDATE_SECRET' }, { status: 503 });
    }
    if (!authorized(req.headers.get('x-kyg-revalidate'))) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
    let body: { ids?: unknown; all?: unknown; read?: unknown };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: '请求体不是 JSON' }, { status: 400 });
    }
    // 阅读页（ISR，overview#322）：首屏随页面带着 manifest、目录与首章，文本改动不一定体现在条目改动集里，
    // 所以每次发版整体失效一次，不逐条
    if (body.read === true) revalidatePath('/read/[id]/[[...seg]]', 'page');
    // 大宗批量修改（改动超过阈值）时整体失效所有条目页，而不是逐条
    if (body.all === true) {
        revalidatePath('/item/[id]', 'page');
        return NextResponse.json({ all: true, read: body.read === true });
    }
    if (body.read === true && body.ids === undefined) return NextResponse.json({ read: true });
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length > MAX_IDS) {
        return NextResponse.json({ error: `一次最多 ${MAX_IDS} 条，超过请用 all` }, { status: 413 });
    }
    const valid = ids.filter(isValidItemId);
    for (const id of valid) revalidatePath(`/item/${id}`);
    return NextResponse.json({ revalidated: valid.length, skipped: ids.length - valid.length });
}
