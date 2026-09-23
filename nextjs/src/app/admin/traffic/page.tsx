export const metadata = { robots: { index: false, follow: false } };
export default function AdminTrafficPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">流量</h1>
      <div className="bg-white rounded border p-8 text-center text-sm text-gray-500">
        占位页面，后续展示访问日志与来源分布（不挡本期）。
      </div>
    </div>
  );
}
