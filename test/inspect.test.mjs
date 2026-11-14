import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,symlinkSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {run} from '../src/action.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(t,files={'source.md':'Read the documentation.'},overrides={},respond){
 const cwd=mkdtempSync(join(tmpdir(),'ink-inspect-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 for(const [p,text]of Object.entries(files)){mkdirSync(join(cwd,p,'..'),{recursive:true});writeFileSync(join(cwd,p),text);}
 let calls=0,log='';
 const env={GITHUB_WORKSPACE:cwd,RUNNER_TEMP:cwd,GITHUB_STEP_SUMMARY:join(cwd,'summary'),INPUT_MODE:'inspect',INPUT_API_KEY:'lk_'+'a'.repeat(32),INPUT_INSPECT_PATHS:Object.keys(files).join('\n'),...overrides};
 const go=()=>run({env,stdout:s=>log+=s,sleep:async()=>{},fetch:async(url,init)=>{
 calls++;assert.equal(url,'https://llms.ink/api/v0/inspect');assert.equal(init.redirect,'error');const b=JSON.parse(init.body),text=b.format==='json'?JSON.stringify(b.content):b.content;
 const r={detection:'no_finding',coverage:'complete',recommendation:'continue',reason:'no_finding',modelRevision:'4a43fec65a670e48835d8e8c85c705b4b0d1c907',policyRevision:'llms-ink-inspect-1',preprocessingRevision:'utf8-json-stringify-1',contentDigest:sha(text),inputTokens:4,inspectedTokens:4,windows:1,enforced:false};return respond?respond(r,init,calls):Response.json(r);
 }});
 return {cwd,env,go,calls:()=>calls,log:()=>log};
}
test('inspect is opt-in, requires a key and explicit paths, and rejects privileged PR events',async t=>{
 for(const overrides of [{INPUT_API_KEY:''},{INPUT_INSPECT_PATHS:''},{GITHUB_EVENT_NAME:'pull_request_target'}]){const f=fixture(t,undefined,overrides);assert.equal((await f.go()).ok,false);assert.equal(f.calls(),0);}
});
test('all file validation happens before sending; rejects traversal, symlinks, missing, oversized and invalid files',async t=>{
 for(const [files,paths]of [[{'a.md':'ok'},'a.md\nmissing.md'],[{'a.md':'ok'},'../secret.txt'],[{'a.md':'ok'},'.env'],[{'a.md':'x'.repeat(131073)},'a.md'],[{'a.json':'{invalid'},'a.json'],[{'a.md':Buffer.from([0xff])},'a.md'],[{'a.md':'ok'},'a.md\na.md']]){const f=fixture(t,files,{INPUT_INSPECT_PATHS:paths});assert.equal((await f.go()).ok,false);assert.equal(f.calls(),0);}
 const f=fixture(t,{'a.md':'ok'},{INPUT_INSPECT_PATHS:'link.md'});symlinkSync(join(f.cwd,'a.md'),join(f.cwd,'link.md'));assert.equal((await f.go()).ok,false);assert.equal(f.calls(),0);
});
test('complete receipts are digest-bound, saved without source text and exposed as outputs',async t=>{
 const secret='UNIQUE_PRIVATE_CONTENT',f=fixture(t,{'a.md':secret,'b.json':'{ "value": "hello" }'},{LLMS_INK_API:'https://attacker.invalid'});
 const result=await f.go();assert.equal(result.ok,true);assert.equal(result.outputs['inspection-clean'],'2');
 const report=readFileSync(result.outputs['inspection-report'],'utf8');assert.ok(!report.includes(secret));assert.ok(!f.log().includes(secret));assert.ok(!readFileSync(f.env.GITHUB_STEP_SUMMARY,'utf8').includes(secret));const r=JSON.parse(report);assert.equal(r.files[0].sourceDigest,sha(secret));assert.notEqual(r.files[1].sourceDigest,r.files[1].contentDigest);
});
test('flagged and incomplete receipts fail the run, with filenames but no excerpts',async t=>{
 for(const mutate of [r=>({...r,detection:'flagged',recommendation:'withhold',reason:'instruction_pattern'}),r=>({...r,coverage:'partial'}),r=>({...r,contentDigest:'bad'}),r=>({...r,inspectedTokens:1}),r=>({...r,policyRevision:'unknown'})]){const f=fixture(t,undefined,{},r=>Response.json(mutate(r)));const result=await f.go();assert.equal(result.ok,false);assert.match(f.log(),/::error file=source.md/);}
});
test('HTTP failures, redirects, malformed JSON and service errors never pass or leak raw errors',async t=>{
 for(const reply of [()=>new Response('PRIVATE_ERROR',{status:403}),()=>Response.json({detail:'PRIVATE_ERROR'},{status:429}),()=>{throw new Error('PRIVATE_ERROR');},r=>Response.json(r,{status:503}),()=>new Response('x'.repeat(17000))]){const f=fixture(t,undefined,{},reply);assert.equal((await f.go()).ok,false);assert.ok(!f.log().includes('PRIVATE_ERROR'));assert.ok(!readFileSync(f.env.GITHUB_STEP_SUMMARY,'utf8').includes('PRIVATE_ERROR'));}
});
test('retry is bounded, respects capacity hints, and does not retry exhausted daily quota',async t=>{
 const f=fixture(t,undefined,{},(r,init,n)=>n<3?Response.json({},{status:429,headers:{'retry-after':'5'}}):Response.json(r));assert.equal((await f.go()).ok,true);assert.equal(f.calls(),3);
 const q=fixture(t,undefined,{},()=>Response.json({},{status:429,headers:{'retry-after':'3600'}}));assert.equal((await q.go()).ok,false);assert.equal(q.calls(),1);
});

test('shared receipt conformance corpus',async()=>{
 const {validateReceipt}=await import('../src/inspect.mjs');
 const {cases}=JSON.parse(readFileSync(new URL('fixtures/inspect-receipts-v1.json',import.meta.url)));
 for(const c of cases)assert.equal(validateReceipt(c.receipt,c.digest,c.status),c.valid,c.name);
});
