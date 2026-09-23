export default function AdminOverviewPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">总览</h1>
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded border p-4">
          <div className="text-xs text-gray-500">待处理错误</div>
          <div className="text-2xl font-mono mt-1">—</div>
          <div className="text-xs text-gray-400 mt-1">接入后显示 /admin/errors</div>
        </div>
        <div className="bg-white rounded border p-4">
          <div className="text-xs text-gray-500">待回复反馈</div>
          <div className="text-2xl font-mono mt-1">—</div>
          <div className="text-xs text-gray-400 mt-1">接入后显示 /admin/feedback</div>
        </div>
        <div className="bg-white rounded border p-4">
          <div className="text-xs text-gray-500">待使用邀请</div>
          <div className="text-2xl font-mono mt-1">—</div>
          <div className="text-xs text-gray-400 mt-1">见 /admin/invites</div>
        </div>
      </div>
      <div className="bg-white rounded border p-4 text-sm text-gray-600">
        <p>探活最近结果与服务器心跳待接入（与现有 health-check 看板复用）。</p>
        <p className="text-xs text-gray-400 mt-1">本期仅提供空页面占位，后续按需填充。</p>
      </div>
    </div>
  );
}
