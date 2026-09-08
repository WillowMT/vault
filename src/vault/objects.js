import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { encrypt, decrypt } from './crypto.js';
import { CHUNK, MAX_FILE, aad, VaultError } from './format.js';
import { syncDirectory } from './atomic.js';

function nonce(index){const iv=Buffer.alloc(12);iv.writeBigUInt64BE(BigInt(index),4);return iv;}
function context(vaultId,objectId,index,length){return aad('secretcli-object',1,vaultId,objectId,index,length);}
export async function writeObject(directory,vaultId,objectId,key,source,signal){
  const partial=join(directory,`${objectId}.partial`), target=join(directory,objectId);
  const handle=await open(partial,'wx',0o600);
  let size=0,index=0,used=0; const pending=Buffer.alloc(CHUNK);
  async function flush(){
    const bytes=encrypt(key,pending.subarray(0,used),context(vaultId,objectId,index,used),nonce(index));
    await handle.writeFile(bytes);index++;used=0;
  }
  try {
    for await(const part of source){
      signal?.throwIfAborted();
      const bytes=Buffer.from(part.buffer,part.byteOffset,part.byteLength);size+=bytes.length;
      if(size>MAX_FILE)throw new VaultError('File exceeds the 1 TiB limit',413);
      for(let offset=0;offset<bytes.length;){
        signal?.throwIfAborted();
        const count=Math.min(CHUNK-used,bytes.length-offset);
        bytes.copy(pending,used,offset,offset+count);used+=count;offset+=count;
        if(used===CHUNK)await flush();
      }
    }
    signal?.throwIfAborted(); if(used)await flush();
    await handle.sync();await handle.close();await rename(partial,target);await syncDirectory(directory);
    return {size};
  } catch(error){await handle.close().catch(()=>{});await unlink(partial).catch(()=>{});throw error;}
  finally{pending.fill(0);}
}
export async function* readObject(directory,vaultId,objectId,key,size,start=0,end=size-1){
  const handle=await open(join(directory,objectId),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const info=await handle.stat();
    if(!info.isFile()||info.size!==size+Math.ceil(size/CHUNK)*16)throw new Error('Corrupt object size');
    if(size===0)return;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=size)throw new VaultError('Invalid byte range',416);
    for(let index=Math.floor(start/CHUNK);index<=Math.floor(end/CHUNK);index++){
      const length=Math.min(CHUNK,size-index*CHUNK), record=Buffer.alloc(length+16);
      let offset=0;
      while(offset<record.length){const {bytesRead}=await handle.read(record,offset,record.length-offset,index*(CHUNK+16)+offset);if(!bytesRead)throw new Error('Corrupt object size');offset+=bytesRead;}
      const plain=decrypt(key,record,context(vaultId,objectId,index,length),nonce(index));
      yield plain.subarray(Math.max(0,start-index*CHUNK),Math.min(length,end-index*CHUNK+1));
    }
  } finally {await handle.close();}
}
