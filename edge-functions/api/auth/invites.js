// GET /api/auth/invites — 查看待使用邀请码列表（需 admin，只返回未使用未过期）
const ALLOWED_ORIGINS = ['https://www.kaiyuanguji.com','https://kaiyuanguji.com','https://open-guji.github.io','http://localhost:3000','http://localhost:5173'];
function getCorsHeaders(request){ const o=request.headers.get('origin')||''; const c=ALLOWED_ORIGINS.includes(o)?o:ALLOWED_ORIGINS[0]; return {'Access-Control-Allow-Origin':c,'Content-Type':'application/json'}; }
function getAdminToken(c){ if(c&&c.env&&c.env.AUTH_ADMIN_TOKEN) return c.env.AUTH_ADMIN_TOKEN; return (typeof AUTH_ADMIN_TOKEN!=='undefined')?AUTH_ADMIN_TOKEN:null; }
function getJwtSecret(c){ if(c&&c.env&&c.env.AUTH_JWT_SECRET) return c.env.AUTH_JWT_SECRET; return (typeof AUTH_JWT_SECRET!=='undefined')?AUTH_JWT_SECRET:null; }
function getKV(c) {
  // 成员表只认 AUTH_KV，不回落到 ERROR_KV / FEEDBACK_KV（与 auth/* 端点同一份成员表）
  if (c && c.env && c.env.AUTH_KV) return c.env.AUTH_KV;
  return (typeof AUTH_KV !== 'undefined') ? AUTH_KV : null;
}
function getCookie(req,n){ const c=req.headers.get('cookie')||''; const m=c.match(new RegExp('(?:^|;\\s*)'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)')); return m?decodeURIComponent(m[1]):null; }
function b64urlEncode(b){ let s=''; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
function b64urlDecode(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); const p=s.length%4; if(p) s+='===='.slice(p); const bin=atob(s); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; }
function constantTimeEqual(a,b){ if(a.length!==b.length) return false; let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0; }
async function hmacSign(d,s){ const k=await crypto.subtle.importKey('raw', new TextEncoder().encode(s), {name:'HMAC',hash:'SHA-256'}, false, ['sign']); const sig=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(d)); return b64urlEncode(new Uint8Array(sig)); }
async function verifyJWT(t,s){ const p=t.split('.'); if(p.length!==3) return null; const d=`${p[0]}.${p[1]}`; const e=await hmacSign(d,s); if(!constantTimeEqual(e,p[2])) return null; try{ const pl=JSON.parse(new TextDecoder().decode(b64urlDecode(p[1]))); if(pl.exp && pl.exp < Math.floor(Date.now()/1000)) return null; return pl; }catch{ return null; } }
async function checkAdmin(req, ctx){
  const s=getJwtSecret(ctx); const tok=getCookie(req,'session');
  if(s && tok){
    const pl=await verifyJWT(tok,s);
    if(pl && pl.sub){
      const kv=getKV(ctx); if(kv){
        const m=await kv.get(`member:${pl.sub}`,'json').catch(()=>null);
        if(m && typeof m==='object' && !m._deleted && m.role==='admin') return {ok:true};
      }
    }
  }
  const exp=getAdminToken(ctx); if(!exp) return {ok:false,status:503,error:'服务未配置 AUTH_ADMIN_TOKEN'};
  const h=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim(); const q=new URL(req.url).searchParams.get('token')||''; const g=h||q;
  if(g && constantTimeEqual(g,String(exp))) return {ok:true};
  return {ok:false,status:401,error:'未授权'};
}
export async function onRequestGet(context){
  const headers=getCorsHeaders(context.request);
  const auth=await checkAdmin(context.request, context);
  if(!auth.ok) return new Response(JSON.stringify({success:false,error:auth.error}),{status:auth.status,headers});
  const kv=getKV(context);
  if(!kv) return new Response(JSON.stringify({success:false,error:'KV 未绑定'}),{status:503,headers});
  const now=Math.floor(Date.now()/1000);
  const list=await kv.list({prefix:'invite:'});
  const invites=[];
  for(const k of (list.keys||[])){
    const v=await kv.get(k.key,'json').catch(()=>null);
    if(!v) continue;
    if(v.usedAt) continue;
    if(v.expires && v.expires < now) continue;
    const hash=k.key.replace(/^invite:/,'');
    invites.push({hash, email:v.email, role:v.role, expires:v.expires, createdBy:v.createdBy, createdAt:v.createdAt});
  }
  invites.sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));
  return new Response(JSON.stringify({success:true,invites}),{status:200,headers});
}
export function onRequestOptions(context){
  const o=context.request.headers.get('origin')||''; const c=ALLOWED_ORIGINS.includes(o)?o:ALLOWED_ORIGINS[0];
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':c,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'86400'}});
}
