/**
 * @jest-environment node
 */

/*
 * 管理员查看：members/invites 仅 admin 可见，编辑/匿名 401，数据来自 KV
 */
const g = globalThis as unknown as Record<string, unknown>;
g.AUTH_JWT_SECRET = 'test-jwt-secret-32bytes-long-1234567890';
g.AUTH_ADMIN_TOKEN = 'test-admin-token';
class MockKV {
  m = new Map<string,string>();
  async put(k:string,v:string){ this.m.set(k,v); }
  async get(k:string,t?:string){ const v=this.m.get(k); if(v===undefined) return null; if(t==='json'){ try{ return JSON.parse(v);}catch{ return v;}} return v; }
  async list(o?:any){ const p=o?.prefix||''; const keys=[...this.m.keys()].filter(k=>k.startsWith(p)).map(k=>({key:k})); return {keys, complete:true, cursor:''}; }
}
const kv=new MockKV() as any;
const env:any={AUTH_JWT_SECRET:g.AUTH_JWT_SECRET, AUTH_ADMIN_TOKEN:g.AUTH_ADMIN_TOKEN, AUTH_KV:kv, ERROR_KV:kv, FEEDBACK_KV:kv};
function ctx(url:string,init:any={}){ return {request:new Request(url,init), env}; }
async function body(r:Response){ return JSON.parse(await r.text()); }
async function hmac(s:string,d:string){ const k=await crypto.subtle.importKey('raw', new TextEncoder().encode(s), {name:'HMAC',hash:'SHA-256'}, false, ['sign']); const sig=await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(d)); let bin=''; const a=new Uint8Array(sig); for(let i=0;i<a.length;i++) bin+=String.fromCharCode(a[i]); return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); }
async function sign(pl:any, secret:string){ const h=btoa(JSON.stringify({alg:'HS256',typ:'JWT'})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); const p=btoa(JSON.stringify(pl)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,''); const d=`${h}.${p}`; const s=await hmac(secret,d); return `${d}.${s}`; }

let members:any, invites:any, invite:any;
beforeAll(async()=>{
  members=await import('../../../../edge-functions/api/auth/members.js');
  invites=await import('../../../../edge-functions/api/auth/invites.js');
  invite=await import('../../../../edge-functions/api/auth/invite.js');
});
beforeEach(()=>{ kv.m.clear(); });

describe('admin view',()=>{
  it('members 仅 admin 可见',async()=>{
    const now=Math.floor(Date.now()/1000);
    const adminTok=await sign({sub:'a@x.com',tv:1,iat:now,exp:now+180*86400}, String(g.AUTH_JWT_SECRET));
    const editorTok=await sign({sub:'b@x.com',tv:1,iat:now,exp:now+180*86400}, String(g.AUTH_JWT_SECRET));
    await kv.put('member:a@x.com', JSON.stringify({role:'admin',joinedAt:now,tokenVersion:1}));
    await kv.put('member:b@x.com', JSON.stringify({role:'editor',joinedAt:now,tokenVersion:1}));
    let r=await members.onRequestGet(ctx('https://x/api/auth/members',{headers:{'Cookie':`session=${adminTok}`}} as any));
    expect(r.status).toBe(200); expect((await body(r)).members).toHaveLength(2);
    r=await members.onRequestGet(ctx('https://x/api/auth/members',{headers:{'Cookie':`session=${editorTok}`}} as any));
    expect(r.status).toBe(401);
    r=await members.onRequestGet(ctx('https://x/api/auth/members'));
    expect(r.status).toBe(401);
  });
  it('invites 仅返回未使用未过期',async()=>{
    const now=Math.floor(Date.now()/1000);
    const adminTok=await sign({sub:'a@x.com',tv:1,iat:now,exp:now+180*86400}, String(g.AUTH_JWT_SECRET));
    await kv.put('member:a@x.com', JSON.stringify({role:'admin',joinedAt:now,tokenVersion:1}));
    let r=await invite.onRequestPost(ctx('https://x/api/auth/invite',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${String(g.AUTH_ADMIN_TOKEN)}`},body:JSON.stringify({email:'x@x.com',role:'reviewer'})}));
    expect(r.status).toBe(200);
    r=await invites.onRequestGet(ctx('https://x/api/auth/invites',{headers:{'Cookie':`session=${adminTok}`}} as any));
    expect((await body(r)).invites).toHaveLength(1);
  });
});
