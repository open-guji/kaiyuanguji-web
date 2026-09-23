// POST /api/auth/join — 消费邀请码并登录
// body: { code: string, email?: string }  // email 仅当邀请未绑定邮箱时必填
const ALLOWED_ORIGINS = ['https://www.kaiyuanguji.com','https://kaiyuanguji.com','https://open-guji.github.io','http://localhost:3000','http://localhost:5173'];
const COOKIE_MAX_AGE = 180 * 24 * 3600;
function getCorsHeaders(request){ const origin=request.headers.get('origin')||''; const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0]; return {'Access-Control-Allow-Origin':corsOrigin,'Content-Type':'application/json'}; }
function getJwtSecret(context){ if(context&&context.env&&context.env.AUTH_JWT_SECRET) return context.env.AUTH_JWT_SECRET; return (typeof AUTH_JWT_SECRET!=='undefined')?AUTH_JWT_SECRET:null; }
function getKV(context){
  if(context&&context.env&&context.env.AUTH_KV) return context.env.AUTH_KV;
  if(context&&context.env&&context.env.ERROR_KV) return context.env.ERROR_KV;
  if(context&&context.env&&context.env.FEEDBACK_KV) return context.env.FEEDBACK_KV;
  if(typeof AUTH_KV!=='undefined') return AUTH_KV;
  if(typeof ERROR_KV!=='undefined') return ERROR_KV;
  if(typeof FEEDBACK_KV!=='undefined') return FEEDBACK_KV;
  return null;
}
function b64urlEncode(bytes){ let bin=''; for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]); return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
async function hashCode(code, secret){ const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']); const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(code)); return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function signJWT(payload, secret){
  const header=b64urlEncode(new TextEncoder().encode(JSON.stringify({alg:'HS256',typ:'JWT'})));
  const body=b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const data=`${header}.${body}`;
  const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const sig=await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}
export async function onRequestPost(context){
  const headers=getCorsHeaders(context.request);
  try{
    const kv=getKV(context);
    if(!kv) return new Response(JSON.stringify({success:false,error:'KV 未绑定'}),{status:500,headers});
    const secret=getJwtSecret(context);
    if(!secret) return new Response(JSON.stringify({success:false,error:'服务未配置 AUTH_JWT_SECRET'}),{status:503,headers});
    let body={}; try{ body=await context.request.json(); }catch{ body={}; }
    const code=String(body.code||'').trim();
    if(!code) return new Response(JSON.stringify({success:false,error:'缺少 code'}),{status:400,headers});
    const hash=await hashCode(code, secret);
    const rec=await kv.get(`invite:${hash}`,'json');
    if(!rec) return new Response(JSON.stringify({success:false,error:'邀请码无效'}),{status:400,headers});
    const now=Math.floor(Date.now()/1000);
    if(rec.usedAt) return new Response(JSON.stringify({success:false,error:'邀请码已使用'}),{status:410,headers});
    if(rec.expires && rec.expires < now) return new Response(JSON.stringify({success:false,error:'邀请码已过期'}),{status:410,headers});
    let email = rec.email || null;
    if(!email){
      const supplied=String(body.email||'').trim().toLowerCase();
      if(!supplied || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplied)) return new Response(JSON.stringify({success:false,error:'请填写正确邮箱'}),{status:400,headers});
      email=supplied;
    }
    // 标记已使用
    rec.usedAt=now;
    await kv.put(`invite:${hash}`, JSON.stringify(rec));
    // 写成员表
    const member={ role: rec.role, joinedAt: now, invitedBy: rec.createdBy||'admin' };
    await kv.put(`member:${email}`, JSON.stringify(member));
    // 签 JWT
    const payload={ sub: email, iat: now, exp: now + COOKIE_MAX_AGE };
    const token=await signJWT(payload, secret);
    headers['Set-Cookie'] = `session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
    return new Response(JSON.stringify({success:true,email,role:rec.role}),{status:200,headers});
  }catch(e){
    const headers2=getCorsHeaders(context.request);
    console.error('join error',e);
    return new Response(JSON.stringify({success:false,error:e.message||'加入失败'}),{status:500,headers:headers2});
  }
}
export function onRequestOptions(context){
  const origin=context.request.headers.get('origin')||'';
  const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0];
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':corsOrigin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400'}});
}
