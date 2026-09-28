// POST /api/auth/revoke — 删人或改角色（需 admin）
// body: { email: string, role?: string | null }  // role=null 或不传则删除，传 role 则改
const ALLOWED_ORIGINS = ['https://www.kaiyuanguji.com','https://kaiyuanguji.com','https://open-guji.github.io','http://localhost:3000','http://localhost:5173'];
// internal 已停用（overview#256），只留着用来撤销旧记录。
const ALLOWED_ROLES = ['reader','reviewer','editor','admin','internal'];
function getCorsHeaders(request){ const origin=request.headers.get('origin')||''; const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0]; return {'Access-Control-Allow-Origin':corsOrigin,'Content-Type':'application/json'}; }
function getAdminToken(context){ if(context&&context.env&&context.env.AUTH_ADMIN_TOKEN) return context.env.AUTH_ADMIN_TOKEN; return (typeof AUTH_ADMIN_TOKEN!=='undefined')?AUTH_ADMIN_TOKEN:null; }
function getJwtSecret(context){ if(context&&context.env&&context.env.AUTH_JWT_SECRET) return context.env.AUTH_JWT_SECRET; return (typeof AUTH_JWT_SECRET!=='undefined')?AUTH_JWT_SECRET:null; }
function getKV(context){
  if(context&&context.env&&context.env.AUTH_KV) return context.env.AUTH_KV;
  if(typeof AUTH_KV!=='undefined') return AUTH_KV;
  return null;
}
async function getMember(kv, email){
  try{
    const m=await kv.get(`member:${email}`,'json');
    if(!m) return null;
    if(typeof m==='string'){
      if(m.trim()==='') return null;
      try{ const parsed=JSON.parse(m); if(!parsed || parsed._deleted) return null; return parsed; }catch{ return null; }
    }
    if(m._deleted) return null;
    return m;
  }catch{ return null; }
}
function getCookie(request,name){ const c=request.headers.get('cookie')||''; const m=c.match(new RegExp('(?:^|;\\s*)'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)')); return m?decodeURIComponent(m[1]):null; }
function b64urlEncode(bytes){ let bin=''; for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]); return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
function b64urlDecode(str){ str=str.replace(/-/g,'+').replace(/_/g,'/'); const pad=str.length%4; if(pad) str+='===='.slice(pad); const bin=atob(str); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; }
function constantTimeEqual(a,b){ if(a.length!==b.length) return false; let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0; }
async function hmacSign(data, secret){ const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']); const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)); return b64urlEncode(new Uint8Array(sig)); }
async function verifyJWT(token, secret){ const parts=token.split('.'); if(parts.length!==3) return null; const data=`${parts[0]}.${parts[1]}`; const expect=await hmacSign(data, secret); if(!constantTimeEqual(expect, parts[2])) return null; try{ const p=JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))); if(p.exp && p.exp < Math.floor(Date.now()/1000)) return null; return p; }catch{ return null; } }
async function checkAdmin(request, context){
  const secret=getJwtSecret(context);
  const session=getCookie(request,'session');
  if(session && secret){
    const payload=await verifyJWT(session, secret);
    if(payload && payload.sub){
      const kv=getKV(context);
      if(kv){
        const member=await kv.get(`member:${payload.sub}`,'json');
        if(member && !member._deleted && typeof member==='object' && member.role==='admin') return {ok:true,by:payload.sub};
      }
    }
  }
  const expected=getAdminToken(context);
  if(!expected) return {ok:false,status:503,error:'服务未配置 AUTH_ADMIN_TOKEN'};
  const headerToken=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
  const url=new URL(request.url);
  const q=url.searchParams.get('token')||'';
  const given=headerToken||q;
  if(given && constantTimeEqual(given, String(expected))) return {ok:true,by:'admin_token'};
  return {ok:false,status:401,error:'未授权'};
}
export async function onRequestPost(context){
  const headers=getCorsHeaders(context.request);
  try{
    let body={}; try{ body=await context.request.clone().json(); }catch{ try{ body=await context.request.json(); }catch{ body={}; } }
    // 兼容 body.token 作为 admin token：先解析 body 再判权
    let auth=await checkAdmin(context.request, context);
    if(!auth.ok){
      const expected=getAdminToken(context);
      const bodyToken=body && body.token ? String(body.token) : '';
      if(expected && bodyToken && constantTimeEqual(bodyToken, String(expected))){
        auth={ok:true,by:'admin_token_body'};
      }
    }
    if(!auth.ok) return new Response(JSON.stringify({success:false,error:auth.error}),{status:auth.status,headers});
    const email=String(body.email||'').trim().toLowerCase();
    if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return new Response(JSON.stringify({success:false,error:'请提供正确 email'}),{status:400,headers});
    const kv=getKV(context);
    if(!kv) return new Response(JSON.stringify({success:false,error:'KV 未绑定'}),{status:503,headers});
    if(body.role === undefined || body.role === null || body.role === ''){
      // 删除：优先物理删除，兜底写墓碑
      try{
        if(kv.delete) await kv.delete(`member:${email}`);
        else await kv.put(`member:${email}`, JSON.stringify({ _deleted: true }));
      }catch{
        try{ await kv.put(`member:${email}`, JSON.stringify({ _deleted: true })); }catch{}
      }
      return new Response(JSON.stringify({success:true,action:'deleted'}),{status:200,headers});
    }
    const role=String(body.role).trim();
    if(!ALLOWED_ROLES.includes(role)) return new Response(JSON.stringify({success:false,error:`role 必须为 ${ALLOWED_ROLES.join('/')}`}),{status:400,headers});
    const now=Math.floor(Date.now()/1000);
    const existing=await getMember(kv, email);
    const rec={ role, joinedAt: existing && existing.joinedAt ? existing.joinedAt : now, invitedBy: auth.by||'admin', updatedAt: now };
    await kv.put(`member:${email}`, JSON.stringify(rec));
    return new Response(JSON.stringify({success:true,action:'updated',member:rec}),{status:200,headers});
  }catch(e){
    const headers2=getCorsHeaders(context.request);
    return new Response(JSON.stringify({success:false,error:e.message||'操作失败'}),{status:500,headers:headers2});
  }
}
export function onRequestOptions(context){
  const origin=context.request.headers.get('origin')||'';
  const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0];
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':corsOrigin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'86400'}});
}
