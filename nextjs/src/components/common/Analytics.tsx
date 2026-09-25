'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { BAIDU_TONGJI_ID, GA_ID, shouldTrack } from '@/lib/analytics';

type Queue = unknown[][];
type W = Window & { _hmt?: Queue; dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };

function loadScript(src: string) {
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

/**
 * 访问统计（G-24 第一期），规则见 @/lib/analytics。
 *
 * 静态导出站点的坑：站内跳转是客户端路由，不会重新加载页面，两家脚本默认都只记首屏。
 * 所以两家都关掉自动 PV，由这里在每次路由变化（含 ?id= 变化——条目页靠它区分）时手动报。
 * 必须包在 <Suspense> 里用（useSearchParams 在静态导出下的要求）。
 *
 * GA4 后台须关掉「增强型衡量 → 网页浏览 → 基于浏览器历史记录事件的网页更改」，
 * 否则它自己也会在客户端路由时报一次 page_view，与这里重复计数。
 */
export default function Analytics() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inited = useRef(false);

  useEffect(() => {
    if (!BAIDU_TONGJI_ID && !GA_ID) return;
    if (!shouldTrack(pathname, navigator)) return;
    const w = window as W;

    if (!inited.current) {
      inited.current = true;
      if (BAIDU_TONGJI_ID) {
        w._hmt = w._hmt || [];
        w._hmt.push(['_setAutoPageview', false]);
        loadScript(`https://hm.baidu.com/hm.js?${BAIDU_TONGJI_ID}`);
      }
      if (GA_ID) {
        w.dataLayer = w.dataLayer || [];
        // gtag 必须 push arguments 对象本身，不能是数组（GA 官方片段的写法）
        w.gtag = function gtag() {
          // eslint-disable-next-line prefer-rest-params
          w.dataLayer!.push(arguments);
        };
        w.gtag('js', new Date());
        w.gtag('config', GA_ID, { send_page_view: false });
        loadScript(`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`);
      }
    }

    const qs = searchParams?.toString();
    const path = qs ? `${pathname}?${qs}` : pathname;
    if (BAIDU_TONGJI_ID) w._hmt?.push(['_trackPageview', path]);
    if (GA_ID) {
      w.gtag?.('event', 'page_view', {
        page_path: path,
        page_location: window.location.origin + path,
        page_title: document.title,
      });
    }
  }, [pathname, searchParams]);

  return null;
}
