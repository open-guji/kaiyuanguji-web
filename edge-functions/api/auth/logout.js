// POST /api/auth/logout — 清 cookie
const ALLOWED_ORIGINS = ['https://www.kaiyuanguji.com','https://kaiyuanguji.com','https://www.openguji.com','https://openguji.com','https://open-guji.github.io','http://localhost:3000','http://localhost:5173'];
function getCorsHeaders(request){ const origin=request.headers.get('origin')||''; const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0]; return {'Access-Control-Allow-Origin':corsOrigin,'Content-Type':'application/json'}; }
export async function onRequestPost(context){
  const headers=getCorsHeaders(context.request);
  headers['Set-Cookie']='session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  return new Response(JSON.stringify({success:true}),{status:200,headers});
}
export function onRequestOptions(context){
  const origin=context.request.headers.get('origin')||'';
  const corsOrigin=ALLOWED_ORIGINS.includes(origin)?origin:ALLOWED_ORIGINS[0];
  return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':corsOrigin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400'}});
}
