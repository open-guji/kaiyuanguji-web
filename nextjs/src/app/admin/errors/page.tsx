export const metadata = { robots: { index: false, follow: false } };
export default function AdminErrorsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">错误日志</h1>
      <div className="bg-white rounded border p-8 text-center text-sm text-gray-500">
        占位页面，后续搬入 <code>/toolkit/errors</code> 并接入 <code>GET /api/track-error</code> 双轨鉴权。
      </div>
    </div>
  );
}
