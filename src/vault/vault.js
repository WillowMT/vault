import { readdir, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createCatalog, loadCatalog } from './catalog.js';
import { writeObject, readObject } from './objects.js';
import { VaultError } from './format.js';

/** @typedef {{id:string,parentId:string|null,name:string,kind:'file'|'folder',size:number,mime:string,createdAt:string,objectId?:string,fileKey?:string}} Entry */
const publicEntry=({objectId,fileKey,...entry})=>({...entry});
function validName(name){if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name)>255||/[\x00-\x1f\x7f/\\]/.test(name)||name==='.'||name==='..')throw new VaultError('Choose a valid name (up to 255 bytes, without slashes or control characters)');return name;}
export async function createVault(path,password){return build(path,await createCatalog(path,password));}
export async function unlockVault(path,password){return build(path,await loadCatalog(path,password));}
async function build(path,catalog){
  const directory=join(path,'objects');let entries=catalog.entries.map(e=>({...e}));
  let closing=false,closed=false,queue=Promise.resolve(),closePromise;
  const uploads=new Set(), readers=new Map(), deferred=new Set();
  try{
    const ids=new Set();
    for(const e of entries){
      validName(e.name);
      if(!/^[a-f0-9-]{36}$/.test(e.id)||ids.has(e.id)||!['file','folder'].includes(e.kind)||!Number.isSafeInteger(e.size)||e.size<0)throw new Error('Corrupt catalog entry');
      ids.add(e.id);
      if(e.kind==='file'&&(!/^[a-f0-9-]{36}$/.test(e.objectId)||typeof e.fileKey!=='string'||Buffer.from(e.fileKey,'base64').length!==32))throw new Error('Corrupt catalog object');
    }
    const known=new Set(entries.filter(e=>e.kind==='file').map(e=>e.objectId));
    for(const name of await readdir(directory)){
      if(!/^[a-f0-9-]{36}(\.partial)?$/.test(name))throw new Error('Unexpected file in vault object directory');
      if((await lstat(join(directory,name))).isSymbolicLink())throw new Error('Vault objects must not be symbolic links');
      if(!known.has(name))await unlink(join(directory,name));
    }
  }catch(error){await catalog.close();throw error;}
  function active(){if(closing||closed)throw new VaultError('Vault is locked',401);}
  function find(id){const e=entries.find(e=>e.id===id);if(!e)throw new VaultError('File or folder not found',404);return e;}
  function parent(id){if(id!==null&&find(id).kind!=='folder')throw new VaultError('Destination must be a folder');}
  function unique(parentId,name,except,ignoredIds){if(entries.some(e=>e.parentId===parentId&&e.name===name&&e.id!==except&&!ignoredIds?.has(e.id)))throw new VaultError('A file or folder with this name already exists',409);}
  function validateIds(ids){
    if(!Array.isArray(ids)||ids.length===0)throw new VaultError('Select a non-empty list of entries');
    if(ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new VaultError('Selected entry IDs must be unique strings');
    return ids.map(find);
  }
  function mutate(fn){
    try{active();}catch(error){return Promise.reject(error);}
    const work=queue.then(async()=>{active();const next=entries.map(e=>({...e}));const value=fn(next);await catalog.save(next);entries=next;return value;});
    queue=work.catch(()=>{});return work;
  }
  async function discard(id){if(readers.has(id)){deferred.add(id);return;}await unlink(join(directory,id)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  const api={
    list(parentId=null,query='',{recursive=false}={}){active();parent(parentId);return entries.filter(e=>query?e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()):recursive||e.parentId===parentId).map(publicEntry);},
    folders(){active();return entries.filter(e=>e.kind==='folder').map(publicEntry);},
    summary(){active();return {files:entries.filter(e=>e.kind==='file').length,bytes:entries.reduce((n,e)=>n+e.size,0)};},
    stat(id){active();return publicEntry(find(id));},
    mkdir(parentId,name){return mutate(next=>{validName(name);parent(parentId);unique(parentId,name);const entry={id:randomUUID(),parentId,name,kind:'folder',size:0,mime:'',createdAt:new Date().toISOString()};next.push(entry);return publicEntry(entry);});},
    async upload(parentId,name,mime,source,signal){
      active();validName(name);parent(parentId);unique(parentId,name);
      if(uploads.size>=2)throw new VaultError('Two uploads are already running; try again shortly',429);
      const controller=new AbortController(); const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
      const key=randomBytes(32),objectId=randomUUID();
      let done;const finished=new Promise(resolve=>{done=resolve;});const job={controller,finished};uploads.add(job);
      try{
        const {size}=await writeObject(directory,catalog.vaultId,objectId,key,source,combined);
        combined.throwIfAborted();
        return await mutate(next=>{parent(parentId);unique(parentId,name);const e={id:randomUUID(),parentId,name,kind:'file',size,mime:typeof mime==='string'?mime.slice(0,128):'application/octet-stream',createdAt:new Date().toISOString(),objectId,fileKey:key.toString('base64')};next.push(e);return publicEntry(e);});
      }catch(error){await discard(objectId);throw error;}finally{key.fill(0);uploads.delete(job);done();}
    },
    update(id,patch){return mutate(next=>{
      const entry=find(id);const name=patch.name===undefined?entry.name:validName(patch.name);const parentId=patch.parentId===undefined?entry.parentId:patch.parentId;
      parent(parentId);unique(parentId,name,id);
      for(let p=parentId;p!==null;p=find(p).parentId)if(p===id)throw new VaultError('Cannot move a folder into itself or a descendant');
      Object.assign(next.find(e=>e.id===id),{name,parentId});return publicEntry(next.find(e=>e.id===id));
    });},
    moveMany(ids,parentId){return mutate(next=>{
      const selected=validateIds(ids);parent(parentId);const selectedIds=new Set(ids),names=new Set();
      for(const entry of selected){
        if(names.has(entry.name))throw new VaultError('A file or folder with this name already exists',409);
        names.add(entry.name);unique(parentId,entry.name,entry.id,selectedIds);
        for(let id=parentId;id!==null;id=find(id).parentId)if(id===entry.id)throw new VaultError('Cannot move a folder into itself or a descendant');
      }
      for(const entry of selected)next.find(item=>item.id===entry.id).parentId=parentId;
      return selected.length;
    });},
    async remove(id){
      const objects=await mutate(next=>{
        find(id);const removed=new Set([id]);let grew=true;
        while(grew){grew=false;for(const e of next)if(removed.has(e.parentId)&&!removed.has(e.id)){removed.add(e.id);grew=true;}}
        const objects=next.filter(e=>removed.has(e.id)&&e.kind==='file').map(e=>e.objectId);
        for(let i=next.length-1;i>=0;i--)if(removed.has(next[i].id))next.splice(i,1);return objects;
      });await Promise.all(objects.map(discard));
    },
    async removeMany(ids){
      const objects=await mutate(next=>{
        const selected=validateIds(ids),removed=new Set(ids);let grew=true;
        while(grew){grew=false;for(const entry of next)if(removed.has(entry.parentId)&&!removed.has(entry.id)){removed.add(entry.id);grew=true;}}
        const objects=[...new Set(next.filter(entry=>removed.has(entry.id)&&entry.kind==='file').map(entry=>entry.objectId))];
        for(let index=next.length-1;index>=0;index--)if(removed.has(next[index].id))next.splice(index,1);
        return {objects,count:selected.length};
      });
      await Promise.all(objects.objects.map(discard));return objects.count;
    },
    async *read(id,start,end){
      active();const e={...find(id)};if(e.kind!=='file')throw new VaultError('Cannot download a folder');
      readers.set(e.objectId,(readers.get(e.objectId)||0)+1);const key=Buffer.from(e.fileKey,'base64');
      try{for await(const bytes of readObject(directory,catalog.vaultId,e.objectId,key,e.size,start,end)){active();yield bytes;}}
      finally{key.fill(0);const remaining=readers.get(e.objectId)-1;if(remaining)readers.set(e.objectId,remaining);else{readers.delete(e.objectId);if(deferred.delete(e.objectId))await discard(e.objectId);}}
    },
    close(){
      if(closePromise)return closePromise;closing=true;
      closePromise=(async()=>{for(const job of uploads)job.controller.abort();await Promise.all([...uploads].map(j=>j.finished));await queue;entries=[];closed=true;await catalog.close();})();return closePromise;
    }
  };return api;
}
