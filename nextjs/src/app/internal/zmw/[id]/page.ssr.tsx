// 临时探针（overview#487，只在 exp/fn-compress-probe 分支、只部署测试站；不进任何要合并的 PR）。
// 与 zpage 完全相同，唯一差别：路径 /internal/zmw/:id 被中间件 matcher 命中（middleware 只 NextResponse.next()）。
// 用来判断 /item/* 不被边缘压缩，是不是因为请求经过了 Next 中间件。
export const revalidate = 3600;
export const dynamicParams = true;

export async function generateStaticParams(): Promise<{ id: string }[]> {
    return [];
}

const ROWS = Array.from({ length: 700 }, (_, i) => `d59f${i.toString(36).padStart(8, '0')} 史記${i} 司馬遷 西漢`);

export default async function ZPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <main>
            <h1>zmw {id}</h1>
            <ul>
                {ROWS.map((r) => (
                    <li key={r}>{r}</li>
                ))}
            </ul>
        </main>
    );
}
