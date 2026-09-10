import { lstat, readFile, rm, open } from 'node:fs/promises';
import { resolve, join, basename, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createVault,unlockVault,prepareVault } from '../vault/vault.js';
import { exportVault,importVault } from '../vault/archive.js';
import { loadRegistry,resolveReference,registerVault,touchVault,forgetVault,updateRegistry } from '../vault/registry.js';
import { startServer,startLockedServer,startEnrollmentServer } from '../server/server.js';
import { readPassword,readText } from './prompt.js';
import { banner,renderStatus,busy } from './view.js';
import { chooseVault } from './picker.js';

const REGISTRY_DEFAULT=join(homedir(),'.secretcli','vaults.json');
const MAX_RECOVERY_IMAGE=2*1024*1024;

async function readRecoveryImage(path){
  const file=await open(path,'r');
  const storage=Buffer.allocUnsafe(MAX_RECOVERY_IMAGE+1);
  try{
    let length=0;
    while(length<storage.length){const {bytesRead}=await file.read(storage,length,storage.length-length);if(!bytesRead)break;length+=bytesRead;}
    if(length>MAX_RECOVERY_IMAGE)throw new Error('Recovery file is larger than 2 MiB');
    return {image:storage.subarray(0,length),storage};
  }catch(error){storage.fill(0);throw error;}
  finally{await file.close();}
}

function nativeRecoveryFilePicker(){
  if(platform()!=='darwin')return Promise.resolve();
  return new Promise(resolve=>{
    const child=spawn('osascript',['-e','POSIX path of (choose file with prompt "Select your Vault recovery file")'],{stdio:['ignore','pipe','ignore']});let value='';
    child.stdout.on('data',chunk=>value+=chunk);
    child.once('error',()=>resolve());
    child.once('close',code=>resolve(code===0?value.trim()||undefined:undefined));
  });
}

function resolveRecoveryPath(path){
  const value=path.trim();
  return resolve(value==='~'||value.startsWith('~/')?join(homedir(),value.slice(2)):value);
}

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
  if(config.help){stdout.write('Usage: vault vaults [--add <path> [name]] [--remove <name>]\n\n  (no flags)           List registered vaults\n  --add <path> [name]  Register an existing vault directory\n  --remove <name>      Remove a vault from the list without deleting its files\n');return;}
  const {registry,warning}=await loadRegistry(registryPath);
  if(warning&&(config.remove||config.add))throw new Error(`${warning} Repair or remove it before changing the vault list.`);
  if(warning)stdout.write(`  ⚠ ${warning}\n`);
  if(config.remove){
    await updateRegistry(registryPath,current=>({registry:forgetVault(current,config.remove)}));
    stdout.write(`  Removed “${config.remove}” from the vault list. Files on disk were not touched.\n`);
    return;
  }
  if(config.add){
    const directory=resolve(config.positional[0]??'');
    try{await readFile(join(directory,'vault.json'));}catch{throw new Error(`No vault found at ${directory} — a vault directory contains vault.json`);}
    const {entry}=await updateRegistry(registryPath,current=>registerVault(current,directory,config.positional[1]));
    stdout.write(`  Registered “${entry.name}” → ${entry.path}\n`);
    return;
  }
  if(!registry.vaults.length){stdout.write('  No vaults registered yet.\n  Vault creates one on first launch, or register one with: vault vaults --add <path> [name]\n');return;}
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
    const result=await updateRegistry(registryPath,async current=>{
      if(forceRegister&&!current.vaults.some(entry=>entry.path===target))current=(await registerVault(current,target)).registry;
      return {registry:touchVault(current,target)};
    });
    registry=result.registry;
  }catch{}
  return registry;
}

function formatBytes(size){
  if(!size)return '0 B';
  const units=['B','KB','MB','GB','TB'],index=Math.min(4,Math.floor(Math.log(size)/Math.log(1024)));
  return `${(size/1024**index).toFixed(index?1:0)} ${units[index]}`;
}

