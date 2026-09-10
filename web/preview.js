export function fileCategory(entry){if(entry.kind==='folder')return 'folder';if(entry.mime?.startsWith('image/')&&entry.mime!=='image/svg+xml')return 'image';if(entry.mime?.startsWith('video/'))return 'video';if(entry.mime?.startsWith('audio/'))return 'audio';return 'document';}
export function fileIcon(entry){const kind=fileCategory(entry),icon=document.createElement('span');icon.className=`file-icon ${kind}`;icon.setAttribute('aria-hidden','true');icon.textContent=({folder:'▱',image:'▧',video:'▷',audio:'♫',document:'▤'})[kind];return icon;}
function isTextEntry(entry){return (entry.mime?.startsWith('text/')||/\.(txt|md|js|ts|json|css|sh|py)$/i.test(entry.name||''))&&entry.mime!=='text/html';}
async function limitedText(response){
  const reader=response.body?.getReader();
  if(!reader)return (await response.text()).slice(0,1048576);
  const decoder=new TextDecoder();let text='',total=0,done=false;
  while(!done&&total<=1048576){const chunk=await reader.read();done=chunk.done;if(chunk.value){total+=chunk.value.length;text+=decoder.decode(chunk.value,{stream:true});}}
  reader.cancel().catch(()=>{});
  if(done)text+=decoder.decode();
  return done&&total<=1048576?text:`${text.slice(0,1048576)}\n\n… (truncated)`;
}
function textPreview(content,url,signal,generation){
  const pre=document.createElement('pre');pre.className='text-preview';content.append(pre);
  fetch(url,{credentials:'same-origin',cache:'no-store',signal}).then(async response=>{
    if(signal.aborted||generation!==previewGeneration)return;
    if(!response.ok){pre.textContent='Could not load this file. You can still download it.';return;}
    const text=await limitedText(response);
    if(!signal.aborted&&generation===previewGeneration&&pre.isConnected)pre.textContent=text;
  }).catch(error=>{if(error.name!=='AbortError'&&!signal.aborted&&generation===previewGeneration&&pre.isConnected)pre.textContent='Could not load this file. You can still download it.';});
}
export function pdfPreviewMode(ua=navigator?.userAgent||''){return /safari/i.test(ua)&&!/chrome|chromium|crios|fxios|edg|android/i.test(ua)?'tab':'frame';}
function voiceNote(media){
  const wrap=document.createElement('div');wrap.className='voice-note';
  const head=document.createElement('div');head.className='voice-note-head';
  const label=document.createElement('span');label.className='voice-note-label';label.textContent='Voice note';
  const speed=document.createElement('button');speed.type='button';speed.className='voice-speed';speed.textContent='1×';
  const rates=[1,1.25,1.5,2];let index=0;
  speed.onclick=()=>{index=(index+1)%rates.length;media.playbackRate=rates[index];speed.textContent=`${rates[index]}×`;};
  head.append(label,speed);wrap.append(head,media);return wrap;
}
export function bytes(size){if(size===0)return '0 B';const units=['B','KB','MB','GB','TB'],index=Math.min(4,Math.floor(Math.log(size)/Math.log(1024)));return `${Number((size/1024**index).toFixed(index?1:0))} ${units[index]}`;}
let gallery=[],galleryKeys=null,previewGeneration=0,previewAbort,slideshowFullscreen=false;
export function setGallery(entries){gallery=entries;}
function galleryEntries(entry){return gallery.filter(item=>fileCategory(item)===fileCategory(entry));}
function galleryNav(entry,dir){
  const entries=galleryEntries(entry),index=entries.findIndex(item=>item.id===entry.id);
  if(entries.length<2||index<0)return null;
  const button=document.createElement('button');button.type='button';button.className=dir<0?'gallery-prev':'gallery-next';
  button.setAttribute('aria-label',dir<0?'Previous item':'Next item');button.textContent=dir<0?'‹':'›';
  button.onclick=()=>showPreview(entries[(index+dir+entries.length)%entries.length]);
  return button;
}
async function toggleFullscreen(){
  const generation=previewGeneration,dialog=document.querySelector('#preview-dialog');
  try{
    if(document.fullscreenElement){if(slideshowFullscreen)await document.exitFullscreen?.();slideshowFullscreen=false;}
    else if(document.documentElement.requestFullscreen){await document.documentElement.requestFullscreen();if(generation!==previewGeneration||!dialog?.open){await document.exitFullscreen?.();return;}slideshowFullscreen=Boolean(document.fullscreenElement);}
  }catch{slideshowFullscreen=false;}
}
export function clearPreview(){const dialog=document.querySelector('#preview-dialog');if(!dialog)return;previewGeneration++;previewAbort?.abort();previewAbort=undefined;if(slideshowFullscreen&&document.fullscreenElement){const exiting=document.exitFullscreen?.();exiting?.catch(()=>{});}slideshowFullscreen=false;if(galleryKeys){dialog.removeEventListener('keydown',galleryKeys);galleryKeys=null;}dialog.classList.remove('slideshow');for(const media of dialog.querySelectorAll('audio,video')){media.onerror=null;media.pause();media.removeAttribute('src');media.load();}dialog.querySelector('#preview-content').replaceChildren();dialog.querySelector('#preview-title').textContent='';dialog.querySelector('#preview-meta').textContent='';dialog.querySelector('#preview-download').removeAttribute('href');dialog.close();}
export function showPreview(entry){
  clearPreview();const dialog=document.querySelector('#preview-dialog'),content=document.querySelector('#preview-content');
  const generation=previewGeneration;previewAbort=new AbortController();const {signal}=previewAbort;
  document.querySelector('#preview-title').textContent=entry.name;document.querySelector('#preview-meta').textContent=`${bytes(entry.size)} · ${entry.mime||'File'}`;
  const url=`/api/files/${entry.id}/content`,download=document.querySelector('#preview-download');download.href=`/api/files/${entry.id}/download`;download.download=entry.name;
  const supported=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm','audio/flac','video/mp4','video/webm','video/ogg','video/quicktime']);
  const kind=fileCategory(entry);
  if(entry.mime==='application/pdf'){
    if(pdfPreviewMode()==='frame'){
      const frame=document.createElement('iframe');frame.className='pdf-frame';frame.src=url;frame.title=entry.name;content.append(frame);
    }else{
      const panel=document.createElement('div');panel.className='unsupported-preview';
      const p=document.createElement('p');p.textContent='Safari cannot show PDFs inside this dialog. Open it in a new tab — it stays in your private local session.';
      const open=document.createElement('button');open.type='button';open.className='button primary pdf-open';open.textContent='Open PDF in a new tab';
      open.onclick=()=>window.open(url,'_blank','noopener');
      panel.append(p,open);content.append(panel);
    }
  }else if(isTextEntry(entry)){
    textPreview(content,url,signal,generation);
  }else if(supported.has(entry.mime)){
    const media=document.createElement(kind==='image'?'img':kind==='video'?'video':'audio');media.src=url;
    if(kind==='image')media.alt=entry.name;else{media.controls=true;media.preload=kind==='video'?'auto':'metadata';if(kind==='video'){media.autoplay=true;media.muted=true;media.defaultMuted=true;media.playsInline=true;}}
    media.onerror=()=>{if(signal.aborted||generation!==previewGeneration)return;const p=document.createElement('p');p.textContent='This browser cannot preview this format. You can still download the original.';content.replaceChildren(p);};
    if(kind==='image'||kind==='video'){
      dialog.classList.add('slideshow');
      const stage=document.createElement('div');stage.className='gallery-stage';stage.append(media);
      const prev=galleryNav(entry,-1),next=galleryNav(entry,1);
      if(prev&&next)stage.append(prev,next);
      galleryKeys=event=>{
        if(event.target.closest?.('video,audio,button,a,input,select,textarea'))return;
        if(event.key==='f'||event.key==='F'){event.preventDefault();void toggleFullscreen();return;}
        if(!prev||!next||(event.key!=='ArrowRight'&&event.key!=='ArrowLeft'))return;
        event.preventDefault();(event.key==='ArrowRight'?next:prev).click();
      };
      dialog.addEventListener('keydown',galleryKeys);
      const entries=galleryEntries(entry),index=entries.findIndex(item=>item.id===entry.id);
      const counter=document.createElement('span');counter.className='gallery-counter';counter.textContent=`${index+1} / ${entries.length}`;
      const fullscreen=document.createElement('button');fullscreen.type='button';fullscreen.className='gallery-fullscreen';fullscreen.setAttribute('aria-label','Toggle fullscreen');fullscreen.textContent='⛶';
      fullscreen.onclick=()=>void toggleFullscreen();
      const bar=document.createElement('div');bar.className='gallery-bar';bar.append(counter,fullscreen);
      content.append(stage,bar);
    }else content.append(kind==='audio'?voiceNote(media):media);
  }else{
    const panel=document.createElement('div');panel.className='unsupported-preview';panel.append(fileIcon(entry));const p=document.createElement('p');p.textContent='This file is safely stored. Download it to open in its own app.';panel.append(p);content.append(panel);
  }dialog.showModal();
}
