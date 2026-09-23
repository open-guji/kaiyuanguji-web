export const metadata = { robots: { index: false, follow: false } };
export default function AdminFeedbackPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">反馈</h1>
      <div className="bg-white rounded border p-8 text-center text-sm text-gray-500">
        占位页面，后续接入 <code>GET /api/feedback</code> 处置流（双轨已支持）。
      </div>
    </div>
  );
}
