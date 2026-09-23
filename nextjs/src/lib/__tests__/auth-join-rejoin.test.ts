/**
 * @jest-environment node
 */

/*
 * 已存在成员通过新邀请重新登录应 200（覆盖会话），而非 409
 */
const g = globalThis as unknown as Record<string, unknown>;
g.AUTH_JWT_SECRET = 'test-jwt-secret-32bytes-long-1234567890';
g.AUTH_ADMIN_TOKEN = 'test-admin-token';
class MockKV {
  m = new Map<string,string>();
  async put(k:string,v:string){ this.m.set(k,v); }
  async get(k:string,t?:string){ const v=this.m.get(k); if(v===undefined) return null; if(t==='json'){ try{ return JSON.parse(v);}catch{ return v;}} return v; }
}
const kv=new MockKV() as any;
const env:any={AUTH_JWT_SECRET:g.AUTH_JWT_SECRET, AUTH_ADMIN_TOKEN:g.AUTH_ADMIN_TOKEN, AUTH_KV:kv};
function ctx(url:string,init:any={}){ return {request:new Request(url,init), env}; }
let invite:any, join:any;
beforeAll(async()=>{
  invite=await import('../../../../edge-functions/api/auth/invite.js');
  join=await import('../../../../edge-functions/api/auth/join.js');
});
describe('rejoin',()=>{
  it('已存在成员用新邀请可重新登录',async()=>{
    let r=await invite.onRequestPost({request:new Request('https://x/api/auth/invite',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${String(g.AUTH_ADMIN_TOKEN)}`},body:JSON.stringify({email:'alice@example.com',role:'admin'})}), env} as any);
    const code1=(await r.json()).code;
    r=await join.onRequestPost(ctx('https://x/api/auth/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code1})}));
    expect(r.status).toBe(200);
    r=await invite.onRequestPost({request:new Request('https://x/api/auth/invite',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${String(g.AUTH_ADMIN_TOKEN)}`},body:JSON.stringify({email:'alice@example.com',role:'admin'})}), env} as any);
    const code2=(await r.json()).code;
    r=await join.onRequestPost(ctx('https://x/api/auth/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code2})}));
    expect(r.status).toBe(200);
    const j=await r.json(); expect(j.email).toBe('alice@example.com');
  });
});
