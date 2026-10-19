import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyChapter, verifyEvidence, verifyHmacReceipt } from '../src/collector.mjs';
import { serve } from '../src/server.mjs';
const id=n=>n.toString(16).padStart(32,'0');
const cfg={chapterPageId:id(1),sourceRegistryPageId:id(2),targetPageId:id(3),operationPageId:id(4),driveFileId:'1wiOK2bC0hgLbN2fOr8GdWQ68ZlfVC82X',chapterId:'SPIRIT-C0001',operationId:'SPIRIT-POLISH-C0001-20261019-P1'};
const rich=s=>({type:'rich_text',rich_text:[{plain_text:s}]});
const relation=ids=>({type:'relation',relation:ids.map(id=>({id}))});
const page=(id,properties={},extra={})=>({id,properties,last_edited_time:'2026-10-19T04:51:37.612Z',...extra});
const textBlock=(text,type='paragraph')=>({type,[type]:{rich_text:[{plain_text:text}]}});
const source='甲\n\n乙\n\n丙\n',locators=['canonical_line:1','canonical_line:3','canonical_line:5'];
const targetBlocks=[textBlock('ตอนที่ 1','heading_2'),textBlock('เรื่องเล่า'),textBlock('จบ')];
const receipt={schema:'INCHAT-QC-RECEIPT/1',chapter_id:cfg.chapterId,operation_id:cfg.operationId,source_file_id:cfg.driveFileId,target_revision:'spirit-P1',source_modified_time:'2026-10-12T15:28:49.881Z',target_last_edited_at:'2026-10-19T04:51:37.612Z',knowledge:{readback:true,evidence_id:'TEST-KNOWLEDGE-ANCHOR'},expected_source_unit_ids:locators,covered_source_unit_ids:locators,target_characters:'## ตอนที่ 1\nเรื่องเล่า\nจบ'.length,target_paragraphs:3,polish:{lanes:Array.from({length:8},(_,i)=>({lane:'P'+(i+1),readback:true,covered_source_unit_ids:locators,evidence_id:'TEST-P'+(i+1)+'-ANCHOR'})),prewrite:{trusted_sha256_gate:true,readback:true,evidence_id:'TEST-PREWRITE-ANCHOR'},closeout:{readback:true,evidence_id:'TEST-CLOSEOUT-ANCHOR'},exact_surface_residual:0,source_backcheck:true,final_target_readback:true}};
const evidence=()=>({
 chapter:page(cfg.chapterPageId,{'Chapter ID':{type:'title',title:[{plain_text:cfg.chapterId}]},'Start Locator':rich('canonical_line:1'),'End Locator':rich('canonical_line:5'),'Source':relation([cfg.sourceRegistryPageId]),'Target Page URL':{type:'url',url:'https://app.notion.com/p/'+cfg.targetPageId},'Target Revision':rich('spirit-P1'),'Translation Status':{type:'select',select:{name:'complete'}}}),
 registry:page(cfg.sourceRegistryPageId,{'Storage Ref':rich('https://drive.google.com/file/d/'+cfg.driveFileId+'/view')}),
 target:page(cfg.targetPageId),
 operation:page(cfg.operationPageId,{'Operation ID':{type:'title',title:[{plain_text:cfg.operationId}]},'Chapter Scope':relation([cfg.chapterPageId]),'Command':{type:'select',select:{name:'เกลา'}}}),
 googleMetadata:{id:cfg.driveFileId,mimeType:'text/plain',modifiedTime:'2026-10-12T15:28:49.881Z'},googleBytes:new TextEncoder().encode(source),targetBlocks,
 operationBlocks:[textBlock('TEST-KNOWLEDGE-ANCHOR TEST-PREWRITE-ANCHOR TEST-CLOSEOUT-ANCHOR '+Array.from({length:8},(_,i)=>'TEST-P'+(i+1)+'-ANCHOR').join(' ')),textBlock('INCHAT-QC-RECEIPT/1 — SPIRIT-C0001','heading_3'),textBlock(JSON.stringify(receipt),'code')]
});
const provider=()=>{const e=evidence();return {notionPage:async n=>Object.values(e).find(x=>x?.id===n),notionBlocks:async n=>n===cfg.targetPageId?e.targetBlocks:e.operationBlocks,driveMetadata:async()=>e.googleMetadata,driveContent:async()=>e.googleBytes};};
test('read-only tool cannot accept supplied content and honors scope allowlist', async()=>{
 const got=await verifyChapter('unknown',{registry:{one:cfg},provider:provider(),signer:'secret'});
 assert.equal(got.status,'UNVERIFIED'); assert.equal(got.findings[0].code,'SCOPE_NOT_CONFIGURED');
});
test('signed PASS requires trusted collector evidence + canonical receipt',()=>{
 const e=evidence();const out=verifyEvidence(cfg,e,'example signing key 01234567890123456');
 assert.equal(out.status,'PASS');assert.equal(out.origin_status,'DIRECT_PROVIDER_FETCH');
 assert.ok(verifyHmacReceipt(out,'example signing key 01234567890123456'));
 assert.equal(verifyHmacReceipt({...out,chapter_id:'tampered'},'example signing key 01234567890123456'),false);
});
test('untrusted (no signing key) can never PASS',()=>{const out=verifyEvidence(cfg,evidence(),'');assert.equal(out.status,'UNVERIFIED');assert.ok(out.findings.some(x=>x.code==='ATTESTATION_SIGNING_KEY_NOT_CONFIGURED'));});
test('false source coverage is a FAIL, not PASS',()=>{const e=evidence();const r=structuredClone(receipt);r.covered_source_unit_ids.pop();e.operationBlocks[2]=textBlock(JSON.stringify(r),'code');const out=verifyEvidence(cfg,e,'abcdefghijklmnopqrstuvwxyz0123456789');assert.equal(out.status,'FAIL');assert.ok(out.findings.some(x=>x.code==='SOURCE_COVERAGE_MISMATCH'));});
test('stale source metadata becomes FAIL',()=>{const e=evidence();e.googleMetadata.modifiedTime='2026-10-18T12:00:00Z';const out=verifyEvidence(cfg,e,'abcdefghijklmnopqrstuvwxyz0123456789');assert.equal(out.status,'FAIL');});
test('notion normalized target mismatch stays UNVERIFIED',()=>{const e=evidence();e.targetBlocks[1]=textBlock('expanded');const out=verifyEvidence(cfg,e,'abcdefghijklmnopqrstuvwxyz0123456789');assert.equal(out.status,'UNVERIFIED');assert.ok(out.findings.some(x=>x.code==='TARGET_CANONICALIZATION_MISMATCH'));});
test('source identity mismatch fails closed',()=>{const e=evidence();e.registry.properties['Storage Ref']=rich('https://drive.google.com/file/d/another-id/view');const out=verifyEvidence(cfg,e,'abcdefghijklmnopqrstuvwxyz0123456789');assert.equal(out.status,'FAIL');});
test('provider error and missing config fail closed',async()=>{const out=await verifyChapter('one',{registry:{one:cfg},provider:{notionPage:async()=>{throw Error('NOTION_AUTH_NOT_CONFIGURED')}},signer:'abcdefghijklmnopqrstuvwxyz0123456789'});assert.equal(out.status,'UNVERIFIED');});
test('MCP server rejects unauthorized calls and returns tool metadata',async()=>{
 const server=serve({env:{MCP_BEARER_TOKEN:'0123456789abcdefghij1234567890xy',AUDIT_SCOPE_JSON:'{}'}});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 try {
 const base=`http://127.0.0.1:${server.address().port}`;
 const unauthorized=await fetch(base+'/mcp',{method:'POST',headers:{accept:'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(unauthorized.status,401);
 const authorized=await fetch(base+'/mcp',{method:'POST',headers:{accept:'application/json',authorization:'Bearer 0123456789abcdefghij1234567890xy'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})});assert.equal(authorized.status,200);
 assert.equal((await authorized.json()).result.tools[0].name,'verify_chapter');
 }finally{await new Promise(ok=>server.close(ok));}
});