'use client';

// 聚类里的一格小图：点一下挑出来（红框＋「挑出」），再点放回。总览页和聚类页共用
import React from 'react';
import { canShow, cpLabel } from '@/lib/zi-display';
import type { ClusterCell } from '@/lib/proofing-cluster';

const place = (a: string) => { const m = /^(\d+):(\d+):(\d+)([a-z]?)$/.exec(a); return m ? `${Number(m[1])} 叶 ${Number(m[2])} 列 ${Number(m[3])} 字${m[4] ? (m[4] === 'a' ? '（夹注右）' : '（夹注左）') : ''}` : a; };

function Zi({ c }: { c: string }) {
    if (canShow(c)) return <>{c}</>;
    return <span title={c} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.55em' }}>{cpLabel(c)}</span>;
}

/** 字块缩进方框的比例：最多放大到 1.2 倍，免得小字块糊 */
const fit = (img: { w: number; h: number }, box: number) => Math.min(1.2, box / img.w, box / img.h);

export default function ClusterTile({ c, on, busy, onToggle, box = 77 }: { c: ClusterCell; on: boolean; busy: boolean; onToggle: () => void; box?: number }) {
    const img = c.cell.img;
    const src = img ? `${c.spriteBase}/${img.s}` : null;
    const machine = c.cell.c && c.cell.c !== c.cell.ref?.c ? c.cell.c : null;
    return (
        <li style={{ listStyle: 'none' }}>
            <button type="button" data-testid="cluster-tile" aria-pressed={on} disabled={busy} onClick={onToggle}
                title={`${c.chap} 册 · ${place(c.cell.a)}${on ? '（已挑出，再点放回）' : '（点一下挑出来单独处理）'}`}
                style={{ width: '100%', padding: 3, borderRadius: 6, cursor: busy ? 'default' : 'pointer', position: 'relative', textAlign: 'center',
                    border: on ? '2px solid #d33' : '1px solid #ddd', background: on ? '#fdecec' : '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                {src && img
                    ? <span role="img" aria-label="字块裁图" style={{ width: box, height: box, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
                        {/* 字块等比缩进 box×box 的方框：扁字（一、三）、长字都不出框（zoom 连背景一起缩，transform 在部分浏览器下背景不跟着缩） */}
                        <span style={{ flex: 'none', width: img.w, height: img.h, zoom: fit(img, box), background: `#fff url(${src}) -${img.x}px -${img.y}px no-repeat` }} />
                    </span>
                    : <span style={{ width: box, height: box, fontSize: 11, color: '#999', display: 'flex', alignItems: 'center' }}>没有图</span>}
                <span style={{ fontSize: 11, lineHeight: 1.3, color: '#666' }}>{c.chap} 册 · {Number(c.cell.a.split(':')[0])} 叶</span>
                {machine && <span style={{ fontSize: 11, lineHeight: 1.2, color: '#a33' }}>机器读「<Zi c={machine} />」</span>}
                {on && <small style={{ position: 'absolute', top: 2, right: 2, fontSize: 10, lineHeight: 1.4, padding: '0 3px', borderRadius: 3, color: '#fff', background: '#d33' }}>挑出</small>}
            </button>
        </li>
    );
}

