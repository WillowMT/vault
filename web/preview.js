export function fileCategory(entry){if(entry.kind==='folder')return 'folder';if(entry.mime?.startsWith('image/')&&entry.mime!=='image/svg+xml')return 'image';if(entry.mime?.startsWith('video/'))return 'video';if(entry.mime?.startsWith('audio/'))return 'audio';return 'document';}
export function fileIcon(entry){const kind=fileCategory(entry),icon=document.createElement('span');icon.className=`file-icon ${kind}`;icon.setAttribute('aria-hidden','true');icon.textContent=({folder:'▱',image:'▧',video:'▷',audio:'♫',document:'▤'})[kind];return icon;}
export function bytes(size){if(size===0)return '0 B';const units=['B','KB','MB','GB','TB'],index=Math.min(4,Math.floor(Math.log(size)/Math.log(1024)));return `${Number((size/1024**index).toFixed(index?1:0))} ${units[index]}`;}
export function clearPreview(){const dialog=document.querySelector('#preview-dialog');if(!dialog)return;for(const media of dialog.querySelectorAll('audio,video')){media.pause();media.removeAttribute('src');media.load();}dialog.querySelector('#preview-content').replaceChildren();dialog.querySelector('#preview-title').textContent='';dialog.querySelector('#preview-meta').textContent='';dialog.querySelector('#preview-download').removeAttribute('href');dialog.close();}
export function showPreview(entry){
  clearPreview();const dialog=document.querySelector('#preview-dialog'),content=document.querySelector('#preview-content');
  document.querySelector('#preview-title').textContent=entry.name;document.querySelector('#preview-meta').textContent=`${bytes(entry.size)} · ${entry.mime||'File'}`;
  const url=`/api/files/${entry.id}/content`,download=document.querySelector('#preview-download');download.href=`/api/files/${entry.id}/download`;download.download=entry.name;
  const supported=new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','audio/mpeg','audio/mp4','audio/ogg','audio/wav','audio/webm','audio/flac','video/mp4','video/webm','video/ogg','video/quicktime']);
  const kind=fileCategory(entry);
  if(supported.has(entry.mime)){
    const media=document.createElement(kind==='image'?'img':kind==='video'?'video':'audio');media.src=url;
    if(kind==='image')media.alt=entry.name;else{media.controls=true;media.preload='metadata';}
    media.onerror=()=>{const p=document.createElement('p');p.textContent='This browser cannot preview this format. You can still download the original.';content.replaceChildren(p);};content.append(media);
  }else{
    const panel=document.createElement('div');panel.className='unsupported-preview';panel.append(fileIcon(entry));const p=document.createElement('p');p.textContent=entry.mime==='application/pdf'?'Download this PDF to open it in your PDF viewer.':'This file is safely stored. Download it to open in its own app.';panel.append(p);content.append(panel);
  }dialog.showModal();
}
