import { lstat, readFile } from 'node:fs/promises';
import { resolve, join, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createVault,unlockVault,prepareVault } from '../vault/vault.js';
import { loadRegistry,saveRegistry,resolveReference,registerVault,touchVault,forgetVault } from '../vault/registry.js';
import { startLockedServer,startEnrollmentServer } from '../server/server.js';
import { readPassword,readText } from './prompt.js';
import { banner,renderStatus,busy } from './view.js';
import { chooseVault } from './picker.js';

const REGISTRY_DEFAULT=join(homedir(),'.secretcli','vaults.json');

function parseArgs(argv){
  const config={mode:'launch',open:true};
  const positional=[];let index=0;
  if(argv.length&&!argv[0].startsWith('--')&&['vaults','export','import'].includes(argv[0])){config.mode=argv[0];index=1;}
  for(;index<argv.length;index++){
    const arg=argv[index];
    const value=label=>{if(index+1>=argv.length||argv[index+1].startsWith('--'))throw new Error(`${label} needs a value`);return argv[++index];};
    if(arg==='--help'||arg==='-h')config.help=true;
    else if(arg==='--no-open')config.open=false;
    else if(arg==='--vault')config.vault=value('--vault');
    else if(arg==='--to')config.to=value('--to');
    else if(arg==='--out')config.out=value('--out');
    else if(arg==='--name')config.name=value('--name');
    else if(arg==='--add')config.add=true;
    else if(arg==='--remove')config.remove=value('--remove');
    else if(arg.startsWith('--'))throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  config.positional=positional;
  return config;
}

export function openBrowser(url){return new Promise((resolve,reject)=>{
  const executable=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const child=spawn(executable,args,{stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Browser could not open')));
});}

function relativeTime(timestamp){
  const minutes=Math.floor((Date.now()-timestamp)/60000);
  if(minutes<1)return 'just now';
  if(minutes<60)return `${minutes}m ago`;
  const hours=Math.floor(minutes/60);
  if(hours<48)return `${hours}h ago`;
  return `${Math.floor(hours/24)}d ago`;
}

async function vaultsCommand({config,stdout,registryPath}){
  if(config.help){stdout.write('Usage: secretcli vaults [--add <path> [name]] [--remove <name>]\n\n  (no flags)           List registered vaults\n  --add <path> [name]  Register an existing vault directory\n  --remove <name>      Remove a vault from the list without deleting its files\n');return;}
  const {registry,warning}=await loadRegistry(registryPath);
  if(warning)stdout.write(`  ⚠ ${warning}\n`);
  if(config.remove){
    const updated=forgetVault(registry,config.remove);
    await saveRegistry(registryPath,updated);
    stdout.write(`  Removed “${config.remove}” from the vault list. Files on disk were not touched.\n`);
    return;
  }
  if(config.add){
    const directory=resolve(config.positional[0]??'');
    try{await readFile(join(directory,'vault.json'));}catch{throw new Error(`No vault found at ${directory} — a vault directory contains vault.json`);}
    const {registry:updated,entry}=await registerVault(registry,directory,config.positional[1]);
    await saveRegistry(registryPath,updated);
    stdout.write(`  Registered “${entry.name}” → ${entry.path}\n`);
    return;
  }
  if(!registry.vaults.length){stdout.write('  No vaults registered yet.\n  SecretCLI creates one on first launch, or register one with: secretcli vaults --add <path> [name]\n');return;}
  const rows=await Promise.all(registry.vaults.map(async entry=>{
    let missing=false;try{await lstat(entry.path);}catch{missing=true;}
    const opened=entry.lastOpenedAt?relativeTime(entry.lastOpenedAt):'never';
    return `  ${entry.name.padEnd(14)}${entry.path}${missing?'  (missing)':''}\n      last opened: ${opened}`;
  }));
  stdout.write(['','  Registered vaults','',...rows,''].join('\n')+'\n');
}

async function rememberVault(registryPath,registry,path,forceRegister){
  try{
    const target=resolve(path);
    if(forceRegister&&!registry.vaults.some(entry=>entry.path===target))registry=(await registerVault(registry,target)).registry;
    const updated=touchVault(registry,target);
    if(JSON.stringify(updated)!==JSON.stringify(registry)){registry=updated;await saveRegistry(registryPath,registry);}
  }catch{}
  return registry;
}

export async function run({argv=process.argv.slice(2),stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,passwordReader=readPassword,opener=openBrowser,onReady,createVault:create=createVault,unlockVault:unlock=unlockVault,prepareVault:prepare=prepareVault,startLockedServer:startLocked=startLockedServer,startEnrollmentServer:startEnrollment=startEnrollmentServer,registryPath=REGISTRY_DEFAULT}={}){
  const config=parseArgs(argv);
  if(config.mode==='vaults')return vaultsCommand({config,stdout,registryPath});
  if(config.mode==='export')throw new Error('secretcli export is not available yet');
  if(config.mode==='import')throw new Error('secretcli import is not available yet');
  if(config.help){stdout.write('SecretCLI — a local encrypted drive\n\nUsage: secretcli [--vault <name|directory>] [--no-open]\n       secretcli vaults [--add <path> [name]] [--remove <name>]\n\n  --vault     Open a vault by list name or directory (omit to pick from your vaults)\n  --no-open   Start without opening the browser automatically\n  --help      Show this help\n\n  vaults      Manage your vault list\n\nKeep this terminal running. Ctrl+C locks the vault and stops the website.\n');return;}
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
  let opening=false,recovering=false,registerNew=false;
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
    const {registry:loaded,warning}=await loadRegistry(registryPath);
    let registry=loaded;
    if(warning)stdout.write(`  ⚠ ${warning}\n\n`);
    if(!config.vault){
      const known=[...registry.vaults].sort((first,second)=>(second.lastOpenedAt??0)-(first.lastOpenedAt??0));
      if(!known.length){config.path=join(homedir(),'.secretcli','vault');registerNew=true;}
      else if(known.length===1||!stdin.isTTY)config.path=known[0].path;
      else{
        const annotated=await Promise.all(known.map(async entry=>{
          let missing=false;try{await lstat(entry.path);}catch{missing=true;}
          return {...entry,missing};
        }));
        const choice=await chooseVault({input:stdin,stdout,entries:annotated,allowCreate:true,signal:abort.signal});
        if(choice===undefined){await stop();return;}
        if(choice==='create'){
          const location=(await readText({input:stdin,output:stdout,label:'New vault location',signal:abort.signal})).toString().trim();
          if(!location){await stop();return;}
          config.path=resolve(location);registerNew=true;
        }else config.path=choice.path;
      }
    }else{
      const entry=resolveReference(registry,config.vault);
      config.path=entry?entry.path:resolve(config.vault);
    }
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
    registry=await rememberVault(registryPath,registry,config.path,registerNew);
    draw();if(stdout.isTTY)timer=setInterval(draw,60000);
    await onReady?.(app);
    if(config.open)void launch();
    await ended;
  }catch(error){await stop();if(!abort.signal.aborted||!/cancel|abort/i.test(error.message))throw error;}
  finally{await stop();for(const signal of signals)process.off(signal,signalStop);stdin.off('end',signalStop);stdin.off('close',signalStop);}
}
