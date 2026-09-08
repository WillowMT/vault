import {bootstrap,request,uploadFile,configureLock,shutdown,isUnlocked} from './api.js';
import {fileCategory,fileIcon,bytes,clearPreview,showPreview} from './preview.js';
const $=selector=>document.querySelector(selector);
let entries=[],folders=[],parentId=null,category='all',view='list',query='',sort='name',revision=0,heartbeatTimer,searchTimer,noticeTimer,dragDepth=0,dialogAction;
const categoryNames={all:'All files',image:'Images',video:'Videos',audio:'Audio',document:'Documents & other'};
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function notice(text,error=false){if(!isUnlocked())return;const node=$('#notice');node.textContent=text;node.className=error?'error':'';node.hidden=false;clearTimeout(noticeTimer);if(!error)noticeTimer=setTimeout(()=>{node.hidden=true;},5000);}
function lockView(){
  shutdown();revision++;clearInterval(heartbeatTimer);clearTimeout(searchTimer);clearTimeout(noticeTimer);clearPreview();entries=[];folders=[];parentId=null;query='';dialogAction=null;
  for(const dialog of document.querySelectorAll('dialog'))dialog.close();
  const page=element('main',undefined,'locked-page');page.append(element('div','◇','locked-mark'),element('h1','Your vault is locked.'),element('p','Your files are encrypted and tucked away. Open SecretCLI in your terminal, then press O to return.'),element('code','npm start'),element('small','This page clears when your CLI session ends.'));
  document.body.replaceChildren(page);document.title='Secret — vault locked';
}
configureLock(lockView);
async function load(){
  const current=++revision;
  try{const params=new URLSearchParams({parentId:parentId||'',q:query,scope:category==='all'?'folder':'all'});
    const data=await request(`/api/entries?${params}`);
    if(!isUnlocked()||current!==revision)return;entries=data.entries;folders=data.folders;$('#file-count').textContent=data.summary.files;$('#storage-size').textContent=bytes(data.summary.bytes);render();
  }catch(error){if(isUnlocked()&&current===revision){$('#files').setAttribute('aria-busy','false');notice(error.message,true);}}
}
function navigate(id){if(!isUnlocked())return;parentId=id;category='all';query='';$('#search').value='';load();}
function openEntry(entry){if(entry.kind==='folder')navigate(entry.id);else showPreview(entry);}
function crumb(){
  const target=$('#breadcrumbs');target.replaceChildren();if(!parentId)return;
  const trail=[];let id=parentId;const seen=new Set();while(id&&!seen.has(id)){seen.add(id);const f=folders.find(f=>f.id===id);if(!f)break;trail.unshift(f);id=f.parentId;}
  const root=element('button','All files');root.onclick=()=>navigate(null);target.append(root);
  for(const f of trail){target.append(element('span','/'));const button=element('button',f.name);button.onclick=()=>navigate(f.id);target.append(button);}
}
function render(){
  $('#files').setAttribute('aria-busy','false');crumb();
  $('#page-title').textContent=query?'Search results':parentId?(folders.find(f=>f.id===parentId)?.name||'Folder'):categoryNames[category];
  $('#page-description').textContent=query?`Files matching “${query}”`:parentId?'A little more organized. Just as private.':category==='all'?'Everything you keep, kept private.':'Your collection, stored safely on this computer.';
  for(const button of document.querySelectorAll('[data-category]')){const active=button.dataset.category===category;button.classList.toggle('active',active);button.setAttribute('aria-current',active?'page':'false');}
  const filtered=entries.filter(e=>category==='all'||fileCategory(e)===category).sort((a,b)=>{
    if(a.kind!==b.kind)return a.kind==='folder'?-1:1;
    return sort==='recent'?new Date(b.createdAt)-new Date(a.createdAt):sort==='size'?b.size-a.size:a.name.localeCompare(b.name,undefined,{numeric:true});
  });
  $('#item-count').textContent=`${filtered.length} ${filtered.length===1?'item':'items'}`;
  const container=$('#files');container.replaceChildren();container.className=view==='grid'&&filtered.length?'file-grid':'';
  if(!filtered.length){
    const empty=element('div',undefined,'empty-state');empty.append(element('div',undefined,'empty-art'),element('h2',query?'Nothing by that name.':category!=='all'?'Room for your collection.':parentId?'A fresh folder.':'Your space starts here.'));
    empty.append(element('p',query?'Try another name, or clear your search to see all your files.':'Photos, films, recordings, and everything in between. Drop your files here. We’ll keep them private.'));
    const button=element('button',query?'Clear search':'↑  Upload your first files','button primary');button.onclick=()=>query?($('#search').value='',query='',load()):$('#file-input').click();empty.append(button);
    if(!query)empty.append(element('span','or drag and drop files anywhere','empty-hint'));container.append(empty);return;
  }
  if(view==='list'){const head=element('div',undefined,'list-head');for(const [text,cls] of [['Name',''],['Type','file-kind'],['Added','file-date'],['Size',''],['','']])head.append(element('span',text,cls));container.append(head);}
  for(const entry of filtered){
    const row=element('div',undefined,view==='list'?'file-row':'file-card');const name=element('button',undefined,'file-name');name.append(fileIcon(entry),element('span',entry.name,'file-name-text'));name.title=entry.name;name.onclick=()=>openEntry(entry);row.append(name);
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
  $('#dialog-title').textContent=title;$('#dialog-description').textContent=description;$('#dialog-fields').replaceChildren(...fields);$('#dialog-error').textContent='';$('#dialog-submit').textContent=submit;$('#dialog-submit').className=`button ${danger?'danger':'primary'}`;$('#dialog-submit').disabled=false;dialogAction=action;$('#action-dialog').showModal();
  $('#dialog-fields input')?.focus();$('#dialog-fields input')?.select();
}
function nameField(value=''){const label=element('label','Name'),input=element('input');input.id='entry-name';label.htmlFor=input.id;input.value=value;input.required=true;input.autocomplete='off';input.maxLength=255;return [label,input];}
function rename(entry){dialog({title:'Rename',fields:nameField(entry.name),action:async()=>{await request(`/api/entries/${entry.id}`,{method:'PATCH',body:{name:$('#entry-name').value}});notice('Name updated.');}});}
function move(entry){
  const option=(name,value)=>{const node=element('option',name);node.value=value;return node;};
  const select=element('select');select.id='destination';select.setAttribute('aria-label','Destination folder');select.append(option('All files', ''));
  function descendant(folder){let id=folder.id;const seen=new Set();while(id&&!seen.has(id)){if(id===entry.id)return true;seen.add(id);id=folders.find(f=>f.id===id)?.parentId;}return false;}
  function path(folder){const names=[folder.name];let id=folder.parentId;const seen=new Set();while(id&&!seen.has(id)){seen.add(id);const f=folders.find(f=>f.id===id);if(!f)break;names.unshift(f.name);id=f.parentId;}return names.join(' / ');}
  for(const folder of folders.filter(f=>!descendant(f)).sort((a,b)=>path(a).localeCompare(path(b))))select.append(option(path(folder),folder.id));select.value=entry.parentId||'';
  dialog({title:'Move to folder',description:entry.name,fields:[select],submit:'Move',action:async()=>{await request(`/api/entries/${entry.id}`,{method:'PATCH',body:{parentId:select.value||null}});notice('Moved to its new home.');}});
}
function remove(entry){dialog({title:`Delete “${entry.name}”?`,description:entry.kind==='folder'?'This permanently deletes the folder and everything inside. There is no trash or undo.':'This permanently deletes this file from your vault. There is no trash or undo.',submit:'Delete permanently',danger:true,action:async()=>{await request(`/api/entries/${entry.id}`,{method:'DELETE'});notice('Deleted from your vault.');}});}
let uploadQueue=Promise.resolve();
function upload(files){
  if(!isUnlocked())return;const destination=parentId;
  for(const file of files){
    const row=element('div',undefined,'upload-row'),label=element('span',file.name,'upload-name'),progress=element('progress'),status=element('span','Queued'),cancel=element('button','×');cancel.setAttribute('aria-label',`Cancel upload of ${file.name}`);progress.max=100;progress.value=0;
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
$('#action-form').onsubmit=async event=>{event.preventDefault();$('#dialog-submit').disabled=true;try{await dialogAction();if(isUnlocked()){$('#action-dialog').close();dialogAction=null;await load();}}catch(error){if(isUnlocked())$('#dialog-error').textContent=error.message;}finally{if(isUnlocked())$('#dialog-submit').disabled=false;}};
for(const id of ['#dialog-close','#dialog-cancel'])$(id).onclick=()=>$('#action-dialog').close();
$('#preview-close').onclick=clearPreview;$('#preview-dialog').addEventListener('cancel',event=>{event.preventDefault();clearPreview();});
$('#sort').onchange=event=>{sort=event.target.value;render();};
for(const mode of ['list','grid'])$(`#${mode}-view`).onclick=()=>{view=mode;for(const m of ['list','grid']){$(`#${m}-view`).classList.toggle('selected',m===view);$(`#${m}-view`).setAttribute('aria-pressed',String(m===view));}render();};
for(const button of document.querySelectorAll('[data-category]'))button.onclick=()=>{if(!isUnlocked())return;category=button.dataset.category;parentId=null;query='';$('#search').value='';load();};
$('#search').oninput=event=>{query=event.target.value.trim();clearTimeout(searchTimer);searchTimer=setTimeout(load,180);};
document.addEventListener('keydown',event=>{if(!isUnlocked())return;if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('dialog[open]')){event.preventDefault();$('#search').focus();}if(event.key==='Escape')for(const menu of document.querySelectorAll('.file-menu[open]'))menu.open=false;});
document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.file-menu[open]'))if(!menu.contains(event.target))menu.open=false;});
document.addEventListener('dragenter',event=>{if(!isUnlocked()||!event.dataTransfer.types.includes('Files'))return;event.preventDefault();dragDepth++;$('#drop-overlay').hidden=false;});
document.addEventListener('dragover',event=>{if(isUnlocked())event.preventDefault();});
document.addEventListener('dragleave',()=>{if(!isUnlocked())return;if(--dragDepth<=0){dragDepth=0;$('#drop-overlay').hidden=true;}});
document.addEventListener('drop',event=>{event.preventDefault();if(!isUnlocked())return;dragDepth=0;$('#drop-overlay').hidden=true;upload([...event.dataTransfer.files]);});
async function heartbeat(){if(!isUnlocked())return;try{const response=await fetch('/api/heartbeat',{cache:'no-store',signal:AbortSignal.timeout(2000)});if(!response.ok)lockView();}catch{lockView();}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)heartbeat();});
window.addEventListener('pagehide',()=>{clearPreview();});
try{await bootstrap();await load();if(isUnlocked())heartbeatTimer=setInterval(heartbeat,2000);}catch{lockView();}
