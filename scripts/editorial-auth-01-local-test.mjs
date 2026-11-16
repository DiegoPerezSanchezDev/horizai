import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// This suite is deliberately incapable of targeting the hosted Supabase project.
const config = JSON.parse(await readFile(".auth-01-local/runtime.json", "utf8"));
const origin = "http://127.0.0.1:3016";
assert.equal(config.API_URL, "http://127.0.0.1:55321");
assert.equal(config.MAILPIT_URL, "http://127.0.0.1:55324");
const authCookie = "horizai-editorial-auth";
const operatorEmail = "operator@example.test";
const outsiderEmail = "outsider@example.test";
const results = [];
const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
for (const email of [operatorEmail, outsiderEmail]) {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !["email_exists", "user_already_exists"].includes(created.error.code)) throw new Error("LOCAL_AUTH_SEED_FAILED");
}

function cookieHeader(jar) { return [...jar].map(([name,value])=>`${name}=${value}`).join("; "); }
function remember(response, jar) {
  for (const line of response.headers.getSetCookie()) {
    const [entry] = line.split(";");
    const index = entry.indexOf("=");
    const name = entry.slice(0,index), value = entry.slice(index+1);
    if (/max-age=0/i.test(line)) jar.delete(name); else jar.set(name,value);
    assert.match(line,/HttpOnly/i);
    assert.match(line,/SameSite=lax/i);
  }
}
async function request(path, jar = new Map(), form) {
  const response = await fetch(origin+path, { redirect:"manual", method:form ? "POST":"GET", headers:{Cookie:cookieHeader(jar),...(form?{"Content-Type":"application/x-www-form-urlencoded",Origin:origin}: {})}, body:form?new URLSearchParams(form):undefined });
  remember(response,jar);
  return response;
}
async function assertDenied(path, jar, state) {
  const response = await request(path,jar);
  assert.equal(response.status,303);
  assert.equal(new URL(response.headers.get("location"),origin).searchParams.get("state"),state);
  assert.doesNotMatch(await response.text(),/Un laboratorio público|demo-revision-02|En este ejemplo de desarrollo/);
  results.push({case:`${state} ${path}`,status:"PASS"});
}
for(const path of ["/editorial","/editorial/reviews/x"]) await assertDenied(path,new Map(),"anonymous");
const flight=await fetch(origin+"/editorial/reviews/demo-madrid",{redirect:"manual",headers:{RSC:"1"}});
assert.equal(flight.status,303);
assert.doesNotMatch(await flight.text(),/Un laboratorio público/);
results.push({case:"anonymous direct RSC denied before payload",status:"PASS"});
for(const path of ["/api/editorial","/api/editorial/reviews/x"]) {
  const response=await request(path);assert.equal(response.status,401);assert.equal((await response.json()).error,"EDITORIAL_ACCESS_DENIED");
}
results.push({case:"future editorial API namespace protected",status:"PASS"});
await assertDenied("/editorial",new Map([[authCookie,"malformed"]]),"expired");

const jar=new Map();
const send=await request("/editorial/auth/request",jar,{email:operatorEmail});
assert.equal(send.status,303);
assert.equal(new URL(send.headers.get("location"),origin).searchParams.get("state"),"code");
const messages=await (await fetch(config.MAILPIT_URL+"/api/v1/messages")).json();
const message=messages.messages.find(message=>message.To?.some(to=>to.Address===operatorEmail));
assert.ok(message,"LOCAL_OTP_EMAIL_REQUIRED");
const content=await (await fetch(config.MAILPIT_URL+"/api/v1/message/"+message.ID)).json();
const code=(content.Text??"").match(/\b(\d{6,8})\b/)?.[1];
assert.ok(code,"LOCAL_OTP_CODE_REQUIRED");
const verify=await request("/editorial/auth/verify",jar,{token:code});
assert.equal(verify.status,303);
assert.equal(new URL(verify.headers.get("location"),origin).pathname,"/editorial");
assert.ok([...jar.keys()].some(name=>name.startsWith(authCookie)));
for(const path of ["/editorial","/editorial/reviews/demo-madrid","/editorial/reviews/demo-warning","/editorial/reviews/demo-corrected","/editorial?scenario=empty"]) {
  const response=await request(path,jar);assert.equal(response.status,200);const html=await response.text();assert.match(html,/Datos simulados/);assert.match(response.headers.get("x-robots-tag"),/noindex/);
}
results.push({case:"real local OTP login and authorized UI-06 fixtures",status:"PASS"});

