const mode=document.body.dataset.mode;
const heading=document.querySelector('main h1');
const message=document.createElement('p');
const action=document.createElement('button');

message.className='unlock-message';
message.setAttribute('aria-live','polite');
action.className='unlock-action';
action.type='button';
action.textContent=mode==='enrollment'?'Create passkey':'Unlock with passkey';
heading.after(message,action);

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

function nativeOptions(value,key='',parent=''){
  if(Array.isArray(value))return value.map(item=>nativeOptions(item,'',key));
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

function credentialJSON(credential){
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

function prfResult(credential){
  const first=credential.getClientExtensionResults?.().prf?.results?.first;
  const result=bytes(first);
  if(!result||result.byteLength!==32)throw new Error('PRF_UNAVAILABLE');
  return base64url(result);
}

async function request(path,body={}){
  const response=await window.fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok)throw new Error('REQUEST_FAILED');
  return response.json();
}

async function authenticate(){
  const options=await request('/api/passkey/authentication/options');
  const credential=await window.navigator.credentials.get({publicKey:nativeOptions(options)});
  if(!credential)throw new Error('CANCELLED');
  await request('/api/passkey/authentication/verify',{credential:credentialJSON(credential),prf:prfResult(credential)});
}

async function enroll(){
  const registration=await request('/api/passkey/registration/options');
  const created=await window.navigator.credentials.create({publicKey:nativeOptions(registration)});
  if(!created)throw new Error('CANCELLED');
  const confirmation=await request('/api/passkey/registration/verify',{credential:credentialJSON(created)});
  const credential=await window.navigator.credentials.get({publicKey:nativeOptions(confirmation)});
  if(!credential)throw new Error('CANCELLED');
  await request('/api/passkey/registration/confirm',{credential:credentialJSON(credential),prf:prfResult(credential)});
}

function errorMessage(error){
  if(error.message==='PRF_UNAVAILABLE')return 'Passkeys with the PRF extension are unavailable. Unlock the vault from the terminal to recover access.';
  if(error.name==='NotAllowedError'||error.message==='CANCELLED')return 'Passkey request was cancelled.';
  return 'Passkey operation failed. Try again or unlock from the terminal.';
}

action.addEventListener('click',async()=>{
  if(!window.PublicKeyCredential||!window.navigator.credentials?.get||(mode==='enrollment'&&!window.navigator.credentials.create)){
    message.textContent='WebAuthn is unavailable. Unlock the vault from the terminal to recover access.';
    return;
  }
  action.disabled=true;
  message.textContent=mode==='enrollment'?'Follow your device prompts to create a passkey.':'Follow your device prompt to unlock the vault.';
  try{
    await(mode==='enrollment'?enroll():authenticate());
    window.location.replace('/');
  }catch(error){
    message.textContent=errorMessage(error);
  }finally{
    action.disabled=false;
  }
});
