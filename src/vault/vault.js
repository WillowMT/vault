import { readdir, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createCatalog, loadCatalog, prepareCatalog } from './catalog.js';
import { writeObject, readObject } from './objects.js';
import { VaultError } from './format.js';

/** @typedef {{id:string,parentId:string|null,name:string,kind:'file'|'folder',size:number,mime:string,createdAt:string,objectId?:string,fileKey?:string}} Entry */
const publicEntry=({objectId,fileKey,...entry})=>({...entry});
function validName(name){if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name)>255||/[\x00-\x1f\x7f/\\]/.test(name)||name==='.'||name==='..')throw new VaultError('Choose a valid name (up to 255 bytes, without slashes or control characters)');return name;}
export async function createVault(path,password){return build(path,await createCatalog(path,password));}
export async function unlockVault(path,password){return build(path,await loadCatalog(path,password));}
export async function prepareVault(path){
  const prepared=await prepareCatalog(path);
  let closing=false,closed=false,inFlight,closePromise;
  function unlock(open){
    if(closing||closed)return Promise.reject(new Error('Prepared vault is closed'));
    if(inFlight)return Promise.reject(new Error('An unlock attempt is already in progress'));
    const work=(async()=>{
      const vault=await build(path,await open());
      if(closing){await vault.close();throw new Error('Prepared vault is closed');}
      return vault;
    })();
    inFlight=work;
    void work.then(()=>{if(inFlight===work)inFlight=undefined;},()=>{if(inFlight===work)inFlight=undefined;});
    return work;
  }
  return {version:prepared.version,vaultId:prepared.vaultId,passkey:prepared.passkey,
    unlockWithPassword:password=>unlock(()=>prepared.unlockWithPassword(password)),
    unlockWithPasskey:(prfOutput,newCounter)=>unlock(()=>prepared.unlockWithPasskey(prfOutput,newCounter)),
    unlockWithRecoveryImage:image=>unlock(()=>prepared.unlockWithRecoveryImage(image)),
    close(){
      if(closePromise)return closePromise;
      closing=true;
      const pending=inFlight;
      closePromise=(async()=>{
        await prepared.close();
        if(pending)try{const vault=await pending;await vault.close();}catch{}
        closed=true;
      })();
      return closePromise;
    }
  };
}
async function build(path,catalog){
  const directory=join(path,'objects');let entries=catalog.entries.map(e=>({...e}));
  let closing=false,closed=false,queue=Promise.resolve(),closePromise;
  const uploads=new Set(), readers=new Map(), deferred=new Set(), exportSnapshots=new Set();
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
  function mutateHeader(fn){
    try{active();}catch(error){return Promise.reject(error);}
    const work=queue.then(fn);queue=work.catch(()=>{});return work;
  }
  async function discard(id){if(readers.has(id)){deferred.add(id);return;}await unlink(join(directory,id)).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  async function releaseReader(id){const remaining=readers.get(id)-1;if(remaining)readers.set(id,remaining);else{readers.delete(id);if(deferred.delete(id))await discard(id);}}
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
      finally{key.fill(0);await releaseReader(e.objectId);}
    },
    openExport(ids){
      try{active();}catch(error){return Promise.reject(error);}
      const work=queue.then(()=>{
        active();
        if(!Array.isArray(ids)||ids.length===0||ids.some(id=>typeof id!=='string'))throw new VaultError('Select a non-empty list of entry IDs');
        const selectedIds=[...new Set(ids)],byId=new Map(entries.map(entry=>[entry.id,entry]));
        const selected=selectedIds.map(id=>{const entry=byId.get(id);if(!entry)throw new VaultError('File or folder not found',404);return entry;});
        const selectedSet=new Set(selectedIds),roots=[];
        for(const entry of selected){
          const seen=new Set([entry.id]);let covered=false;
          for(let parentId=entry.parentId;parentId!==null;){
            if(seen.has(parentId))throw new VaultError('Corrupt catalog hierarchy');
            seen.add(parentId);
            const ancestor=byId.get(parentId);
            if(!ancestor||ancestor.kind!=='folder')throw new VaultError('Corrupt catalog hierarchy');
            if(selectedSet.has(parentId))covered=true;
            parentId=ancestor.parentId;
          }
          if(!covered)roots.push(entry);
        }
        const rootNames=new Set();
        for(const root of roots){if(rootNames.has(root.name))throw new VaultError('Selected roots have a same name collision',409);rootNames.add(root.name);}
        const children=new Map();
        for(const entry of entries){if(entry.parentId!==null){const list=children.get(entry.parentId)||[];list.push(entry);children.set(entry.parentId,list);}}
        const planned=[],visited=new Set(),visiting=new Set();
        function walk(entry,prefix){
          if(visiting.has(entry.id))throw new VaultError('Corrupt catalog hierarchy');
          if(visited.has(entry.id))return;
          visiting.add(entry.id);visited.add(entry.id);
          const path=`${prefix}${entry.name}${entry.kind==='folder'?'/':''}`;
          if(Buffer.byteLength(path)>0xffff)throw new VaultError('Export path is too long');
          planned.push({entry,path});
          if(entry.kind==='folder')for(const child of children.get(entry.id)||[])walk(child,path);
          visiting.delete(entry.id);
        }
        for(const root of roots)walk(root,'');

        const files=planned.filter(item=>item.entry.kind==='file').map(item=>({
          entry:item.entry,
          path:item.path,
          key:Buffer.from(item.entry.fileKey,'base64')
        }));
        for(const file of files)readers.set(file.entry.objectId,(readers.get(file.entry.objectId)||0)+1);
        const streams=new Set();let released=false,releasePromise;
        const release=()=>{
          if(releasePromise)return releasePromise;
          released=true;
          releasePromise=(async()=>{
            for(const stream of streams)stream.destroy();
            for(const file of files)file.key.fill(0);
            await Promise.all(files.map(file=>releaseReader(file.entry.objectId)));
            exportSnapshots.delete(release);
          })();
          return releasePromise;
        };
        const fileById=new Map(files.map(file=>[file.entry.id,file]));
        const snapshotEntries=planned.map(item=>{
          if(item.entry.kind==='folder')return {kind:'folder',path:item.path};
          const file=fileById.get(item.entry.id);
          return {kind:'file',path:item.path,size:item.entry.size,open(){
            if(released||closing||closed)throw new VaultError('Export snapshot is released');
            const stream=Readable.from((async function*(){
              for await(const bytes of readObject(directory,catalog.vaultId,file.entry.objectId,file.key,file.entry.size)){
                if(released||closing||closed)throw new VaultError('Vault is locked',401);
                yield bytes;
              }
            })());
            streams.add(stream);stream.once('close',()=>streams.delete(stream));return stream;
          }};
        });
        exportSnapshots.add(release);
        return {entries:snapshotEntries,release};
      });
      queue=work.catch(()=>{});return work;
    },
    enrollPasskey(password,metadata,prfOutput){
      try{active();}catch(error){return Promise.reject(error);}
      const snapshot=metadata&&{...metadata,transports:Array.isArray(metadata.transports)?[...metadata.transports]:metadata.transports};
      const prf=Buffer.isBuffer(prfOutput)?Buffer.from(prfOutput):prfOutput;
      const work=queue.then(async()=>{active();return catalog.enrollPasskey(password,snapshot,prf);}).finally(()=>{if(prf!==prfOutput)prf.fill(0);});
      queue=work.catch(()=>{});return work;
    },
    createRecoveryImage(){return mutateHeader(()=>catalog.createRecoveryImage());},
    disablePasskey(){return mutateHeader(()=>catalog.disablePasskey());},
    setPasskey(metadata,prfOutput){
      const snapshot=metadata&&{...metadata,transports:Array.isArray(metadata.transports)?[...metadata.transports]:metadata.transports};
      const prf=Buffer.isBuffer(prfOutput)?Buffer.from(prfOutput):prfOutput;
      return mutateHeader(()=>catalog.setPasskey(snapshot,prf)).finally(()=>{if(Buffer.isBuffer(prf)&&prf!==prfOutput)prf.fill(0);});
    },
    passkeyStatus(){active();return catalog.passkeyStatus();},
    close(){
      if(closePromise)return closePromise;closing=true;
      closePromise=(async()=>{for(const job of uploads)job.controller.abort();await Promise.all([...uploads].map(j=>j.finished));await queue;await Promise.all([...exportSnapshots].map(release=>release()));entries=[];closed=true;await catalog.close();})();return closePromise;
    }
  };
  Object.defineProperty(api,'vaultId',{value:catalog.vaultId,enumerable:true});
  return api;
}
