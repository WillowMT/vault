import {bootstrap,request,requestBlob,uploadFile,configureLock,shutdown,isUnlocked} from './api.js';
import {fileCategory,fileIcon,bytes,clearPreview,showPreview,setGallery} from './preview.js';
import {attachThumbnail,revokeThumbnails} from './thumbnails.js';
import {enroll} from './webauthn.js';
const $=selector=>document.querySelector(selector);
let entries=[],folders=[],visibleEntries=[],selected=new Set(),parentId=null,category='all',view='list',query='',sort='name',revision=0,heartbeatTimer,searchTimer,noticeTimer,dragDepth=0,dialogAction,dialogGeneration=0,passkeyEnabled=false,securityBusy=true,downloadBusy=false;
const categoryNames={all:'All files',image:'Images',video:'Videos',audio:'Audio',document:'Documents & other'};
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function notice(text,error=false){if(!isUnlocked())return;const node=$('#notice');node.textContent=text;node.className=error?'error':'';node.hidden=false;clearTimeout(noticeTimer);if(!error)noticeTimer=setTimeout(()=>{node.hidden=true;},5000);}
function selectedEntries(){return visibleEntries.filter(entry=>selected.has(entry.id));}
function renderSelection(){const count=selectedEntries().length,all=visibleEntries.length>0&&count===visibleEntries.length,selectAll=$('#select-all');if(!selectAll)return;selectAll.checked=all;selectAll.indeterminate=count>0&&!all;selectAll.disabled=!visibleEntries.length;for(const input of document.querySelectorAll('.entry-select'))input.checked=selected.has(input.dataset.entryId);$('#selection-count').textContent=`${count} selected`;$('#selection-actions').hidden=count===0;$('#bulk-download').disabled=count===0||downloadBusy;$('#bulk-move').disabled=count===0;$('#bulk-delete').disabled=count===0;}
function clearSelection(){selected.clear();renderSelection();}
function lockView(){
  shutdown();revision++;dialogGeneration++;clearInterval(heartbeatTimer);clearTimeout(searchTimer);clearTimeout(noticeTimer);clearPreview();revokeThumbnails();setGallery([]);entries=[];folders=[];visibleEntries=[];clearSelection();parentId=null;query='';dialogAction=null;passkeyEnabled=false;securityBusy=true;downloadBusy=false;
  for(const dialog of document.querySelectorAll('dialog'))dialog.close();
  const page=element('main',undefined,'locked-page');page.append(element('div','◇','locked-mark'),element('h1','Your vault is locked.'),element('p','Your files are encrypted and tucked away. Open Vault in your terminal, then press O to return.'),element('code','vault'),element('small','This page clears when your CLI session ends.'));
  document.body.replaceChildren(page);document.title='Secret — vault locked';
}
configureLock(lockView);
async function load(){
  clearSelection();const current=++revision;
  try{const params=new URLSearchParams({parentId:parentId||'',q:query,scope:category==='all'?'folder':'all'});
    const data=await request(`/api/entries?${params}`);
    if(!isUnlocked()||current!==revision)return;entries=data.entries;folders=data.folders;$('#file-count').textContent=data.summary.files;$('#storage-size').textContent=bytes(data.summary.bytes);render();
  }catch(error){if(isUnlocked()&&current===revision){$('#files').setAttribute('aria-busy','false');notice(error.message,true);}}
}
function navigate(id){if(!isUnlocked())return;clearSelection();parentId=id;category='all';query='';$('#search').value='';load();}
function openEntry(entry){if(entry.kind==='folder')navigate(entry.id);else showPreview(entry);}
function crumb(){
  const target=$('#breadcrumbs');target.replaceChildren();if(!parentId)return;
  const trail=[];let id=parentId;const seen=new Set();while(id&&!seen.has(id)){seen.add(id);const f=folders.find(f=>f.id===id);if(!f)break;trail.unshift(f);id=f.parentId;}
  const root=element('button','All files');root.onclick=()=>navigate(null);target.append(root);
  for(const f of trail){target.append(element('span','/'));const button=element('button',f.name);button.onclick=()=>navigate(f.id);target.append(button);}
}
function thumbnailTile(entry){const tile=element('span',undefined,'file-thumb');attachThumbnail(tile,entry);return tile;}
function render(){
  $('#files').setAttribute('aria-busy','false');crumb();
  $('#page-title').textContent=query?'Search results':parentId?(folders.find(f=>f.id===parentId)?.name||'Folder'):categoryNames[category];
  $('#page-description').textContent=query?`Files matching “${query}”`:parentId?'A little more organized. Just as private.':category==='all'?'Everything you keep, kept private.':'Your collection, stored safely on this computer.';
  for(const button of document.querySelectorAll('[data-category]')){const active=button.dataset.category===category;button.classList.toggle('active',active);button.setAttribute('aria-current',active?'page':'false');}
  const filtered=entries.filter(e=>category==='all'||fileCategory(e)===category).sort((a,b)=>{
    if(a.kind!==b.kind)return a.kind==='folder'?-1:1;
    return sort==='recent'?new Date(b.createdAt)-new Date(a.createdAt):sort==='size'?b.size-a.size:a.name.localeCompare(b.name,undefined,{numeric:true});
  });
  visibleEntries=filtered;
  $('#item-count').textContent=`${filtered.length} ${filtered.length===1?'item':'items'}`;
  renderSelection();
  setGallery(filtered.filter(e=>e.kind==='file'));
  const container=$('#files');container.replaceChildren();container.className=view==='grid'&&filtered.length?'file-grid':'';
  if(!filtered.length){
    const empty=element('div',undefined,'empty-state');empty.append(element('div',undefined,'empty-art'),element('h2',query?'Nothing by that name.':category!=='all'?'Room for your collection.':parentId?'A fresh folder.':'Your space starts here.'));
    empty.append(element('p',query?'Try another name, or clear your search to see all your files.':'Photos, films, recordings, and everything in between. Drop your files here. We’ll keep them private.'));
    const button=element('button',query?'Clear search':'↑  Upload your first files','button primary');button.onclick=()=>query?($('#search').value='',query='',load()):$('#file-input').click();empty.append(button);
    if(!query)empty.append(element('span','or drag and drop files anywhere','empty-hint'));container.append(empty);return;
  }
  if(view==='list'){const head=element('div',undefined,'list-head');for(const [text,cls] of [['','entry-select-head'],['Name',''],['Type','file-kind'],['Added','file-date'],['Size',''],['','']])head.append(element('span',text,cls));container.append(head);}
  for(const entry of filtered){
    const row=element('div',undefined,view==='list'?'file-row':'file-card'),select=element('input');select.type='checkbox';select.className='entry-select';select.dataset.entryId=entry.id;select.checked=selected.has(entry.id);select.setAttribute('aria-label',`Select ${entry.name}`);select.addEventListener('click',event=>event.stopPropagation());select.addEventListener('change',event=>{if(event.target.checked)selected.add(entry.id);else selected.delete(entry.id);renderSelection();});const name=element('button',undefined,'file-name');const thumb=view==='grid'&&entry.kind==='file'&&['image','video'].includes(fileCategory(entry))?thumbnailTile(entry):fileIcon(entry);name.append(thumb,element('span',entry.name,'file-name-text'));name.title=entry.name;name.onclick=()=>openEntry(entry);row.append(select,name);
    if(view==='list'){row.append(element('span',entry.kind==='folder'?'Folder':fileCategory(entry)==='document'?'File':fileCategory(entry),'file-kind'),element('span',new Date(entry.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric'}),'file-date'));}
    row.append(element('div',entry.kind==='folder'?'—':bytes(entry.size),'file-size'));
    const menu=element('details',undefined,'file-menu'),summary=element('summary','⋯');summary.setAttribute('aria-label',`Actions for ${entry.name}`);menu.append(summary);
    menu.addEventListener('toggle',()=>{if(menu.open)for(const other of document.querySelectorAll('.file-menu[open]'))if(other!==menu)other.open=false;});
    const items=element('div',undefined,'menu-items');
    function action(text,fn,cls){const button=element('button',text,cls);button.onclick=()=>{menu.open=false;fn();};items.append(button);}
    action(entry.kind==='folder'?'Open folder':'Preview',()=>openEntry(entry));
    if(entry.kind==='file'){const link=element('a','Download');link.href=`/api/files/${entry.id}/download`;link.download=entry.name;link.onclick=()=>{menu.open=false;};items.append(link);}
    action('Rename',()=>rename(entry));action('Move to folder',()=>move(entry));action('Delete',()=>remove(entry),'delete-action');menu.append(items);row.append(menu);container.append(row);
  }
}
function dialog({title,description='',fields=[],submit='Save',danger=false,action}){
  dialogGeneration++;$('#dialog-title').textContent=title;$('#dialog-description').textContent=description;$('#dialog-fields').replaceChildren(...fields);$('#dialog-error').textContent='';$('#dialog-submit').textContent=submit;$('#dialog-submit').className=`button ${danger?'danger':'primary'}`;$('#dialog-submit').disabled=false;dialogAction=action;$('#action-dialog').showModal();
  $('#dialog-fields input')?.focus();$('#dialog-fields input')?.select();
}
function nameField(value=''){const label=element('label','Name'),input=element('input');input.id='entry-name';label.htmlFor=input.id;input.value=value;input.required=true;input.autocomplete='off';input.maxLength=255;return [label,input];}
function rename(entry){dialog({title:'Rename',fields:nameField(entry.name),action:async()=>{await request(`/api/entries/${entry.id}`,{method:'PATCH',body:{name:$('#entry-name').value}});notice('Name updated.');}});}
function destinationField(selectedEntries,value=''){
  const option=(name,value)=>{const node=element('option',name);node.value=value;return node;};
  const select=element('select');select.id='destination';select.setAttribute('aria-label','Destination folder');select.append(option('All files', ''));
  const selectedFolders=new Set(selectedEntries.filter(entry=>entry.kind==='folder').map(entry=>entry.id));
  function descendant(folder){let id=folder.id;const seen=new Set();while(id&&!seen.has(id)){if(selectedFolders.has(id))return true;seen.add(id);id=folders.find(f=>f.id===id)?.parentId;}return false;}
  function path(folder){const names=[folder.name];let id=folder.parentId;const seen=new Set();while(id&&!seen.has(id)){seen.add(id);const f=folders.find(f=>f.id===id);if(!f)break;names.unshift(f.name);id=f.parentId;}return names.join(' / ');}
  for(const folder of folders.filter(f=>!descendant(f)).sort((a,b)=>path(a).localeCompare(path(b))))select.append(option(path(folder),folder.id));select.value=value;return select;
}
function move(entry){const select=destinationField([entry],entry.parentId||'');dialog({title:'Move to folder',description:entry.name,fields:[select],submit:'Move',action:async()=>{await request(`/api/entries/${entry.id}`,{method:'PATCH',body:{parentId:select.value||null}});notice('Moved to its new home.');}});}
function remove(entry){dialog({title:`Delete “${entry.name}”?`,description:entry.kind==='folder'?'This permanently deletes the folder and everything inside. There is no trash or undo.':'This permanently deletes this file from your vault. There is no trash or undo.',submit:'Delete permanently',danger:true,action:async()=>{await request(`/api/entries/${entry.id}`,{method:'DELETE'});notice('Deleted from your vault.');}});}
function bulkMove(){const entries=selectedEntries(),select=destinationField(entries);dialog({title:'Move selected entries',description:`Move ${entries.length} selected ${entries.length===1?'entry':'entries'} to a folder.`,fields:[select],submit:'Move',action:async()=>{const {moved}=await request('/api/entries/bulk-move',{method:'POST',body:{ids:entries.map(entry=>entry.id),parentId:select.value||null}});clearSelection();notice(`Moved ${moved} ${moved===1?'entry':'entries'}.`);}});}
function bulkDelete(){const entries=selectedEntries(),folders=entries.filter(entry=>entry.kind==='folder').length,warning=folders?` Selected folder${folders===1?'':'s'} and everything inside will be permanently deleted.`:' This permanently deletes the selected files from your vault.';dialog({title:'Delete selected entries?',description:`${entries.length} selected ${entries.length===1?'entry':'entries'}.${warning} There is no trash or undo.`,submit:'Delete permanently',danger:true,action:async()=>{const {deleted}=await request('/api/entries/bulk-delete',{method:'POST',body:{ids:entries.map(entry=>entry.id)}});clearSelection();notice(`Deleted ${deleted} ${deleted===1?'entry':'entries'} from your vault.`);}});}
function clickDownload(href,name){const anchor=element('a');anchor.href=href;anchor.hidden=true;if(name)anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();}
async function bulkDownload(){const entries=selectedEntries();if(!entries.length||downloadBusy)return;downloadBusy=true;renderSelection();try{const {url}=await request('/api/downloads',{method:'POST',body:{ids:entries.map(entry=>entry.id)}});clickDownload(url);}catch(error){notice(`Could not start download: ${error.message}`,true);}finally{downloadBusy=false;if(isUnlocked())renderSelection();}}
function renderSecurity(){const control=$('#passkey-switch');if(!control)return;control.checked=passkeyEnabled;control.disabled=securityBusy;$('#passkey-status').textContent=securityBusy?'Updating…':passkeyEnabled?'On':'Off';$('#generate-recovery').disabled=securityBusy;}
async function loadSecurity(){try{const status=await request('/api/passkey');passkeyEnabled=status.enabled;securityBusy=false;renderSecurity();}catch(error){if(isUnlocked()){securityBusy=true;renderSecurity();notice(`Could not load security settings: ${error.message}`,true);}}}
async function enablePasskey(){securityBusy=true;renderSecurity();try{
  if(!window.PublicKeyCredential||!window.navigator.credentials?.create||!window.navigator.credentials?.get)throw new Error('WebAuthn is unavailable on this browser or device.');
  await enroll((path,body)=>request(path,{method:'POST',body:body||{}}));passkeyEnabled=true;notice('Passkey enabled.');
}catch(error){passkeyEnabled=false;notice(`Could not enable passkey: ${error.message}`,true);}finally{securityBusy=false;if(isUnlocked())renderSecurity();}}
function disablePasskey(){renderSecurity();dialog({title:'Turn off passkey?',description:'You will need your password or recovery file the next time you unlock this vault.',submit:'Turn off',danger:true,action:async()=>{securityBusy=true;renderSecurity();try{await request('/api/passkey',{method:'DELETE'});passkeyEnabled=false;notice('Passkey disabled.');}catch(error){passkeyEnabled=true;notice(`Could not disable passkey: ${error.message}`,true);throw error;}finally{securityBusy=false;if(isUnlocked())renderSecurity();}}});}
async function generateRecoveryImage(){if(securityBusy)return;securityBusy=true;renderSecurity();try{const image=await requestBlob('/api/recovery-image'),url=URL.createObjectURL(image);try{clickDownload(url,'Vault recovery file.png');}finally{URL.revokeObjectURL(url);}notice('Recovery file downloaded. Any previous file is revoked.');}catch(error){notice(`Could not generate recovery file: ${error.message}`,true);}finally{securityBusy=false;if(isUnlocked())renderSecurity();}}
let uploadQueue=Promise.resolve();
function upload(files){
  if(!isUnlocked())return;const destination=parentId;
  for(const file of files){
    const row=element('div',undefined,'upload-row'),label=element('span',file.name,'upload-name'),progress=element('progress'),status=element('span','Queued'),cancel=element('button','×');cancel.setAttribute('aria-label',`Cancel upload of ${file.name}`);progress.setAttribute('aria-label',`Upload progress for ${file.name}`);status.setAttribute('aria-live','polite');progress.max=100;progress.value=0;
    row.append(label,progress,status,cancel);$('#uploads').append(row);$('#uploads').hidden=false;let cancelled=false,transfer;cancel.onclick=()=>{cancelled=true;transfer?.cancel();status.textContent='Cancelled';cancel.disabled=true;};
    uploadQueue=uploadQueue.then(async()=>{
      if(cancelled||!isUnlocked())return;
      try{status.textContent='Uploading…';transfer=uploadFile(file,destination,value=>{progress.value=value;status.textContent=value===100?'Encrypting…':`${value}%`;});await transfer.promise;if(!isUnlocked())return;status.textContent='Stored securely';cancel.textContent='✓';cancel.disabled=true;await load();}
      catch(error){if(isUnlocked()){status.textContent=cancelled?'Cancelled':'Failed';row.classList.add('error');notice(`${file.name}: ${error.message}`,true);cancel.disabled=true;}}
    });
  }
}
$('#upload').onclick=()=>$('#file-input').click();$('#file-input').onchange=event=>{upload([...event.target.files]);event.target.value='';};
$('#new-folder').onclick=()=>dialog({title:'New folder',fields:nameField(),submit:'Create folder',action:async()=>{await request('/api/folders',{method:'POST',body:{parentId,name:$('#entry-name').value}});notice('Folder created.');}});
function closeActionDialog(){dialogGeneration++;dialogAction=null;$('#action-dialog').close();}
$('#action-form').onsubmit=async event=>{event.preventDefault();const generation=dialogGeneration,action=dialogAction;if(typeof action!=='function')return;$('#dialog-submit').disabled=true;try{await action();if(isUnlocked()&&generation===dialogGeneration){closeActionDialog();await load();}}catch(error){if(isUnlocked()&&generation===dialogGeneration)$('#dialog-error').textContent=error.message;}finally{if(isUnlocked()&&generation===dialogGeneration)$('#dialog-submit').disabled=false;}};
for(const id of ['#dialog-close','#dialog-cancel'])$(id).onclick=closeActionDialog;
$('#action-dialog').addEventListener('cancel',event=>{event.preventDefault();closeActionDialog();});
$('#preview-close').onclick=clearPreview;$('#preview-dialog').addEventListener('cancel',event=>{event.preventDefault();clearPreview();});
$('#select-all').onchange=event=>{if(event.target.checked)for(const entry of visibleEntries)selected.add(entry.id);else clearSelection();renderSelection();};$('#bulk-download').onclick=bulkDownload;$('#bulk-move').onclick=bulkMove;$('#bulk-delete').onclick=bulkDelete;$('#clear-selection').onclick=clearSelection;
$('#passkey-switch').onchange=event=>event.target.checked?enablePasskey():disablePasskey();$('#generate-recovery').onclick=generateRecoveryImage;
$('#sort').onchange=event=>{clearSelection();sort=event.target.value;render();};
for(const mode of ['list','grid'])$(`#${mode}-view`).onclick=()=>{clearSelection();view=mode;for(const m of ['list','grid']){$(`#${m}-view`).classList.toggle('selected',m===view);$(`#${m}-view`).setAttribute('aria-pressed',String(m===view));}render();};
for(const button of document.querySelectorAll('[data-category]'))button.onclick=()=>{if(!isUnlocked())return;clearSelection();category=button.dataset.category;parentId=null;query='';$('#search').value='';load();};
$('#search').oninput=event=>{clearSelection();query=event.target.value.trim();clearTimeout(searchTimer);searchTimer=setTimeout(load,180);};
document.addEventListener('keydown',event=>{if(!isUnlocked())return;if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('dialog[open]')){event.preventDefault();$('#search').focus();}if(event.key==='Escape')for(const menu of document.querySelectorAll('.file-menu[open]'))menu.open=false;});
document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.file-menu[open]'))if(!menu.contains(event.target))menu.open=false;});
document.addEventListener('dragenter',event=>{if(!isUnlocked()||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();dragDepth++;$('#drop-overlay').hidden=false;});
document.addEventListener('dragover',event=>{if(isUnlocked())event.preventDefault();});
document.addEventListener('dragleave',()=>{if(!isUnlocked())return;if(--dragDepth<=0){dragDepth=0;$('#drop-overlay').hidden=true;}});
document.addEventListener('drop',event=>{event.preventDefault();if(!isUnlocked())return;dragDepth=0;$('#drop-overlay').hidden=true;upload([...event.dataTransfer.files]);});
async function heartbeat(){if(!isUnlocked())return;try{const response=await fetch('/api/heartbeat',{cache:'no-store',signal:AbortSignal.timeout(2000)});if(!response.ok)lockView();}catch{lockView();}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)heartbeat();});
window.addEventListener('pagehide',()=>{clearPreview();clearSelection();});
try{await bootstrap();await Promise.all([load(),loadSecurity()]);if(isUnlocked())heartbeatTimer=setInterval(heartbeat,2000);}catch{lockView();}
