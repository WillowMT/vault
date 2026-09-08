import { lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createVault,unlockVault,prepareVault } from '../vault/vault.js';
import { startLockedServer,startEnrollmentServer } from '../server/server.js';
import { readPassword } from './prompt.js';
import { banner,renderStatus,busy } from './view.js';

function options(argv){
  const result={path:join(homedir(),'.secretcli','vault'),open:true};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--help'||argv[i]==='-h')result.help=true;
    else if(argv[i]==='--no-open')result.open=false;
    else if(argv[i]==='--vault'){if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('--vault needs a directory path');result.path=resolve(argv[++i]);}
    else throw new Error(`Unknown option: ${argv[i]}`);
  }return result;
}
export function openBrowser(url){return new Promise((resolve,reject)=>{
  const executable=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const child=spawn(executable,args,{stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Browser could not open')));
});}
export async function run({argv=process.argv.slice(2),stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,passwordReader=readPassword,opener=openBrowser,onReady,createVault:create=createVault,unlockVault:unlock=unlockVault,prepareVault:prepare=prepareVault,startLockedServer:startLocked=startLockedServer,startEnrollmentServer:startEnrollment=startEnrollmentServer}={}){
  const config=options(argv);
  if(config.help){stdout.write('SecretCLI — a local encrypted drive\n\nUsage: secretcli [--vault <directory>] [--no-open]\n\n  --vault     Choose a vault location (default: ~/.secretcli/vault)\n  --no-open   Start without opening the browser automatically\n  --help      Show this help\n\nKeep this terminal running. Ctrl+C locks the vault and stops the website.\n');return;}
  const color=Boolean(stdout.isTTY&&!process.env.NO_COLOR);
  stdout.write(banner(color));
  const abort=new AbortController();let vault,prepared,app,timer,lines=0,exiting=false,finished,locked=false,enrolling=false;
  const ended=new Promise(resolve=>{finished=resolve;});
  let message='',shutdownPromise;
  function clearPanel(){if(stdout.isTTY&&lines){stdout.write(`\x1b[${lines}A\x1b[J`);lines=0;}}
  const startedAt=Date.now();
  function draw(){if(exiting||!app)return;clearPanel();const text=renderStatus({origin:app.origin,startedAt,color,width:stdout.columns||80,message,locked,enrolling});stdout.write(text);lines=text.split('\n').length-1;}
  function stop(){
    if(shutdownPromise)return shutdownPromise;exiting=true;abort.abort();
    shutdownPromise=(async()=>{clearInterval(timer);stdin.off('data',keys);stdin.off('end',stop);stdin.off('close',stop);if(stdin.isTTY)stdin.setRawMode(false);stdin.pause();
      try{await app?.close();if(!app)await prepared?.close();await vault?.close();}finally{clearPanel();stdout.write('  ◇ Vault locked. See you next time.\n\n');finished();}
    })();return shutdownPromise;
  }
  function signalStop(){void stop().catch(()=>finished());}
  let opening=false,recovering=false;
  function launchUrl(){return locked||enrolling?app.launchUrl:app.renewLaunchUrl();}
  async function launch(){if(opening||exiting)return;opening=true;try{await opener(launchUrl());message='Browser opened.';}catch{message='Could not open browser. O retry · L link';}finally{opening=false;draw();}}
  async function recover(){if(recovering||!locked||exiting)return;recovering=true;try{const password=await passwordReader({input:stdin,output:stdout,label:'Recovery password',signal:abort.signal});try{const url=await app.recover(password);locked=false;await opener(url);message='Vault recovered and browser opened.';}finally{password.fill(0);}}catch(error){if(!abort.signal.aborted)message='Could not recover. Press R to try again.';}finally{recovering=false;draw();}}
  function keys(data){for(const key of data.toString()){
    if(key==='\x03'||key==='\x04'||key==='q'){signalStop();return;}
    if(key.toLowerCase()==='o')void launch();
    if(key.toLowerCase()==='l'){clearPanel();try{stdout.write(`  ${locked?'Browser link':'One-use link (expires in 60 seconds)'}:\n  ${launchUrl()}\n\n`);}catch{message='Could not create a browser link.';}draw();}
    if(key.toLowerCase()==='r')void recover();
  }}
  const signals=['SIGINT','SIGTERM','SIGHUP'];for(const signal of signals)process.on(signal,signalStop);
  try{
    let exists=true;try{await lstat(config.path);}catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
    if(!exists)stdout.write('  Create your private vault\n  Choose at least 12 characters for your recovery password.\n\n');
    let attempts=0;
    if(exists){
      prepared=await prepare(config.path);
      if(exiting){await prepared.close();return;}
      if(prepared.version===2){app=await startLocked(prepared,{onUnlock:()=>{locked=false;message='Vault unlocked.';draw();}});locked=true;}
      else{await prepared.close();prepared=undefined;}
    }
    while(!vault&&!app&&!exiting){
      const password=await passwordReader({input:stdin,output:stdout,label:exists?'Password':'Create recovery password',signal:abort.signal});
      try{
        if(!exists){
          if([...password.toString()].length<12){stdout.write('  Use at least 12 characters.\n\n');continue;}
          const confirm=await passwordReader({input:stdin,output:stdout,label:'Confirm recovery password',signal:abort.signal});
          const match=password.equals(confirm);confirm.fill(0);if(!match){stdout.write('  Passwords did not match. Try again.\n\n');continue;}
        }
        vault=await busy(stdout,exists?'Unlocking your vault…':'Creating your encrypted vault…',()=>exists?unlock(config.path,password):create(config.path,password));
        const recovery=Buffer.from(password);
        try{enrolling=true;app=await startEnrollment(vault,recovery,{onEnroll:()=>{enrolling=false;message='Passkey setup complete.';draw();}});}finally{recovery.fill(0);}
      }catch(error){
        if(error.status!==401)throw error;
        stdout.write('  Could not unlock. Check your password and try again.\n\n');await delay(Math.min(++attempts*500,3000),undefined,{signal:abort.signal});
      }finally{password.fill(0);}
    }
    if(exiting){await app.close();await vault?.close();return;}
    if(stdin.isTTY){stdin.setRawMode(true);stdin.resume();stdin.on('data',keys);stdin.once('end',signalStop);stdin.once('close',signalStop);}
    draw();if(stdout.isTTY)timer=setInterval(draw,60000);
    await onReady?.(app);
    if(config.open)void launch();
    await ended;
  }catch(error){await stop();if(!abort.signal.aborted||!/cancel|abort/i.test(error.message))throw error;}
  finally{await stop();for(const signal of signals)process.off(signal,signalStop);stdin.off('end',signalStop);stdin.off('close',signalStop);}
}
