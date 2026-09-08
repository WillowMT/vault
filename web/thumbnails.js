import {fileCategory,fileIcon} from './preview.js';
const MAX=320,TIMEOUT=10000,LIMIT=3;
const THUMBABLE=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','video/mp4','video/webm','video/ogg','video/quicktime']);
const cache=new Map(),pending=new Map(),jobs=new Map();
let queue=[],active=0,override=null,observer=null;
const cacheKey=entry=>`${entry.id}:${entry.size}`;
export function setThumbnailGenerator(fn){override=fn;}
function withTimeout(promise){return Promise.race([promise,new Promise(resolve=>setTimeout(()=>resolve(null),TIMEOUT))]);}
function drawToBlob(source,width,height){
  const canvas=document.createElement('canvas'),scale=Math.min(1,MAX/Math.max(width,height,1));
  canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
  const context=canvas.getContext('2d');if(!context)return Promise.resolve(null);
  context.drawImage(source,0,0,canvas.width,canvas.height);
  return new Promise(resolve=>{canvas.toBlob(blob=>resolve(blob?URL.createObjectURL(blob):null),'image/jpeg',0.75);});
}
function loadImage(url){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=url;});}
function releaseMedia(media){media.removeAttribute('src');media.load();}
function loadVideoFrame(url){return new Promise((resolve,reject)=>{
  const video=document.createElement('video');video.muted=true;video.preload='metadata';
  video.onloadedmetadata=()=>{video.currentTime=Math.min(1,(video.duration||2)*0.1);};
  video.onseeked=()=>resolve(video);video.onerror=()=>{releaseMedia(video);reject(new Error('thumbnail video failed'));};video.src=url;});}
function defaultGenerator(entry){
  if(fileCategory(entry)==='video')return loadVideoFrame(`/api/files/${entry.id}/content`).then(video=>drawToBlob(video,video.videoWidth,video.videoHeight).then(url=>{releaseMedia(video);return url;}));
  return loadImage(`/api/files/${entry.id}/content`).then(img=>drawToBlob(img,img.naturalWidth,img.naturalHeight));
}
function schedule(job){return new Promise(resolve=>{queue.push({job,resolve});runQueue();});}
function runQueue(){while(active<LIMIT&&queue.length){active++;const {job,resolve}=queue.shift();job().then(value=>resolve(value)).finally(()=>{active--;runQueue();});}}
export function thumbnailFor(entry){
  if(!THUMBABLE.has(entry.mime))return Promise.resolve(null);
  const key=cacheKey(entry);
  if(cache.has(key))return Promise.resolve(cache.get(key));
  if(pending.has(key))return pending.get(key);
  const promise=schedule(()=>withTimeout((override||defaultGenerator)(entry)))
    .then(url=>{pending.delete(key);if(url){cache.set(key,url);return url;}return null;})
    .catch(()=>{pending.delete(key);return null;});
  pending.set(key,promise);return promise;
}
function ensureObserver(){
  if(observer||typeof IntersectionObserver==='undefined')return observer;
  observer=new IntersectionObserver(records=>{
    for(const record of records)if(record.isIntersecting){observer.unobserve(record.target);const run=jobs.get(record.target);if(run){jobs.delete(record.target);run();}}
  },{rootMargin:'200px'});
  return observer;
}
function apply(tile,url){const img=document.createElement('img');img.alt='';img.src=url;tile.replaceChildren(img);}
export function attachThumbnail(tile,entry){
  tile.append(fileIcon(entry));
  if(cache.has(cacheKey(entry))){apply(tile,cache.get(cacheKey(entry)));return;}
  const run=()=>{thumbnailFor(entry).then(url=>{if(url&&tile.isConnected)apply(tile,url);}).catch(()=>{});};
  const obs=ensureObserver();
  if(obs){jobs.set(tile,run);obs.observe(tile);}else run();
}
export function revokeThumbnails(){
  for(const url of cache.values())URL.revokeObjectURL(url);
  cache.clear();pending.clear();jobs.clear();queue=[];active=0;
  observer?.disconnect();observer=null;
}
