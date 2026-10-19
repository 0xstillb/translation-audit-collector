import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { makeProvider, verifyChapter } from './collector.mjs';

const maxBody=8192;
const constantEq=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const reply=(res,status,obj,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(obj));};
const err=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
function serve({env=process.env}={}) {
  const provider=makeProvider({env});
  let scopes={};
  try {scopes=JSON.parse(env.AUDIT_SCOPE_JSON||'{}');}catch{throw new Error('Invalid AUDIT_SCOPE_JSON')}
  const token=env.MCP_BEARER_TOKEN||'';
  const signing=env.ATTESTATION_SIGNING_SECRET||'';
  return createServer(async(req,res)=>{
    const path=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`).pathname;
    if(req.method==='GET'&&path==='/healthz'){reply(res,200,{ok:true,service:'translation-audit-collector',mode:'read_only',scope_count:Object.keys(scopes).length});return;}
    if(path!=='/mcp'){reply(res,404,{error:'NOT_FOUND'});return;}
    if(!token||Buffer.byteLength(token,'utf8')<32){reply(res,503,{error:'AUTH_NOT_CONFIGURED'});return;}
    if(!constantEq(req.headers.authorization||'',`Bearer ${token}`)){reply(res,401,{error:'UNAUTHORIZED'},{'WWW-Authenticate':'Bearer'});return;}
    if(req.method!=='POST'){reply(res,405,{error:'METHOD_NOT_ALLOWED'},{Allow:'POST'});return;}
    const accept=req.headers.accept||'';
    if(!accept.includes('application/json')&&!accept.includes('*/*')){reply(res,406,{error:'ACCEPT_APPLICATION_JSON_REQUIRED'});return;}
    let bytes=0,body='';
    try {for await(const chunk of req){bytes+=chunk.length;if(bytes>maxBody){reply(res,413,{error:'BODY_TOO_LARGE'});return;}body+=chunk.toString('utf8');}}
    catch{reply(res,400,{error:'BAD_BODY'});return;}
    let q;try{q=JSON.parse(body)}catch{reply(res,400,err(null,-32700,'Parse error'));return;}
    if(Array.isArray(q)||!q||q.jsonrpc!=='2.0'||typeof q.method!=='string'){reply(res,400,err(q?.id??null,-32600,'Invalid request'));return;}
    if(q.method==='notifications/initialized'){res.writeHead(202).end();return;}
    const id=q.id??null;
    if(q.method==='initialize'){
      reply(res,200,{jsonrpc:'2.0',id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'translation-audit-collector',version:'0.1.0'}}});return;
    }
    if(q.method==='ping'){reply(res,200,{jsonrpc:'2.0',id,result:{}});return;}
    if(q.method==='tools/list'){
      reply(res,200,{jsonrpc:'2.0',id,result:{tools:[{name:'verify_chapter',title:'Verify Chapter Evidence',description:'Read-only verification: collector fetches allowlisted Notion and Google Drive source directly, checks current bindings, coverage and P1–P8, returns FAIL/UNVERIFIED/PASS only with trusted origin and configured attestation.',inputSchema:{type:'object',properties:{scope:{type:'string',description:'Allowlisted scope key, e.g. spirit-c0001'}},required:['scope'],additionalProperties:false}}]}});return;
    }
    if(q.method==='tools/call'){
      if(q.params?.name!=='verify_chapter'||typeof q.params?.arguments?.scope!=='string'||Object.keys(q.params.arguments).some(k=>k!=='scope')){reply(res,200,err(id,-32602,'Invalid parameters'));return;}
      const out=await verifyChapter(q.params.arguments.scope,{registry:scopes,provider,signer:signing});
      reply(res,200,{jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out,isError:false}});return;
    }
    reply(res,200,err(id,-32601,'Method not found'));
  });
}
if(import.meta.url===`file://${process.argv[1]}`){const port=Number(process.env.PORT||10000);serve().listen(port,'0.0.0.0',()=>console.log(`Translation Audit MCP listening on :${port}`));}
export { serve };