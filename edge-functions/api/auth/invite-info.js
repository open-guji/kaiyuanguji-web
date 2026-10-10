// GET /api/auth/invite-info?c= — 只读，不消费
const ALLOWED_ORIGINS = ['https://www.kaiyuanguji.com','https://kaiyuanguji.com','https://www.openguji.com','https://openguji.com','https://open-guji.github.io','http://localhost:3000','http://localhost:5173'];
function getCorsHeaders(request){ const origin=request.headers.get('origin')||''; const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0]; return {'Access-Control-Allow-Origin':corsOrigin,'Content-Type':'application/json'}; }
function getJwtSecret(context){ if(context&&context.env&&context.env.AUTH_JWT_SECRET) return context.env.AUTH_JWT_SECRET; return (typeof AUTH_JWT_SECRET!=='undefined')?AUTH_JWT_SECRET:null; }
function getKV(context){
  if(context&&context.env&&context.env.AUTH_KV) return context.env.AUTH_KV;
  if(typeof AUTH_KV!=='undefined') return AUTH_KV;
  return null;
}
async function hashCode(code, secret){
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(code));
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function onRequestGet(context){
  const headers=getCorsHeaders(context.request);
  try{
    const kv=getKV(context);
    if(!kv) return new Response(JSON.stringify({success:false,error:'KV 未绑定'}),{status:503,headers});
    const secret=getJwtSecret(context);
    if(!secret) return new Response(JSON.stringify({success:false,error:'服务未配置 AUTH_JWT_SECRET'}),{status:503,headers});
    const url=new URL(context.request.url);
    const code=(url.searchParams.get('c')||'').trim();
    if(!code) return new Response(JSON.stringify({success:false,error:'缺少 c 参数'}),{status:400,headers});
    const hash=await hashCode(code, secret);
    const rec=await kv.get(`invite:${hash}`,'json');
    if(!rec) return new Response(JSON.stringify({success:true,valid:false,reason:'not_found'}),{status:200,headers});
    const now=Math.floor(Date.now()/1000);
    if(rec.usedAt) return new Response(JSON.stringify({success:true,valid:false,reason:'used',email:rec.email,role:rec.role}),{status:200,headers});
    if(rec.expires && rec.expires < now) return new Response(JSON.stringify({success:true,valid:false,reason:'expired',email:rec.email,role:rec.role,expires:rec.expires}),{status:200,headers});
    return new Response(JSON.stringify({success:true,valid:true,email:rec.email,role:rec.role,expires:rec.expires,createdBy:rec.createdBy}),{status:200,headers});
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
