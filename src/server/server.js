import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createSession } from './session.js';
import { headers,checkRequest,contentType,disposition } from './security.js';
import { parseRange } from './ranges.js';
import { VaultError } from '../vault/format.js';
const assets=new Map([['/','index.html'],['/styles.css','styles.css'],['/app.js','app.js'],['/api.js','api.js'],['/preview.js','preview.js'],['/thumbnails.js','thumbnails.js']]);
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));}
async function body(req){
  let length=0;const parts=[];
  for await(const part of req){length+=part.length;if(length>16384)throw new VaultError('Request too large',413);parts.push(part);}
  try{const value=JSON.parse(Buffer.concat(parts).toString());if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
  catch{throw new VaultError('Invalid JSON request');}
}
export async function startServer(vault){
  const session=createSession(),sockets=new Set(),pending=new Set();let origin,closed=false,closePromise;
  const server=createServer({requestTimeout:0,headersTimeout:15000,maxHeaderSize:16384},(req,res)=>{
    const work=handle(req,res).catch(error=>{
      if(res.headersSent){res.destroy();return;}
      const status=error.code==='ENOSPC'?507:(error.status||500);
      json(res,status,{error:status===500?'The operation failed. The vault may contain damaged data.':status===507?'Disk is full. Free space and try again.':error.message});
    });pending.add(work);work.finally(()=>pending.delete(work));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('clientError',(_error,socket)=>socket.destroy());
  async function handle(req,res){
    headers(res);checkRequest(req,origin);
    if(closed)throw new VaultError('Vault is locked',401);
    const url=new URL(req.url,origin),path=url.pathname;
    if(req.method==='GET'&&assets.has(path)){
      const file=assets.get(path),data=await readFile(new URL(`../../web/${file}`,import.meta.url));
      res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'});res.end(data);return;
    }
    if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(path==='/api/session'&&req.method==='POST'){
      const value=await body(req),result=session.exchange(value.token);res.setHeader('Set-Cookie',result.cookie);json(res,200,{csrfToken:result.csrfToken});return;
    }
    session.authenticate(req);
    if(!['GET','HEAD'].includes(req.method))session.verifyCsrf(req);
    if(req.method==='GET'&&path==='/api/session'){json(res,200,{csrfToken:session.csrf()});return;}
    if(req.method==='GET'&&path==='/api/heartbeat'){json(res,200,{unlocked:true});return;}
    if(req.method==='GET'&&path==='/api/entries'){json(res,200,{entries:vault.list(url.searchParams.get('parentId')||null,url.searchParams.get('q')||'',{recursive:url.searchParams.get('scope')==='all'}),folders:vault.folders(),summary:vault.summary()});return;}
    if(req.method==='POST'&&path==='/api/folders'){const value=await body(req);json(res,201,await vault.mkdir(value.parentId??null,value.name));return;}
    if(req.method==='POST'&&path==='/api/files'){
      const controller=new AbortController();req.on('aborted',()=>controller.abort());
      req.setTimeout(60000,()=>{controller.abort();req.destroy();});
      const entry=await vault.upload(url.searchParams.get('parentId')||null,url.searchParams.get('name'),req.headers['content-type']||'application/octet-stream',req,controller.signal);
      req.setTimeout(0);json(res,201,entry);return;
    }
    const entryMatch=/^\/api\/entries\/([a-f0-9-]{36})$/.exec(path);
    if(entryMatch&&req.method==='PATCH'){const value=await body(req);if(Object.keys(value).some(k=>!['name','parentId'].includes(k)))throw new VaultError('Invalid file update');json(res,200,await vault.update(entryMatch[1],value));return;}
    if(entryMatch&&req.method==='DELETE'){await vault.remove(entryMatch[1]);json(res,200,{deleted:true});return;}
    const fileMatch=/^\/api\/files\/([a-f0-9-]{36})\/(content|download)$/.exec(path);
    if(fileMatch&&['GET','HEAD'].includes(req.method)){
      const entry=vault.stat(fileMatch[1]);if(entry.kind!=='file')throw new VaultError('Not a file');
      let range;try{range=parseRange(req.headers.range,entry.size);}catch(error){res.setHeader('Content-Range',`bytes */${entry.size}`);throw error;}
      const type=contentType(entry.mime),attachment=fileMatch[2]==='download'||type==='application/octet-stream';
      res.setHeader('Content-Type',type);res.setHeader('Content-Disposition',disposition(entry.name,attachment));res.setHeader('Accept-Ranges','bytes');
      if(range)res.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${entry.size}`);
      res.setHeader('Content-Length',range?range.end-range.start+1:entry.size);res.statusCode=range?206:200;
      if(req.method==='HEAD'){res.end();return;}
      await pipeline(Readable.from(vault.read(entry.id,range?.start,range?.end)),res);return;
    }
    throw new VaultError('Not found',404);
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  const api={origin,launchUrl:'',renewLaunchUrl(){return `${origin}/#${session.renew()}`;},close(){
    if(closePromise)return closePromise;closed=true;session.close();
    closePromise=(async()=>{const stopped=new Promise(resolve=>server.close(resolve));for(const socket of sockets)socket.destroy();await stopped;await Promise.allSettled([...pending]);})();return closePromise;
  }};api.launchUrl=api.renewLaunchUrl();return api;
}