const outsiderJar=new Map();
const outsiderLink=await admin.auth.admin.generateLink({type:"magiclink",email:outsiderEmail});
assert.ok(!outsiderLink.error,"LOCAL_OUTSIDER_LINK_FAILED");
const outsiderClient=createServerClient(config.API_URL,config.ANON_KEY,{cookieOptions:{name:authCookie,httpOnly:true,sameSite:"lax",path:"/"},cookies:{getAll:()=>[...outsiderJar].map(([name,value])=>({name,value})),setAll:changes=>changes.forEach(({name,value})=>outsiderJar.set(name,value))}});
const outsiderSession=await outsiderClient.auth.verifyOtp({token_hash:outsiderLink.data.properties.hashed_token,type:"email"});
assert.ok(!outsiderSession.error,"LOCAL_OUTSIDER_SESSION_FAILED");
await assertDenied("/editorial",outsiderJar,"unauthorized");
const outsiderApi=await request("/api/editorial/reviews/x",outsiderJar);assert.equal(outsiderApi.status,403);
results.push({case:"authenticated unauthorized API denied",status:"PASS"});

function sessionIn(jar) {
  const value=jar.get(authCookie)??[...jar].filter(([name])=>/^horizai-editorial-auth\.\d+$/.test(name)).sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value).join("");
  return JSON.parse(value.startsWith("base64-")?Buffer.from(value.slice(7),"base64url").toString():value);
}
function tamperedJar(source,patch) {
  const session={...sessionIn(source),...patch};
  return new Map([[authCookie,"base64-"+Buffer.from(JSON.stringify(session)).toString("base64url")]]);
}
// Negative storage-tampering tests; no production code trusts or constructs these assertions.
await assertDenied("/editorial",tamperedJar(outsiderJar,{user:{...sessionIn(outsiderJar).user,email:operatorEmail}}),"unauthorized");
const refreshJar=tamperedJar(jar,{expires_at:1});
const refresh=await request("/editorial",refreshJar);
assert.equal(refresh.status,200);assert.ok(refresh.headers.getSetCookie().length>0);
assert.equal((await request("/editorial",refreshJar)).status,200);
results.push({case:"SDK refresh cookie writes survive proxy response and next render",status:"PASS"});
await assertDenied("/editorial",tamperedJar(jar,{expires_at:1,refresh_token:"synthetic-expired-refresh"}),"expired");

for(const path of ["/editorial/auth/request","/editorial/auth/verify","/editorial/auth/logout"]) {
  const response=await fetch(origin+path,{method:"POST",headers:{Origin:"https://untrusted.example","Content-Type":"application/x-www-form-urlencoded"},body:"email=operator%40example.test"});
  assert.equal(response.status,403);
}
results.push({case:"cross-origin auth and logout rejected",status:"PASS"});
const publicHome=await request("/");assert.equal(publicHome.status,200);
const home=await publicHome.text();
const articlePath=home.match(/href="(\/noticias\/[^"?#]+)"/)?.[1];
assert.ok(articlePath,"EXISTING_PUBLIC_ARTICLE_REQUIRED");
for(const path of ["/?map=heat",articlePath,"/privacidad","/terminos"]) {const response=await request(path);assert.equal(response.status,200);}
results.push({case:"anonymous home, map, existing article and legal routes unaffected",status:"PASS",articlePath});
const unauthorizedLogin=await request("/editorial/login?state=unauthorized");assert.match(await unauthorizedLogin.text(),/Esta cuenta no tiene acceso editorial/);
const expiredLogin=await request("/editorial/login?state=expired");assert.match(await expiredLogin.text(),/ha caducado/);

// Retain only in ignored local files for subsequent authenticated UI checks.
await writeFile(".auth-01-local/operator-cookies.json",JSON.stringify([...refreshJar]));
const logoutJar=new Map(refreshJar);
const logout=await request("/editorial/auth/logout",logoutJar,{});assert.equal(logout.status,303);
assert.equal([...logoutJar.keys()].filter(name=>name.startsWith(authCookie)).length,0);
await assertDenied("/editorial",logoutJar,"anonymous");
results.push({case:"logout clears local HttpOnly session and denies following request",status:"PASS"});
await mkdir("artifacts/auth-01",{recursive:true});
await writeFile("artifacts/auth-01/local-integration.json",JSON.stringify({status:"PASS",provider:"real isolated local Supabase Auth",emailTransport:"local Mailpit only",results,remoteAuthWrites:0,editorialMutations:0},null,2)+"\n");
console.log(JSON.stringify({status:"PASS",cases:results.length,remoteAuthWrites:0,editorialMutations:0}));
