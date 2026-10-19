import { createHash, createHmac, createSign, timingSafeEqual } from 'node:crypto';

const HEX_ID = /^[0-9a-f]{32}$/i;
const GDRIVE_ID = /^[a-zA-Z0-9_-]{10,128}$/;
const hexHash = s => createHash('sha256').update(s, 'utf8').digest('hex');
const decodeUtf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const compact = s => String(s || '').replace(/-/g, '').toLowerCase();
const cleanId = id => {
  const s = compact(id);
  if (!HEX_ID.test(s)) throw new Error('INVALID_NOTION_PAGE_ID');
  return s;
};
const value = prop => {
  if (!prop) return undefined;
  switch(prop.type) {
    case 'title': return (prop.title||[]).map(x=>x.plain_text||x.text?.content||'').join('');
    case 'rich_text': return (prop.rich_text||[]).map(x=>x.plain_text||x.text?.content||'').join('');
    case 'url': return prop.url;
    case 'number': return prop.number;
    case 'select': return prop.select?.name;
    case 'relation': return (prop.relation||[]).map(x=>compact(x.id));
    default: return prop;
  }
};
const props = page => Object.fromEntries(Object.entries(page.properties||{}).map(([k,v])=>[k,value(v)]));
const asArray = x => Array.isArray(x) ? x : [];
const eqOrdered = (a,b) => Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const normalizeSource = s => String(s).replace(/\r\n?/g,'\n').normalize('NFC');
const unitLocators = (s,start,end) => {
  const x=normalizeSource(s).replace(/\n$/,'').split('\n');
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>x.length) return null;
  return {physicalLines:x.length,ids:x.flatMap((line,i)=>i+1>=start&&i+1<=end&&line.trim()?[`canonical_line:${i+1}`]:[])};
};
const allBlocksText = blocks => {
  // Notion's API rich_text is flattened as the page-body representation, not source of truth for a prior markdown digest.
  const getText = b => {
    const x = b[b.type]||{};
    return (x.rich_text||[]).map(z=>z.plain_text||z.text?.content||'').join('');
  };
  return blocks.map(getText).join('\n').trim();
};
const canonicalTarget = blocks => {
  const allowed=new Set(['heading_1','heading_2','heading_3','paragraph','quote','bulleted_list_item','numbered_list_item']);
  if(blocks.some(b=>!allowed.has(b.type)))return null;
  const prefixes={heading_1:'# ',heading_2:'## ',heading_3:'### ',paragraph:'',quote:'> ',bulleted_list_item:'- ',numbered_list_item:'1. '};
  // Adapt Notion API rich-text to the deterministic enhanced-markdown subset used by the current novel.
  // This is deliberately narrow; unsupported rich-text attributes require a separate reviewed adapter.
  const result=[];
  for(const b of blocks){
    const pieces=b[b.type]?.rich_text||[];
    if(pieces.some(p=>p.annotations&&(p.annotations.bold||p.annotations.italic||p.annotations.code||p.annotations.strikethrough||p.annotations.underline)||p.href))return null;
    const plain=pieces.map(p=>p.plain_text||p.text?.content||'').join('');
    result.push(prefixes[b.type]+plain.replace(/(?<!\\)~/g,'\\~'));
  }
  return result.join('\n').trim();
};
const extractReceipt = (blocks,chapterId) => {
  const strings=blocks.map(b=>(b[b.type]?.rich_text||[]).map(z=>z.plain_text||z.text?.content||'').join(''));
  // Parse the exact canonical receipt header and following JSON code block or fenced JSON.
  const re=new RegExp(`^INCHAT-QC-RECEIPT/1\\s+[—-]\\s*${chapterId}$`);
  let matches=[];
  for(let i=0;i<blocks.length;i++) {
    if(!re.test(strings[i].replace(/^#{1,4}\s*/,''))) continue;
    for(let j=i+1;j<Math.min(i+6,blocks.length);j++) {
      let txt=strings[j].trim();
      if(txt.startsWith('```json'))txt=txt.replace(/^```json\s*/,'').replace(/\s*```$/,'');
      if(!txt.startsWith('{'))continue;
      try { const o=JSON.parse(txt); if(o.chapter_id===chapterId)matches.push(o); break; } catch {}
    }
  }
  // Conservative fallback for a single markdown-style block spanning header and code.
  if(!matches.length){const text=strings.join('\n'),m=text.match(new RegExp(`### INCHAT-QC-RECEIPT/1 [—-] ${chapterId}\\s*\\n\\x60\\x60\\x60json\\s*\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`));if(m){try{matches.push(JSON.parse(m[1]));}catch{}}}
  return matches.length===1?matches[0]:null;
};
const timeoutFetch = async (fetcher,url,options={}) => {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  try {return await fetcher(url,{...options,signal:controller.signal});} finally {clearTimeout(timer);}
};
const throwHttp = (service,status) => {
  const e=new Error(service+'_HTTP_'+status);e.status=status;throw e;
};
export function makeProvider({fetcher=fetch,env=process.env}={}) {
  const notionToken=env.NOTION_TOKEN;
  const notionVersion=env.NOTION_VERSION||'2025-09-03';
  let googleAccessToken=null, expires=0;
  const notion = async path => {
    if(!notionToken)throw new Error('NOTION_AUTH_NOT_CONFIGURED');
    const res=await timeoutFetch(fetcher,`https://api.notion.com/v1/${path}`,{headers:{Authorization:`Bearer ${notionToken}`,'Notion-Version':notionVersion,Accept:'application/json'}});
    if(!res.ok)throwHttp('NOTION',res.status);
    return res.json();
  };
  const blocks = async pageId => {
    const out=[];let cursor;
    for(let i=0;i<100;i++){
      const qs=new URLSearchParams({page_size:'100'});if(cursor)qs.set('start_cursor',cursor);
      const p=await notion(`blocks/${cleanId(pageId)}/children?${qs.toString()}`);
      out.push(...asArray(p.results));
      if(out.length>10000)throw new Error('NOTION_BLOCK_LIMIT');
      if(!p.has_more)return out;
      if(!p.next_cursor||p.next_cursor===cursor)throw new Error('NOTION_PAGINATION_INVALID');
      cursor=p.next_cursor;
    }
    throw new Error('NOTION_PAGINATION_LIMIT');
  };
  const token = async ()=> {
    if(googleAccessToken&&Date.now()<expires-90000)return googleAccessToken;
    let params;
    if(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64){
      let key;try{key=JSON.parse(Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64,'base64').toString('utf8'));}catch{throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_INVALID');}
      if(!key.client_email||!key.private_key)throw new Error('GOOGLE_SERVICE_ACCOUNT_INVALID');
      const jwtPart=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
      const now=Math.floor(Date.now()/1000);
      const unsigned=jwtPart({alg:'RS256',typ:'JWT'})+'.'+jwtPart({iss:key.client_email,scope:'https://www.googleapis.com/auth/drive.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3300});
      const signature=createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
      params=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature});
    }else{
      for(const k of ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'])if(!env[k])throw new Error('GOOGLE_AUTH_NOT_CONFIGURED');
      params=new URLSearchParams({grant_type:'refresh_token',client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:env.GOOGLE_REFRESH_TOKEN});
    }
    const r=await timeoutFetch(fetcher,'https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params});
    if(!r.ok)throwHttp('GOOGLE_OAUTH',r.status);
    const o=await r.json();if(!o.access_token||!Number.isFinite(Number(o.expires_in)))throw new Error('GOOGLE_TOKEN_INVALID');
    googleAccessToken=o.access_token;expires=Date.now()+Number(o.expires_in)*1000;return googleAccessToken;
  };
  const driveGet = async (fileId,media=false) => {
    if(!GDRIVE_ID.test(fileId))throw new Error('INVALID_DRIVE_FILE_ID');
    const fields='id,name,mimeType,modifiedTime,size,md5Checksum';
    const path=media?'?alt=media':`?fields=${encodeURIComponent(fields)}`;
    const r=await timeoutFetch(fetcher,`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}${path}`,{headers:{Authorization:`Bearer ${await token()}`}});
    if(!r.ok)throwHttp('DRIVE',r.status);
    return media?new Uint8Array(await r.arrayBuffer()):r.json();
  };
  return {notionPage:id=>notion(`pages/${cleanId(id)}`),notionBlocks:blocks,driveMetadata:id=>driveGet(id,false),driveContent:id=>driveGet(id,true)};
}
export function verifyEvidence(record, evidence, signer) {
  const findings=[];
  const fail = (code,details='')=> findings.push({severity:'FAIL',code,details});
  const unknown = (code,details='')=> findings.push({severity:'UNVERIFIED',code,details});
  const n=record;
  const cb=props(evidence.chapter), src=props(evidence.registry),op=props(evidence.operation);
  const s=(id)=>cleanId(id);
  if (cb['Chapter ID']!==n.chapterId)fail('CHAPTER_ID_MISMATCH');
  if (op['Operation ID']!==n.operationId)fail('OPERATION_ID_MISMATCH');
  if (op.Command!=='เกลา'&&op.Command!=='แปล'&&op.Command!=='แปลแล้วเกลา')fail('COMMAND_OUT_OF_SCOPE');
  if (!asArray(op['Chapter Scope']).includes(s(n.chapterPageId)))fail('OPERATION_CHAPTER_BINDING_INVALID');
  if (!asArray(cb.Source).includes(s(n.sourceRegistryPageId)))fail('SOURCE_REGISTRY_RELATION_INVALID');
  const targetProp=String(cb['Target Page URL']||'');
  if (!targetProp.toLowerCase().replace(/-/g,'').includes(s(n.targetPageId)))fail('TARGET_RELATION_INVALID');
  const storage=String(src['Storage Ref']||'');
  if(!storage.includes(n.driveFileId))fail('DRIVE_REFERENCE_MISMATCH');
  if (evidence.googleMetadata.id!==n.driveFileId||evidence.googleMetadata.mimeType!=='text/plain')fail('GOOGLE_DRIVE_METADATA_MISMATCH');
  const bytes=evidence.googleBytes;
  let sourceText='';try {sourceText=decodeUtf8(bytes);} catch {fail('SOURCE_UTF8_INVALID');}
  const start=/^canonical_line:(\d+)$/.exec(cb['Start Locator']||''),end=/^canonical_line:(\d+)$/.exec(cb['End Locator']||'');
  const units=start&&end?unitLocators(sourceText,Number(start[1]),Number(end[1])):null;
  if(!units)fail('CANONICAL_SOURCE_BOUNDARY_INVALID');
  const chapterText=canonicalTarget(evidence.targetBlocks), tBlocks=evidence.targetBlocks.filter(b=>b.type!=='child_page'&&b.type!=='child_database');
  const targetParagraphs=tBlocks.map(b=>(b[b.type]?.rich_text||[]).map(x=>x.plain_text||x.text?.content||'').join('')).filter(s=>s.trim()).length;
  if(chapterText===null)unknown('TARGET_CANONICAL_PROFILE_UNSUPPORTED');
  const rec=extractReceipt(evidence.operationBlocks,n.chapterId);
  if(!rec)unknown('CANONICAL_RECEIPT_NOT_READABLE');
  else {
    const eq=(k,a,b)=>{if(a!==b)fail(k,`${String(a).slice(0,70)} != ${String(b).slice(0,70)}`)};
    eq('RECEIPT_CHAPTER_ID',rec.chapter_id,n.chapterId);
    eq('RECEIPT_OPERATION_ID',rec.operation_id,n.operationId);
    eq('RECEIPT_SOURCE_ID',rec.source_file_id,n.driveFileId);
    eq('RECEIPT_TARGET_REVISION',rec.target_revision,cb['Target Revision']);
    if(units){if(!eqOrdered(rec.expected_source_unit_ids,units.ids))fail('SOURCE_UNITS_WRONG');if(!eqOrdered(rec.covered_source_unit_ids,units.ids))fail('SOURCE_COVERAGE_MISMATCH');}
    if(rec.source_modified_time!==evidence.googleMetadata.modifiedTime)fail('SOURCE_MODIFIED_TIME_CHANGED');
    if(rec.target_last_edited_at!==evidence.target.last_edited_time)fail('TARGET_LAST_EDIT_CHANGED');
    if(!rec.knowledge?.readback||!rec.knowledge?.evidence_id)unknown('KNOWLEDGE_READBACK_UNPROVEN');
    const opEvidence=allBlocksText(evidence.operationBlocks.filter(b=>b.type!=='code'));
    const anchor=id=>typeof id==='string'&&id.length>=9&&opEvidence.includes(id);
    if(rec.knowledge?.evidence_id&&!anchor(rec.knowledge.evidence_id))unknown('KNOWLEDGE_EVIDENCE_ANCHOR_MISSING');
    // Provider text versus Notion-enhanced Markdown differs; a mismatch is UNVERIFIED rather than fabricated FAIL.
    if(chapterText!==null&&(rec.target_characters!==chapterText.length||rec.target_paragraphs!==targetParagraphs))unknown('TARGET_CANONICALIZATION_MISMATCH',`provider:${chapterText.length}/${targetParagraphs};receipt:${rec.target_characters}/${rec.target_paragraphs}`);
    if(!rec.polish?.lanes||rec.polish.lanes.length!==8||rec.polish.lanes.some((p,i)=>p.lane!==`P${i+1}`||p.readback!==true||!eqOrdered(p.covered_source_unit_ids,units?.ids)||!anchor(p.evidence_id)))fail('POLISH_RECEIPT_INCOMPLETE');
    if(!rec.polish?.closeout?.readback||!anchor(rec.polish.closeout.evidence_id))unknown('CLOSEOUT_NOT_ANCHORED');
    if(rec.polish?.exact_surface_residual!==0)fail('EXACT_SURFACE_RESIDUAL');
    if(!rec.polish?.prewrite?.trusted_sha256_gate||rec.polish?.prewrite?.readback!==true||!anchor(rec.polish?.prewrite?.evidence_id))fail('PREWRITE_EVIDENCE_INCOMPLETE');
    if(rec.polish?.source_backcheck!==true||rec.polish?.final_target_readback!==true)fail('FINAL_READBACK_NOT_CONFIRMED');
  }
  if(cb['Translation Status']!=='complete')unknown('CHAPTER_NOT_COMPLETE');
  if(!signer||Buffer.byteLength(signer,'utf8')<32)unknown('ATTESTATION_SIGNING_KEY_NOT_CONFIGURED');
  const severity = findings.some(f=>f.severity==='FAIL')?'FAIL':findings.length?'UNVERIFIED':'PASS';
  const collectedAt=new Date().toISOString();
  const data={schema:'TRANSLATION-AUDIT-ORIGIN/1',collector_version:'0.1.0',status:severity,origin_status:!findings.some(f=>f.code.includes('BINDING')||f.code.includes('REFERENCE')||f.code.includes('METADATA'))?'DIRECT_PROVIDER_FETCH':'CONFLICT',source:{id:n.driveFileId,modified:evidence.googleMetadata.modifiedTime,sha256:hexHash(sourceText),units:units?.ids.length??0},target:{page_id:n.targetPageId,last_edited:evidence.target.last_edited_time||'',sha256:chapterText===null?null:hexHash(chapterText),characters:chapterText?.length??null,paragraphs:targetParagraphs,canonical_profile:'notion-enhanced-markdown-subset-v1'},chapter_id:n.chapterId,operation_id:n.operationId,collected_at:collectedAt,findings};
  if(signer&&Buffer.byteLength(signer,'utf8')>=32&&severity==='PASS'){data.attestation={algorithm:'HMAC-SHA256',key_id:'render-managed-v1',signature:createHmac('sha256',signer).update(JSON.stringify(data)).digest('hex')};}
  return data;
}
export async function verifyChapter(scope, {registry,provider,signer}) {
  const n=registry[scope];
  if(!n)return {schema:'TRANSLATION-AUDIT-ORIGIN/1',status:'UNVERIFIED',findings:[{severity:'UNVERIFIED',code:'SCOPE_NOT_CONFIGURED'}]};
  const fields=['chapterPageId','sourceRegistryPageId','targetPageId','operationPageId','driveFileId','chapterId','operationId'];
  if(fields.some(k=>!n[k]))return {schema:'TRANSLATION-AUDIT-ORIGIN/1',status:'UNVERIFIED',findings:[{severity:'UNVERIFIED',code:'SCOPE_REGISTRY_INCOMPLETE'}]};
  const p=provider;
  try {
    if(['notionPage','notionBlocks','driveMetadata','driveContent'].some(k=>typeof p?.[k]!=='function'))throw new Error('PROVIDER_NOT_CONFIGURED');
    // No Source or Target content is accepted from the model; collect directly from provider APIs.
    const [chapter,registryPage,target,operation,googleMetadata,googleBytes]=await Promise.all([
      p.notionPage(n.chapterPageId),p.notionPage(n.sourceRegistryPageId),p.notionPage(n.targetPageId),p.notionPage(n.operationPageId),p.driveMetadata(n.driveFileId),p.driveContent(n.driveFileId)
    ]);
    for(const [got,expected,name] of [[chapter,n.chapterPageId,'CHAPTER'],[registryPage,n.sourceRegistryPageId,'SOURCE'],[target,n.targetPageId,'TARGET'],[operation,n.operationPageId,'OPERATION']])if(compact(got.id)!==compact(expected))throw new Error(`${name}_PROVIDER_ID_MISMATCH`);
    const [targetBlocks,operationBlocks]=await Promise.all([p.notionBlocks(n.targetPageId),p.notionBlocks(n.operationPageId)]);
    return verifyEvidence(n,{chapter,registry:registryPage,target,operation,googleMetadata,googleBytes,targetBlocks,operationBlocks},signer);
  } catch(e) {
    const code=String(e?.message||'COLLECTION_FAILED').slice(0,100);
    const contradiction=/PROVIDER_ID_MISMATCH|INVALID_|WRONG/.test(code);
    return {schema:'TRANSLATION-AUDIT-ORIGIN/1',status:contradiction?'FAIL':'UNVERIFIED',origin_status:'NOT_ATTESTED',scope,findings:[{severity:contradiction?'FAIL':'UNVERIFIED',code}]};
  }
}
export function verifyHmacReceipt(report, secret) {
  if(!report?.attestation?.signature||!secret)return false;
  const {attestation,...data}=report;
  const expected=createHmac('sha256',secret).update(JSON.stringify(data)).digest();
  const actual=Buffer.from(attestation.signature,'hex');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}