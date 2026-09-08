import { VaultError } from '../vault/format.js';
export function parseRange(header,size){
  if(!header)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match||(!match[1]&&!match[2])||size===0)throw new VaultError('Range not satisfiable',416);
  let start,end;
  if(!match[1]){const count=Number(match[2]);if(!Number.isSafeInteger(count)||count<=0)throw new VaultError('Range not satisfiable',416);start=Math.max(0,size-count);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new VaultError('Range not satisfiable',416);
  return {start,end};
}
