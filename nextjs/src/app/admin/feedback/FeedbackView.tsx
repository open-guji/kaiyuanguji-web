'use client';

// 反馈处置（21 第 3 步；G-23 第一批加隐藏／测试标记／联系方式；第二批补改类型／改状态／标重复／
// contact 单独页签／多维筛选／pageUrl 域名过滤）。
// 读 GET /api/feedback：带成员 cookie 时后端返回全量原样（含已隐藏、测试、contact），
// 改状态／改类型／写回复／隐藏／标重复走 POST action:'update'（成员 cookie）。
import { useEffect, useMemo, useState } from 'react';
import { fetchAllPages } from '../fetchAll';
import { isSameSiteUrl } from '../../../lib/pageUrl';
import {
  ASSIGNEE_LABEL, ASSIGNEE_OPTIONS, CATEGORY_OPTIONS, categoryOf, fmtDuration, isClaimOverdue, slaStats,
} from '../../../lib/feedbackTriage';

interface FeedbackRecord {
  id: string;
  type: 'bug' | 'resource' | 'suggestion' | 'contact' | 'other' | string;
  content: string;
  pageUrl?: string;
  resourceId?: string;
  createdAt: string;
  updatedAt?: string;
  updatedBy?: string;
  status: 'pending' | 'in_progress' | 'resolved' | 'wontfix' | 'duplicate' | string;
  reply?: string;
  visibility?: 'public' | 'hidden';
  test?: boolean;
  contact?: string;
  duplicateOf?: string;
  category?: string;
  assignee?: string;
  claimedAt?: string;
  routedIssue?: string;
  subtype?: string;
  resolvedRef?: string;
}

type Patch = {
  status?: string; reply?: string; visibility?: 'public' | 'hidden'; test?: boolean;
  type?: string; duplicateOf?: string; category?: string; assignee?: string;
  resolvedRef?: string;
};