async function defaultVaultPath(registryPath){
  const {registry}=await loadRegistry(registryPath);
  const mostRecent=[...registry.vaults].sort((first,second)=>(second.lastOpenedAt??0)-(first.lastOpenedAt??0))[0];
  return mostRecent?.path;
}

async function resolveVaultLocation(reference,registryPath){
  const {registry}=await loadRegistry(registryPath);
  const entry=resolveReference(registry,reference);
  return entry?entry.path:resolve(reference);
}

async function exportCommand({config,stdout,registryPath}){
  if(config.help){stdout.write('Usage: vault export [--vault <name|directory>] --to <archive.scvault>\n\n  Export a vault to a single encrypted archive file. The vault must not be open.\n  The archive contains only encrypted data and needs no password to store.\n');return;}
  if(!config.to)throw new Error('vault export needs --to <archive.scvault>');
  const directory=config.vault?await resolveVaultLocation(config.vault,registryPath):await defaultVaultPath(registryPath);
  if(!directory)throw new Error('No vaults registered. Open a vault first, or pass --vault <directory>.');
  const output=resolve(config.to);
  const {manifest,bytes}=await exportVault({directory,output});
  stdout.write(`  Exported ${manifest.files.length} files (${formatBytes(bytes)}) to ${output}\n  The archive is ciphertext-only — store it anywhere.\n`);
}

