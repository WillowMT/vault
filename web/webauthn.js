function bytes(value){
  if(Object.prototype.toString.call(value)==='[object ArrayBuffer]')return new Uint8Array(value);
  if(value&&Object.prototype.toString.call(value.buffer)==='[object ArrayBuffer]'&&typeof value.byteLength==='number')return new Uint8Array(value.buffer,value.byteOffset||0,value.byteLength);
  return null;
}

function base64url(value){
  const valueBytes=bytes(value);
  if(!valueBytes)return value;
  let binary='';
  for(const byte of valueBytes)binary+=String.fromCharCode(byte);
  return window.btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}

function buffer(value){
  const padded=value.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-value.length%4)%4);
  const binary=window.atob(padded),output=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)output[index]=binary.charCodeAt(index);
  return output.buffer;
}

export function nativeOptions(value,key='',parent=''){
  if(Array.isArray(value))return value.map(item=>nativeOptions(item,key,parent));
  if(!value||typeof value!=='object'){
    const binary=key==='challenge'||key==='userHandle'||key==='first'||(key==='id'&&['user','allowCredentials','excludeCredentials'].includes(parent));
    return binary&&typeof value==='string'?buffer(value):value;
  }
  return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,nativeOptions(item,name,key)]));
}

function json(value){
  const valueBytes=bytes(value);
  if(valueBytes)return base64url(valueBytes);
  if(Array.isArray(value))return value.map(json);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>typeof item!=='function').map(([name,item])=>[name,json(item)]));
  return value;
}

export function credentialJSON(credential){
  const source=credential.response,response={clientDataJSON:base64url(source.clientDataJSON)};
  if(source.attestationObject!==undefined){
    response.attestationObject=base64url(source.attestationObject);
    if(typeof source.getTransports==='function')response.transports=source.getTransports();
    if(typeof source.getPublicKeyAlgorithm==='function')response.publicKeyAlgorithm=source.getPublicKeyAlgorithm();
    if(typeof source.getPublicKey==='function'){const publicKey=source.getPublicKey();if(publicKey)response.publicKey=base64url(publicKey);}
    if(source.authenticatorData!==undefined)response.authenticatorData=base64url(source.authenticatorData);
  }else{
    response.authenticatorData=base64url(source.authenticatorData);
    response.signature=base64url(source.signature);
    response.userHandle=source.userHandle===null?null:base64url(source.userHandle);
  }
  const result={
    id:credential.id,
    rawId:base64url(credential.rawId),
    type:credential.type,
    response,
    clientExtensionResults:json(credential.getClientExtensionResults?.()||{})
  };
  if(credential.authenticatorAttachment)result.authenticatorAttachment=credential.authenticatorAttachment;
  return result;
}

export function prfResult(credential){
  const first=credential.getClientExtensionResults?.().prf?.results?.first;
  const result=bytes(first);
  if(!result||result.byteLength!==32)throw new Error('PRF_UNAVAILABLE');
  return base64url(result);
}

export async function post(path,body={}){
  const response=await window.fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok){let detail;try{detail=(await response.json()).error;}catch{}throw new Error(typeof detail==='string'?detail:'REQUEST_FAILED');}
  return response.json();
}

export async function authenticate(request=post){
  const options=await request('/api/passkey/authentication/options');
  const credential=await window.navigator.credentials.get({publicKey:nativeOptions(options)});
  if(!credential)throw new Error('CANCELLED');
  await request('/api/passkey/authentication/verify',{credential:credentialJSON(credential),prf:prfResult(credential)});
}

export async function enroll(request=post){
  const registration=await request('/api/passkey/registration/options');
  const created=await window.navigator.credentials.create({publicKey:nativeOptions(registration)});
  if(!created)throw new Error('CANCELLED');
  const confirmation=await request('/api/passkey/registration/verify',{credential:credentialJSON(created)});
  const credential=await window.navigator.credentials.get({publicKey:nativeOptions(confirmation)});
  if(!credential)throw new Error('CANCELLED');
  await request('/api/passkey/registration/confirm',{credential:credentialJSON(credential),prf:prfResult(credential)});
}
