import { randomBytes, timingSafeEqual } from 'node:crypto';
import { VaultError } from '../vault/format.js';
const token=()=>randomBytes(32).toString('hex');
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export function createSession(){
  let launch='',expires=0,session='',csrf='',closed=false;
  return {
    renew(){if(closed)throw new Error('Server closed');launch=token();expires=Date.now()+60000;return launch;},
    exchange(value){if(closed||!launch||Date.now()>expires||!equal(value,launch))throw new VaultError('Launch link expired. Press O in the CLI to open a new one.',401);launch='';session=token();csrf=token();return {cookie:`secretcli=${session}; HttpOnly; SameSite=Strict; Path=/`,csrfToken:csrf};},
    authenticate(req){const value=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('secretcli='))?.slice(10);if(closed||!session||!equal(value,session))throw new VaultError('Vault is locked. Open it from your terminal.',401);},
    verifyCsrf(req){if(!equal(req.headers['x-csrf-token'],csrf))throw new VaultError('Invalid request token',403);},
    csrf(){return csrf;},
    close(){closed=true;launch=session=csrf='';}
  };
}