async function importCommand({config,stdout,registryPath}){
  if(config.help){stdout.write('Usage: vault import <archive.scvault> --out <directory> [--name <name>]\n\n  Restore an exported archive into a new vault directory and register it.\n  Unlock the restored vault with the original recovery password or passkey.\n');return;}
  if(!config.positional[0])throw new Error('Usage: vault import <archive.scvault> --out <directory> [--name <name>]');
  if(!config.out)throw new Error('vault import needs --out <directory>');
  const archive=resolve(config.positional[0]),directory=resolve(config.out);
  try { await lstat(directory);throw new Error(`${directory} already exists`); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  const loaded=await loadRegistry(registryPath);
  if(loaded.warning)throw new Error(`${loaded.warning} Repair or remove it before importing a vault.`);
  await registerVault(loaded.registry,directory,config.name);
  const {manifest}=await importVault({archive,directory});
  let registration;
  try{
    registration=await updateRegistry(registryPath,current=>registerVault(current,directory,config.name));
  }catch(error){
    const persisted=await loadRegistry(registryPath);
    const entry=persisted.registry.vaults.find(entry=>entry.path===directory),registered=Boolean(entry);
    if(!registered)await rm(directory,{recursive:true,force:true});
    if(!registered)throw new Error(`The imported vault could not be registered: ${error.message}`);
    registration={registry:persisted.registry,entry};
  }
  stdout.write(`  Imported ${manifest.files.length} files into ${directory}\n`);
  stdout.write(`  Registered as “${registration.entry.name}”. Open it with: vault --vault ${registration.entry.name}\n`);
}

export async function run({argv=process.argv.slice(2),stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,passwordReader=readPassword,textReader=readText,recoveryFilePicker,readRecoveryFile=readRecoveryImage,opener=openBrowser,onReady,createVault:create=createVault,unlockVault:unlock=unlockVault,prepareVault:prepare=prepareVault,startServer:startReady=startServer,startLockedServer:startLocked=startLockedServer,startEnrollmentServer:startEnrollment=startEnrollmentServer,registryPath=REGISTRY_DEFAULT}={}){
  recoveryFilePicker??=stdin===process.stdin?nativeRecoveryFilePicker:async()=>undefined;
  const config=parseArgs(argv);
  if(config.mode==='vaults')return vaultsCommand({config,stdout,registryPath});
  if(config.mode==='export')return exportCommand({config,stdout,registryPath});
  if(config.mode==='import')return importCommand({config,stdout,registryPath});
  if(config.help){stdout.write('Vault — a local encrypted drive\n\nUsage: vault [--vault <name|directory>] [--no-open]\n       vault vaults [--add <path> [name]] [--remove <name>]\n       vault export [--vault <name|directory>] --to <archive.scvault>\n       vault import <archive.scvault> --out <directory> [--name <name>]\n\n  --vault     Open a vault by list name or directory (omit to pick from your vaults)\n  --no-open   Start without opening the browser automatically\n  --help      Show this help\n\n  vaults      Manage your vault list\n  export      Copy a vault into one encrypted archive file\n  import      Restore an archive into a new vault\n\nKeep this terminal running. Ctrl+C locks the vault and stops the website.\n');return;}
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
  async function recoveryChoice(target){
    const choice=await textReader({input:stdin,output:stdout,label:'Recover with [P]assword or [F]ile',signal:abort.signal});
    try{
      if(choice.toString().trim().toLowerCase()==='f'){
        const picked=await recoveryFilePicker();
        const path=picked??(await textReader({input:stdin,output:stdout,label:'Recovery file path (example: ~/Documents/Vault recovery file.png)',signal:abort.signal}));
        try{
          const {image,storage}=await readRecoveryFile(resolveRecoveryPath(path.toString()));
          try{return await target.image(image);}finally{storage.fill(0);}
        }finally{if(Buffer.isBuffer(path))path.fill(0);}
      }
      const password=await passwordReader({input:stdin,output:stdout,label:'Recovery password',signal:abort.signal});
      try{return await target.password(password);}finally{password.fill(0);}
    }finally{choice.fill(0);}
  }
  async function recover(){if(recovering||!locked||exiting)return;recovering=true;try{const url=await recoveryChoice({password:value=>app.recover(value),image:value=>app.recoverWithRecoveryImage(value)});locked=false;await opener(url);message='Vault recovered and browser opened.';}catch(error){if(!abort.signal.aborted)message='Could not recover. Press R to try again.';}finally{recovering=false;draw();}}
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
      if(!entry){try{await lstat(config.path);}catch(error){if(error.code==='ENOENT')registerNew=true;else throw error;}}
    }
    let exists=true;try{await lstat(config.path);}catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
    if(!exists)stdout.write('  Create your private vault\n  Choose at least 12 characters for your recovery password.\n\n');
    let attempts=0,recoveredV3=false;
    if(exists){
      prepared=await prepare(config.path);
      if(exiting){await prepared.close();return;}
      if(prepared.version===2||(prepared.version===3&&prepared.passkey)){app=await startLocked(prepared,{onUnlock:()=>{locked=false;message='Vault unlocked.';draw();}});locked=true;}
      else if(prepared.version===3){
        while(!vault&&!exiting){
          try{vault=await recoveryChoice({password:value=>prepared.unlockWithPassword(value),image:value=>prepared.unlockWithRecoveryImage(value)});}
          catch(error){if(abort.signal.aborted)throw error;stdout.write('  Could not unlock. Check your recovery password or file and try again.\n\n');await delay(Math.min(++attempts*500,3000),undefined,{signal:abort.signal});}
        }
        if(vault){app=await startReady(vault);recoveredV3=true;}
      }else{await prepared.close();prepared=undefined;}
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
    if(recoveredV3)message='Vault unlocked.';
    if(exiting){await app.close();await vault?.close();return;}
    if(stdin.isTTY){stdin.setRawMode(true);stdin.resume();stdin.on('data',keys);stdin.once('end',signalStop);stdin.once('close',signalStop);}
    if(!warning)registry=await rememberVault(registryPath,registry,config.path,registerNew);
    draw();if(stdout.isTTY)timer=setInterval(draw,60000);
    await onReady?.(app);
    if(config.open)void launch();
    await ended;
  }catch(error){await stop();if(!abort.signal.aborted||!/cancel|abort/i.test(error.message))throw error;}
  finally{await stop();for(const signal of signals)process.off(signal,signalStop);stdin.off('end',signalStop);stdin.off('close',signalStop);}
}
