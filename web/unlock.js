import { authenticate,enroll } from './webauthn.js';

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

function errorMessage(error){
  if(error.message==='PRF_UNAVAILABLE')return 'Passkeys with the PRF extension are unavailable. Unlock the vault from the terminal to recover access.';
  if(error.name==='NotAllowedError'||error.message==='CANCELLED')return 'Passkey request was cancelled.';
  if(error.name==='NotSupportedError'||error.name==='SecurityError')return 'This browser or device cannot use the required passkey. Press R in the terminal to unlock with your recovery password.';
  if(['Could not start passkey enrollment','Passkey enrollment failed','Passkey unlock failed','Vault is locked'].includes(error.message))return `${error.message}. Press R in the terminal to use your recovery password.`;
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
