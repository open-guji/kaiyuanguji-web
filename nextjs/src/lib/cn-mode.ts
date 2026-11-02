/**
 * 国内模式（调试用）：在海外也能看到「境外域名被墙」时的页面效果。
 *
 * 开：地址加 `?cn=1`（挡）或 `?cn=report`（只标不挡），之后记在 localStorage（键 CN_MODE_KEY）；关：`?cn=0`。
 * 原理：<head> 里先于一切脚本跑 CN_MODE_INIT_SCRIPT，往页面塞一条 CSP <meta>，
 * 只放行本站各域名（站点、数据、接口、新旧域名）和百度统计，其余图片／脚本／请求／字体一律被浏览器拦下
 * （GA、GitHub raw、jsDelivr、Internet Archive、维基共享资源等，国内打不开的都在此列）。
 * 页面底部浮一条横幅，实时列出被挡（或被标出）的境外域名；影印图若还是空白，说明它依赖了境外地址。
 *
 * 只能模拟「某些域名不可达」，模拟不了「可达但慢／被运营商掐断」——后者用 /probe/net-check.html 让国内的人实测。
 */
import { API_ORIGIN, DATA_ORIGIN, LEGACY_API_ORIGIN, LEGACY_APEX_ORIGIN, LEGACY_DATA_ORIGIN, LEGACY_SITE_ORIGIN, SITE_APEX_ORIGIN, SITE_ORIGIN, STAGING_ORIGIN, hostOf } from './hosts';

export const CN_MODE_KEY = 'og_cn_mode';

/** 国内网络下可达的主机：本站各域名＋百度统计 */
export const CN_ALLOWED_HOSTS = [
  ...[DATA_ORIGIN, LEGACY_DATA_ORIGIN, API_ORIGIN, LEGACY_API_ORIGIN, SITE_ORIGIN, SITE_APEX_ORIGIN, STAGING_ORIGIN, LEGACY_SITE_ORIGIN, LEGACY_APEX_ORIGIN].map(hostOf),
  'hm.baidu.com',
];

export type CnMode = 'block' | 'report' | 'off';

/** 地址参数／存储值 → 模式。`1`／`block` 挡，`report` 只标，其余（含 `0`、空、不认识）关 */
export function parseCnMode(v: string | null | undefined): CnMode {
  if (v === '1' || v === 'block') return 'block';
  if (v === 'report') return 'report';
  return 'off';
}

/** 这个主机在国内能不能打开（按白名单，同源不在此判断） */
export function isCnReachable(host: string): boolean {
  return CN_ALLOWED_HOSTS.includes(host.toLowerCase());
}

/** CSP 正文：除 'self' 与白名单主机外一律不放行；内联脚本样式照放（Next 要用） */
export function buildCnCsp(): string {
  const hosts = CN_ALLOWED_HOSTS.map(h => `https://${h}`).join(' ');
  const src = `'self' ${hosts}`;
  return [
    `default-src ${src}`,
    `script-src ${src} 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${src} 'unsafe-inline'`,
    `img-src ${src} data: blob:`,
    `font-src ${src} data:`,
    `media-src ${src} blob:`,
    `connect-src ${src} blob:`,
    `worker-src ${src} blob:`,
  ].join('; ');
}

/** 放进 <head> 的内联脚本：一定要在别的脚本之前，CSP 只管它之后发起的加载 */
export const CN_MODE_INIT_SCRIPT = `(function(){try{
var KEY=${JSON.stringify(CN_MODE_KEY)},ALLOW=${JSON.stringify(CN_ALLOWED_HOSTS)},CSP=${JSON.stringify(buildCnCsp())};
var q=new URLSearchParams(location.search).get('cn'),m=q;
try{if(q===null){m=localStorage.getItem(KEY)}else if(q==='0'||q===''){localStorage.removeItem(KEY)}else{localStorage.setItem(KEY,q)}}catch(e){}
var mode=(m==='1'||m==='block')?'block':(m==='report'?'report':'off');
if(mode==='off')return;
var d=document;d.documentElement.setAttribute('data-cn-mode',mode);
if(mode==='block'){var t=d.createElement('meta');t.httpEquiv='Content-Security-Policy';t.content=CSP;d.head.appendChild(t)}
var seen={},bar=null;
function show(host,how){var k=host+how;if(seen[k])return;seen[k]=1;
if(!bar){bar=d.createElement('div');bar.setAttribute('data-testid','cn-mode-bar');
bar.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:40vh;overflow:auto;padding:6px 12px;font:12px/1.5 system-ui,sans-serif;background:#7a1f1f;color:#fff';
bar.innerHTML='<b>国内模式（'+(mode==='block'?'已拦境外域名':'只标记境外域名')+'）</b> · <a href="?cn=0" style="color:#fff">退出</a><div data-list></div>';
(d.body||d.documentElement).appendChild(bar)}
var r=d.createElement('div');r.textContent=(how==='block'?'✗ 已拦 ':'! 境外 ')+host;bar.querySelector('[data-list]').appendChild(r)}
function hostOf(u){try{return new URL(u,location.href).hostname}catch(e){return ''}}
d.addEventListener('securitypolicyviolation',function(e){var h=hostOf(e.blockedURI);if(h)show(h,'block')});
if(mode==='report'&&window.PerformanceObserver){try{new PerformanceObserver(function(l){l.getEntries().forEach(function(en){var h=hostOf(en.name);if(h&&h!==location.hostname&&ALLOW.indexOf(h)<0)show(h,'report')})}).observe({type:'resource',buffered:true})}catch(e){}}
}catch(e){}})();`;
