'use client';
import { useState } from 'react';
import { hashShard, pathShardSegments } from '@/lib/private-text-shard';

type FullTextRecord = {
  key: string;
  owner_type: string;
  path: string;
  version_label?: string;
  source_name?: string;
  source_url?: string;
  license?: string;
  total_chapters?: number;
};
type Chapter = { n: number; title: string; file: string; md_len?: number };

async function fetchPrivate(relative: string): Promise<Response> {
  return fetch(`/api/private-text/${relative}`, { credentials: 'include', cache: 'no-store' });
}

/**
 * 最小调试入口（P1-私有文本后端任务卡 §一·4）：不做阅读器 UI，只给能进
 * `/admin` 的人核对「这本书的私有文本进库了没有、内容对不对」。
 *
 * 流程：Work ID → 算 index/full_text/{hashShard}.json 分片 → 读该分片拿到这个
 * id 下的私有文本记录列表（key/path/来源）→ 点开某条 → 读 {path}/index.json
 * 拿章节清单 → 点开某章 → 读 {path}/{file} 显示原文纯文本。
 */
export default function PrivateTextDebugPage() {
  const [workId, setWorkId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<FullTextRecord[] | null>(null);
  const [chapters, setChapters] = useState<{ path: string; list: Chapter[] } | null>(null);
  const [chapterText, setChapterText] = useState<{ file: string; text: string } | null>(null);

  async function handleLookup() {
    const id = workId.trim();
    if (!id) return;
    setError(null);
    setRecords(null);
    setChapters(null);
    setChapterText(null);
    setLoading(true);
    try {
      const shard = hashShard(id);
      const res = await fetchPrivate(`index/full_text/${shard}.json`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(`读索引分片 ${shard}.json 失败：HTTP ${res.status} ${j.error || ''}`);
      }
      const idx = await res.json();
      const list: FullTextRecord[] = idx[id] || [];
      setRecords(list);
      if (list.length === 0) {
        const [c1, c2, c3] = pathShardSegments(id);
        setError(`索引分片 ${shard}.json 里没有这个 id（若确认已入库，核对目录分片应为 Work/${c1}/${c2}/${c3}/${id}/）`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleOpenRecord(rec: FullTextRecord) {
    setError(null);
    setChapters(null);
    setChapterText(null);
    try {
      const res = await fetchPrivate(`${rec.path}/index.json`);
      if (!res.ok) throw new Error(`读 ${rec.path}/index.json 失败：HTTP ${res.status}`);
      const meta = await res.json();
      setChapters({ path: rec.path, list: meta.chapters || [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpenChapter(path: string, file: string) {
    setError(null);
    setChapterText(null);
    try {
      const res = await fetchPrivate(`${path}/${file}`);
      if (!res.ok) throw new Error(`读 ${path}/${file} 失败：HTTP ${res.status}`);
      const text = await res.text();
      setChapterText({ file, text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">私有文本调试</h1>
      <p className="text-sm text-gray-500">
        只读、只查 book-text-private 内容进库情况，不是给读者用的阅读器（阅读器 UI 用户定搁置）。
        本页与其调用的 <code>/api/private-text/*</code> 一样，需要成员角色为 <code>internal</code> 或
        <code>admin</code>——本页本身也在 <code>/admin</code> 下，已由 AdminGuard 挡了非 admin。
      </p>

      <div className="bg-white rounded border p-4 space-y-3">
        <div className="flex gap-2">
          <input
            className="flex-1 border rounded px-2 py-1 text-sm font-mono"
            placeholder="Work ID，如 d59ezak6jq4g"
            value={workId}
            onChange={(e) => setWorkId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
          />
          <button onClick={handleLookup} disabled={loading} className="bg-black text-white rounded px-3 py-1 text-sm disabled:opacity-50">
            {loading ? '查询中…' : '查'}
          </button>
        </div>
        {error && <p className="text-sm text-red-600 whitespace-pre-wrap">{error}</p>}
      </div>

      {records && records.length > 0 && (
        <div className="bg-white rounded border p-4 space-y-2">
          <h2 className="text-sm font-semibold">私有文本记录（{records.length}）</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="pb-1">key</th><th>来源</th><th>版本标签</th><th>章数</th><th></th>
              </tr>
            </thead>
            <tbody>
              {records.map((rec) => (
                <tr key={rec.path} className="border-t">
                  <td className="py-1 font-mono text-xs">{rec.key}</td>
                  <td className="text-xs">{rec.source_name}</td>
                  <td className="text-xs">{rec.version_label}</td>
                  <td className="text-xs">{rec.total_chapters ?? '-'}</td>
                  <td className="text-right">
                    <button onClick={() => handleOpenRecord(rec)} className="text-xs text-blue-600 hover:underline">打开</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {chapters && (
        <div className="bg-white rounded border p-4 space-y-2">
          <h2 className="text-sm font-semibold">章节清单：<span className="font-mono text-xs">{chapters.path}</span>（{chapters.list.length}）</h2>
          <ul className="text-sm space-y-0.5 max-h-64 overflow-y-auto">
            {chapters.list.map((ch) => (
              <li key={ch.file}>
                <button onClick={() => handleOpenChapter(chapters.path, ch.file)} className="text-blue-600 hover:underline text-left">
                  {ch.n}. {ch.title}（{ch.file}{ch.md_len != null ? `，${ch.md_len} 字` : ''}）
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {chapterText && (
        <div className="bg-white rounded border p-4 space-y-2">
          <h2 className="text-sm font-semibold">原文：<span className="font-mono text-xs">{chapterText.file}</span></h2>
          <pre className="text-sm whitespace-pre-wrap bg-gray-50 p-3 rounded max-h-[60vh] overflow-y-auto">{chapterText.text}</pre>
        </div>
      )}
    </div>
  );
}
