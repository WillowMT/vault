import { VaultError } from '../vault/format.js';
export function headers(res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}
export function checkRequest(req,origin){
  if(req.headers.host!==new URL(origin).host)throw new VaultError('Invalid host',403);
  if(req.headers['sec-fetch-site']==='cross-site')throw new VaultError('Cross-site request blocked',403);
  if(req.headers.origin&&req.headers.origin!==origin)throw new VaultError('Invalid origin',403);
  if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin)throw new VaultError('Origin required',403);
}
const inline=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm','audio/flac','video/mp4','video/webm','video/ogg','video/quicktime']);
export function contentType(mime){return inline.has(mime)?mime:'application/octet-stream';}
export function disposition(name,attachment){
  const fallback=name.replace(/[^\x20-\x7e]|["\\]/g,'_');
  const encoded=encodeURIComponent(name).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${attachment?'attachment':'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
