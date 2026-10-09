// 临时探针（overview#487，只在 exp/fn-compress-probe 分支、只部署测试站；不进任何要合并的 PR）。
// 与 /item/[id] 同形：Next 的 ISR 页面（revalidate=3600、generateStaticParams 为空、dynamicParams），
// 渲染 ~58 KB 的文本，用来对比“同样的响应头，页面（ISR）会不会被边缘压缩，而 route handler 会”。
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
            <h1>zpage {id}</h1>
            <ul>
                {ROWS.map((r) => (
                    <li key={r}>{r}</li>
                ))}
            </ul>
        </main>
    );
}
