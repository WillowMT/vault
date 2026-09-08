let csrfToken=null,unlocked=false,onLock=()=>{};
const controllers=new Set(),transfers=new Set();
export function configureLock(callback){onLock=callback;}
export function isUnlocked(){return unlocked;}
export function shutdown(){unlocked=false;csrfToken=null;for(const c of controllers)c.abort();controllers.clear();for(const xhr of transfers)xhr.abort();transfers.clear();}
export async function request(path,{method='GET',body,headers={}}={}){
  const controller=new AbortController();controllers.add(controller);
  try{
    const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,headers:{...headers,...(method!=='GET'?{'X-CSRF-Token':csrfToken||''}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const data=await response.json();
    if(response.status===401){onLock();throw new Error(data.error);}
    if(!response.ok)throw new Error(data.error||'The request failed.');
    return data;
  }finally{controllers.delete(controller);}
}
export async function bootstrap(){
  const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
  const data=token?await request('/api/session',{method:'POST',body:{token}}):await request('/api/session');
  csrfToken=data.csrfToken;unlocked=true;
}
export function uploadFile(file,parentId,onProgress){
  const xhr=new XMLHttpRequest();transfers.add(xhr);
  const promise=new Promise((resolve,reject)=>{
    if(!unlocked){transfers.delete(xhr);reject(new Error('Vault is locked'));return;}
    const params=new URLSearchParams({name:file.name,parentId:parentId||''});
    xhr.open('POST',`/api/files?${params}`);xhr.setRequestHeader('X-CSRF-Token',csrfToken);xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');
    xhr.upload.onprogress=event=>onProgress(event.lengthComputable?Math.round(event.loaded/event.total*100):0);
    xhr.onload=()=>{transfers.delete(xhr);let result;try{result=JSON.parse(xhr.responseText);}catch{reject(new Error('Upload failed'));return;}
      if(xhr.status===401)onLock();if(xhr.status>=200&&xhr.status<300)resolve(result);else reject(new Error(result.error||'Upload failed'));
    };
    xhr.onerror=()=>{transfers.delete(xhr);reject(new Error('Connection lost. Your upload was not completed.'));};
    xhr.onabort=()=>{transfers.delete(xhr);reject(new Error('Upload cancelled'));};xhr.send(file);
  });return {promise,cancel:()=>xhr.abort()};
}
