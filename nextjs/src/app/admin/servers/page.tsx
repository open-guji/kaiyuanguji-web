export const metadata = { robots: { index: false, follow: false } };
export default function AdminServersPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">服务器</h1>
      <div className="bg-white rounded border p-8 text-center text-sm text-gray-500">
        占位页面，待接入 Meili / COS / EdgeOne 探活历史（与 <code>health-check</code> 复用）。
      </div>
    </div>
  );
}