// 与 edge-functions/api/feedback.js 的 RE_RESOLVED_REF 一致：`owner/repo@sha`（7～40 位十六进制）或 `owner/repo#n`
const RE_RESOLVED_REF = /^[\w.-]+\/[\w.-]+(?:@[0-9a-f]{7,40}|#\d+)$/;
// 已结的状态：不算「待处理」，也不再提供「标记已改」
const CLOSED_STATUSES = new Set(['resolved', 'wontfix', 'duplicate']);
const SUBTYPE_LABEL: Record<string, string> = { char: '错字', punct: '标点', name: '专名', version: '版本不对' };

// 与 edge-functions/api/feedback.js 的 ALLOWED_TYPES／ALLOWED_STATUSES 保持一致
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'bug', label: '错误' },
  { value: 'resource', label: '资源' },
  { value: 'suggestion', label: '建议' },
  { value: 'contact', label: '想参与/联系' },
  { value: 'other', label: '其他' },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label]));

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'pending', label: '待处理' },
  { value: 'in_progress', label: '处理中' },
  { value: 'resolved', label: '已解决' },
  { value: 'wontfix', label: '不采纳' },
  { value: 'duplicate', label: '重复' },
];
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.value, o.label]));

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export default function FeedbackView() {
  const [items, setItems] = useState<FeedbackRecord[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [tab, setTab] = useState<'feedback' | 'contact'>('feedback');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [visibilityFilter, setVisibilityFilter] = useState('all');
  const [testFilter, setTestFilter] = useState<'hide' | 'show' | 'only'>('hide');

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dupPickerFor, setDupPickerFor] = useState('');
  const [dupTarget, setDupTarget] = useState('');
  const [savingId, setSavingId] = useState('');
  // 「标记已改」面板（G4）：哪条在填、已改还是不采纳、回复与处理凭据草稿
  const [doneFor, setDoneFor] = useState('');
  const [doneMode, setDoneMode] = useState<'resolved' | 'wontfix'>('resolved');
  const [doneReply, setDoneReply] = useState('');
  const [doneRef, setDoneRef] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const r = await fetchAllPages<FeedbackRecord>('/api/feedback', 100);
      r.items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setItems(r.items);
      setTruncated(r.truncated);
      setDrafts({});
    } catch (e: any) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function update(id: string, patch: Patch): Promise<boolean> {
    setSavingId(id);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'update', id, ...patch }),
      });
      const data = await res.json();
      if (!data.success) { alert(data.error || '操作失败'); return false; }
      setItems((prev) => prev.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, ...patch };
        // claimedAt 由服务端写：以返回的记录为准（清空认领时两者都没有）
        if (patch.assignee !== undefined) {
          next.assignee = data.item?.assignee || undefined;
          next.claimedAt = data.item?.claimedAt || undefined;
        }
        return next;
      }));
      if (patch.reply !== undefined) {
        setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
      }
      if (patch.duplicateOf !== undefined) { setDupPickerFor(''); setDupTarget(''); }
      return true;
    } catch {
      alert('网络错误');
      return false;
    } finally {
      setSavingId('');
    }
  }

  function openDone(it: FeedbackRecord) {
    setDoneFor(it.id);
    setDoneMode('resolved');
    setDoneReply(it.reply || '');
    setDoneRef(it.resolvedRef || '');
  }

  /** 缺回复、已改缺处理凭据、凭据格式不对时返回错误文案；通过返回 '' */
  function doneError(): string {
    if (!doneReply.trim()) return doneMode === 'wontfix' ? '不采纳须写理由（会公开显示）' : '请写一句给读者看的回复（会公开显示）';
    const ref = doneRef.trim();
    if (doneMode === 'resolved' && !ref) return '请填处理凭据：owner/repo@提交号 或 owner/repo#编号';
    if (ref && !RE_RESOLVED_REF.test(ref)) return '处理凭据格式应为 owner/repo@提交号（7～40 位十六进制）或 owner/repo#编号';
    return '';
  }

  async function submitDone(id: string) {
    if (doneError()) return;
    const ref = doneRef.trim();
    const ok = await update(id, { status: doneMode, reply: doneReply.trim(), ...(ref ? { resolvedRef: ref } : {}) });
    if (ok) setDoneFor('');
  }

  const real = useMemo(() => items.filter((i) => !i.test), [items]);
  const contactItems = useMemo(() => items.filter((i) => i.type === 'contact'), [items]);
  const mainItems = useMemo(() => items.filter((i) => i.type !== 'contact'), [items]);
  const pendingCount = useMemo(() => real.filter((i) => !CLOSED_STATUSES.has(i.status)).length, [real]);
  const testCount = items.length - real.length;
  const hiddenCount = useMemo(() => items.filter((i) => i.visibility === 'hidden').length, [items]);

  const shown = useMemo(() => {
    const base = tab === 'contact' ? contactItems : mainItems;
    return base.filter((i) => {
      if (statusFilter !== 'all' && i.status !== statusFilter) return false;
      if (tab === 'feedback' && typeFilter !== 'all' && i.type !== typeFilter) return false;
      if (categoryFilter !== 'all' && categoryOf(i) !== categoryFilter) return false;
      if (assigneeFilter === 'none' && i.assignee) return false;
      if (assigneeFilter === 'overdue' && !isClaimOverdue(i)) return false;
      if (assigneeFilter !== 'all' && assigneeFilter !== 'none' && assigneeFilter !== 'overdue' && i.assignee !== assigneeFilter) return false;
      if (visibilityFilter !== 'all') {
        const hidden = i.visibility === 'hidden';
        if (visibilityFilter === 'hidden' && !hidden) return false;
        if (visibilityFilter === 'public' && hidden) return false;
      }
      if (testFilter === 'hide' && i.test) return false;
      if (testFilter === 'only' && !i.test) return false;
      return true;
    });
  }, [tab, contactItems, mainItems, statusFilter, typeFilter, categoryFilter, assigneeFilter, visibilityFilter, testFilter]);
  const sla = useMemo(() => slaStats(items), [items]);
  const overdueCount = sla.overdue;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">反馈</h1>
        <button onClick={load} disabled={loading} className="text-xs text-gray-500 hover:text-black">刷新</button>
      </div>
      <p className="text-xs text-gray-500">
        读者在各页提交的反馈，默认公开显示。<b>回复会随反馈一起公开。</b>
        正文里有联系方式等个人信息的，点「隐藏」即从公开列表撤下（这里仍可见）。联系方式栏只有站方看得到。
        「想参与/联系」类型永远不公开。
      </p>

      {error ? (
        <div className="bg-white rounded border p-8 text-center text-sm text-red-600">{error}</div>
      ) : loading ? (
        <div className="bg-white rounded border p-8 text-center text-sm text-gray-500">加载中…</div>
      ) : (
        <>
          {truncated && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
              记录过多，只取到了前 {items.length} 条（最旧的一批），更新的记录没有显示。
            </div>
          )}

          <div className="bg-white rounded border p-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-600" data-testid="sla-stats">
            <span>近 30 天已认领 <b className="text-black">{sla.claimed30}</b></span>
            <span>超 24h 未认领 <b className={sla.overdue ? 'text-red-700' : 'text-black'}>{sla.overdue}</b></span>
            <span>认领耗时中位数 <b className="text-black">{fmtDuration(sla.medianClaimMs)}</b></span>
          </div>

          <div className="flex gap-2 border-b text-sm">
            <button
              onClick={() => setTab('feedback')}
              className={`px-3 py-1.5 -mb-px border-b-2 ${tab === 'feedback' ? 'border-black font-medium' : 'border-transparent text-gray-500'}`}
            >
              反馈（{mainItems.length}）
            </button>
            <button
              onClick={() => setTab('contact')}
              className={`px-3 py-1.5 -mb-px border-b-2 ${tab === 'contact' ? 'border-black font-medium' : 'border-transparent text-gray-500'}`}
            >
              联系我们（{contactItems.length}）
            </button>
          </div>

          <div className="bg-white rounded border p-3 flex flex-wrap items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1">
              状态
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded px-1 py-0.5">
                <option value="all">全部</option>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {tab === 'feedback' && (
              <label className="inline-flex items-center gap-1">
                类型
                <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="border rounded px-1 py-0.5">
                  <option value="all">全部</option>
                  {TYPE_OPTIONS.filter((o) => o.value !== 'contact').map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="inline-flex items-center gap-1">
              分类
              <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className="border rounded px-1 py-0.5">
                <option value="all">全部</option>
                {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="inline-flex items-center gap-1">
              认领
              <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="border rounded px-1 py-0.5">
                <option value="all">全部</option>
                <option value="none">未认领</option>
                <option value="overdue">超时未认领（{overdueCount}）</option>
                {ASSIGNEE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="inline-flex items-center gap-1">
              是否公开
              <select value={visibilityFilter} onChange={(e) => setVisibilityFilter(e.target.value)} className="border rounded px-1 py-0.5">
                <option value="all">全部</option>
                <option value="public">公开</option>
                <option value="hidden">隐藏</option>
              </select>
            </label>
            <label className="inline-flex items-center gap-1">
              测试数据
              <select value={testFilter} onChange={(e) => setTestFilter(e.target.value as typeof testFilter)} className="border rounded px-1 py-0.5">
                <option value="hide">不显示</option>
                <option value="show">全部显示</option>
                <option value="only">只看测试（{testCount}）</option>
              </select>
            </label>
            <span className="ml-auto text-gray-500">待处理 {pendingCount} · 已隐藏 {hiddenCount} · 共 {real.length}</span>
          </div>

          {shown.length === 0 ? (
            <div className="bg-white rounded border p-8 text-center text-sm text-gray-400">无记录</div>
          ) : (
            <div className="space-y-3">
              {shown.map((it) => {
                const hidden = it.visibility === 'hidden';
                const isContact = it.type === 'contact';
                const busy = savingId === it.id;
                const draft = drafts[it.id];
                const editing = draft !== undefined;
                const pageUrlIsOwn = typeof window !== 'undefined' && isSameSiteUrl(it.pageUrl, window.location.href);
                return (
                  <div key={it.id} className={`bg-white rounded border p-4 text-[13px] ${it.status === 'resolved' ? 'opacity-70' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2.5 mb-1.5">
                      <select
                        value={it.type}
                        disabled={busy}
                        onChange={(e) => update(it.id, { type: e.target.value })}
                        className="border rounded px-1.5 py-0.5 text-xs bg-white"
                      >
                        {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        {!TYPE_LABEL[it.type] && <option value={it.type}>{it.type}（未知）</option>}
                      </select>
                      <select
                        value={it.status}
                        disabled={busy}
                        onChange={(e) => {
                          if (e.target.value === 'duplicate') { setDupPickerFor(it.id); return; }
                          update(it.id, { status: e.target.value });
                        }}
                        className="border rounded px-1.5 py-0.5 text-xs bg-white"
                      >
                        {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        {!STATUS_LABEL[it.status] && <option value={it.status}>{it.status}（未知）</option>}
                      </select>
                      <select
                        value={categoryOf(it)}
                        disabled={busy}
                        onChange={(e) => update(it.id, { category: e.target.value })}
                        aria-label="分类"
                        className="border rounded px-1.5 py-0.5 text-xs bg-white"
                      >
                        {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <select
                        value={it.assignee || ''}
                        disabled={busy}
                        onChange={(e) => update(it.id, { assignee: e.target.value })}
                        aria-label="认领块"
                        className="border rounded px-1.5 py-0.5 text-xs bg-white"
                      >
                        <option value="">未认领</option>
                        {ASSIGNEE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      {isClaimOverdue(it) && <span className="bg-red-100 text-red-800 rounded px-2 text-xs">超 24h 未认领</span>}
                      {it.assignee && it.claimedAt && (
                        <span className="text-gray-400 text-xs" title={it.claimedAt}>{ASSIGNEE_LABEL[it.assignee] || it.assignee} 于 {fmtTime(it.claimedAt)} 认领</span>
                      )}
                      {hidden && <span className="bg-gray-200 text-gray-700 rounded px-2 text-xs">已隐藏 · 不公开</span>}
                      {isContact && <span className="bg-purple-100 text-purple-800 rounded px-2 text-xs">想参与/联系 · 从不公开</span>}
                      {it.test && <span className="bg-amber-100 text-amber-800 rounded px-2 text-xs">测试</span>}
                      {it.status === 'duplicate' && it.duplicateOf && (
                        <span className="bg-gray-100 text-gray-600 rounded px-2 text-xs font-mono">重复于 {it.duplicateOf}</span>
                      )}
                      <span className="ml-auto text-gray-400">{fmtTime(it.createdAt)}</span>
                      {!isContact && !CLOSED_STATUSES.has(it.status) && (
                        <button
                          onClick={() => openDone(it)}
                          disabled={busy}
                          className="border rounded px-2.5 py-0.5 text-xs text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
                        >
                          标记已改
                        </button>
                      )}
                      {!isContact && (
                        <button
                          onClick={() => update(it.id, { visibility: hidden ? 'public' : 'hidden' })}
                          disabled={busy}
                          className="border rounded px-2.5 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        >
                          {hidden ? '恢复公开' : '隐藏'}
                        </button>
                      )}
                    </div>

                    {dupPickerFor === it.id && (
                      <div className="mb-2 flex items-center gap-2 bg-gray-50 border rounded p-2 text-xs">
                        <span>标记为下面这条的重复：</span>
                        <select value={dupTarget} onChange={(e) => setDupTarget(e.target.value)} className="border rounded px-1 py-0.5 flex-1">
                          <option value="">选择目标反馈…</option>
                          {items.filter((x) => x.id !== it.id).map((x) => (
                            <option key={x.id} value={x.id}>{x.id} · {x.content.slice(0, 24)}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => dupTarget && update(it.id, { status: 'duplicate', duplicateOf: dupTarget })}
                          disabled={!dupTarget || busy}
                          className="bg-black text-white rounded px-2 py-0.5 disabled:opacity-50"
                        >
                          确定
                        </button>
                        <button onClick={() => { setDupPickerFor(''); setDupTarget(''); }} className="text-gray-500">取消</button>
                      </div>
                    )}

                    {doneFor === it.id && (
                      <div className="mb-2 space-y-1.5 bg-gray-50 border rounded p-2 text-xs" data-testid="mark-done">
                        <div className="flex items-center gap-3">
                          <label className="inline-flex items-center gap-1">
                            <input type="radio" name={`done-${it.id}`} checked={doneMode === 'resolved'} onChange={() => setDoneMode('resolved')} />
                            已改
                          </label>
                          <label className="inline-flex items-center gap-1">
                            <input type="radio" name={`done-${it.id}`} checked={doneMode === 'wontfix'} onChange={() => setDoneMode('wontfix')} />
                            不采纳
                          </label>
                        </div>
                        <textarea
                          aria-label="给读者的回复"
                          className="w-full border rounded p-2 text-sm"
                          rows={2}
                          placeholder={doneMode === 'wontfix' ? '不采纳的理由（会公开显示）' : '给读者看的一句话，如“已更正，下次发布生效”（会公开显示）'}
                          value={doneReply}
                          onChange={(e) => setDoneReply(e.target.value)}
                        />
                        <input
                          aria-label="处理凭据"
                          className="w-full border rounded px-2 py-1 font-mono"
                          placeholder={doneMode === 'resolved' ? 'open-guji/book-text@abc1234 或 open-guji-core/overview#605（内部可见，不公开）' : '处理凭据（可选，内部可见）'}
                          value={doneRef}
                          onChange={(e) => setDoneRef(e.target.value)}
                        />
                        {doneError() && (doneReply || doneRef) && <p className="text-red-700">{doneError()}</p>}
                        <div className="flex gap-2">
                          <button
                            onClick={() => submitDone(it.id)}
                            disabled={busy || !!doneError()}
                            className="bg-black text-white rounded px-3 py-1 disabled:opacity-50"
                          >
                            确定
                          </button>
                          <button onClick={() => setDoneFor('')} className="text-gray-500">取消</button>
                        </div>
                      </div>
                    )}

                    <div className="whitespace-pre-wrap break-words mb-1.5">{it.content}</div>
                    <div className="text-gray-500 break-all">
                      {it.pageUrl && (
                        <div>
                          页面：
                          {pageUrlIsOwn
                            ? <a href={it.pageUrl} target="_blank" rel="noreferrer" className="underline">{it.pageUrl}</a>
                            : <span>{it.pageUrl}（外部地址，不渲染为链接）</span>}
                        </div>
                      )}
                      {it.subtype && it.subtype !== 'unspecified' && SUBTYPE_LABEL[it.subtype] && <div>问题类型：{SUBTYPE_LABEL[it.subtype]}</div>}
                      {it.resolvedRef && <div>处理凭据（仅站方可见）：<span className="font-mono text-gray-800">{it.resolvedRef}</span></div>}
                      {it.resourceId && <div>条目：<span className="font-mono">{it.resourceId}</span></div>}
                      {it.contact && <div>联系方式（仅站方可见）：<span className="font-mono text-gray-800">{it.contact}</span></div>}
                    </div>

                    <div className="mt-2 border-t pt-2">
                      {editing ? (
                        <div className="space-y-1.5">
                          <textarea
                            className="w-full border rounded p-2 text-sm"
                            rows={3}
                            value={draft}
                            onChange={(e) => setDrafts((d) => ({ ...d, [it.id]: e.target.value }))}
                          />
                          <div className="flex gap-2">
                            <button onClick={() => update(it.id, { reply: draft.trim() })} disabled={busy} className="bg-black text-white rounded px-3 py-1 text-xs disabled:opacity-50">保存回复</button>
                            {it.status !== 'resolved' && (
                              <button onClick={() => update(it.id, { reply: draft.trim(), status: 'resolved' })} disabled={busy} className="border rounded px-3 py-1 text-xs text-emerald-800 disabled:opacity-50">保存并标已解决</button>
                            )}
                            <button onClick={() => setDrafts((d) => { const n = { ...d }; delete n[it.id]; return n; })} className="text-xs text-gray-500">取消</button>
                          </div>
                        </div>
                      ) : it.reply ? (
                        <div className="flex gap-2">
                          <div className="flex-1 whitespace-pre-wrap text-gray-700"><span className="text-gray-400">站方回复：</span>{it.reply}</div>
                          <button onClick={() => setDrafts((d) => ({ ...d, [it.id]: it.reply || '' }))} className="text-xs text-gray-500 hover:text-black">修改</button>
                        </div>
                      ) : (
                        <button onClick={() => setDrafts((d) => ({ ...d, [it.id]: '' }))} className="text-xs text-gray-500 hover:text-black">写回复</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
