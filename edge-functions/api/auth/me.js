// GET /api/auth/me — 返回当前登录身份，顺带滑动续期
const ALLOWED_ORIGINS = ['https://www.kaiyuanguji.com','https://kaiyuanguji.com','https://open-guji.github.io','http://localhost:3000','http://localhost:5173'];
const COOKIE_MAX_AGE = 180 * 24 * 3600;
const RENEW_THRESHOLD = 30 * 24 * 3600;
function getCorsHeaders(request){ const origin=request.headers.get('origin')||''; const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0]; return {'Access-Control-Allow-Origin':corsOrigin,'Content-Type':'application/json'}; }
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
// H1：令牌的 tv 必须等于成员记录的 tokenVersion（join／改角色／删除时 +1）。旧令牌没有 tv、
// 旧记录没有 tokenVersion 的一律视为失效，要求重新走邀请登录。
function tokenVersionOk(payload, member){ const v=member&&member.tokenVersion; return Number.isInteger(v) && v>0 && !!payload && payload.tv===v; }
function getCookie(request,name){
  const c=request.headers.get('cookie')||'';
  const m=c.match(new RegExp('(?:^|;\\s*)'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)'));
  return m?decodeURIComponent(m[1]):null;
}
function b64urlEncode(bytes){ let bin=''; for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]); return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
function b64urlDecode(str){ str=str.replace(/-/g,'+').replace(/_/g,'/'); const pad=str.length%4; if(pad) str+='===='.slice(pad); const bin=atob(str); const a=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; }
function constantTimeEqual(a,b){ if(a.length!==b.length) return false; let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0; }
async function hmacSign(data, secret){ const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']); const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)); return b64urlEncode(new Uint8Array(sig)); }
async function verifyJWT(token, secret){
  const parts=token.split('.'); if(parts.length!==3) return null;
  const data=`${parts[0]}.${parts[1]}`;
  const expect=await hmacSign(data, secret);
  if(!constantTimeEqual(expect, parts[2])) return null;
  try{
    const payload=JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if(payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  }catch{ return null; }
}
async function signJWT(payload, secret){
  const h=b64urlEncode(new TextEncoder().encode(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const p=b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const data=`${h}.${p}`;
  const s=await hmacSign(data, secret);
  return `${data}.${s}`;
}
export async function onRequestGet(context){
  const headers=getCorsHeaders(context.request);
  try{
    const secret=getJwtSecret(context);
    if(!secret) return new Response(JSON.stringify({success:false,error:'服务未配置 AUTH_JWT_SECRET'}),{status:503,headers});
    const token=getCookie(context.request,'session');
    if(!token) return new Response(JSON.stringify({success:false,error:'未登录'}),{status:401,headers});
    const payload=await verifyJWT(token, secret);
    if(!payload || !payload.sub) return new Response(JSON.stringify({success:false,error:'未登录'}),{status:401,headers});
    const kv=getKV(context);
    if(!kv) return new Response(JSON.stringify({success:false,error:'KV 未绑定'}),{status:503,headers});
    const member=await getMember(kv, payload.sub);
    if(!member) return new Response(JSON.stringify({success:false,error:'成员不存在或已移除'}),{status:401,headers});
    if(!tokenVersionOk(payload, member)) return new Response(JSON.stringify({success:false,error:'登录已失效，请重新登录'}),{status:401,headers});
    // 滑动续期（只给版本号对得上的令牌续，续出来的仍带同一个 tv）
    const now=Math.floor(Date.now()/1000);
    if(payload.exp && (payload.exp - now) < RENEW_THRESHOLD){
      const newPayload={ sub: payload.sub, iat: now, exp: now + COOKIE_MAX_AGE, tv: member.tokenVersion };
      const newToken=await signJWT(newPayload, secret);
      headers['Set-Cookie']=`session=${newToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
    }
    return new Response(JSON.stringify({success:true,email:payload.sub,role:member.role,joinedAt:member.joinedAt}),{status:200,headers});
  }catch(e){
    const headers2=getCorsHeaders(context.request);
    return new Response(JSON.stringify({success:false,error:e.message||'查询失败'}),{status:500,headers:headers2});
  }
}
export function onRequestOptions(context){
  const origin=context.request.headers.get('origin')||'';
  const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0];
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':corsOrigin,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400'}});
}
