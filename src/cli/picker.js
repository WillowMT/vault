export function chooseVault({input,stdout,entries,allowCreate=false,signal}){
  if(!input.isTTY||typeof input.setRawMode!=='function'){
    const sorted=[...entries].sort((first,second)=>(second.lastOpenedAt??0)-(first.lastOpenedAt??0));
    return Promise.resolve(sorted[0]);
  }
  return new Promise((resolve,reject)=>{
    const options=[...entries];if(allowCreate)options.push('create');
    let index=0,finished=false,count=0,digits='';
    const wasRaw=Boolean(input.isRaw);
    function line(option,position){
      const marker=position===index?'▸':' ';
      if(option==='create')return `  ${marker} ${position+1}  New vault…`;
      return `  ${marker} ${position+1}  ${option.name.padEnd(12)}${option.path}${option.missing?'  (missing)':''}`;
    }
    function block(){
      return ['','  Choose a vault','',...options.map(line),'','  ↑/↓ or number · Enter open · q quit'].join('\n')+'\n';
    }
    function render(first){
      if(!first)stdout.write(`\x1b[${count}A\x1b[J`);
      const text=block();count=text.split('\n').length-1;
      stdout.write(text);
    }
    function finish(result){
      if(finished)return;finished=true;
      input.off('data',onData);input.off('end',cancel);input.off('error',finish);signal?.removeEventListener('abort',cancel);
      input.setRawMode(wasRaw);input.pause();
      stdout.write(`\x1b[${count}A\x1b[J`);
      resolve(result);
    }
    function cancel(){finish(undefined);}
    function onData(chunk){
      const data=chunk.toString();
      let position=0;
      while(position<data.length){
        const character=data[position];
        if(character==='\x1b'){
          const sequence=data.slice(position,position+3);
          if(sequence==='\x1b[A'){digits='';index=Math.max(0,index-1);render();position+=3;continue;}
          if(sequence==='\x1b[B'){digits='';index=Math.min(options.length-1,index+1);render();position+=3;continue;}
          position++;continue;
        }
        if(character==='\x03'||character==='\x04'||character==='q'){cancel();return;}
        if(character==='\r'||character==='\n'){finish(options[index]);return;}
        if(character>='0'&&character<='9'){
          const candidate=Number(digits+character);
          if(candidate>=1&&candidate<=options.length){digits+=character;index=candidate-1;render();}
        }
        position++;
      }
    }
    input.setRawMode(true);input.resume();render(true);
    input.on('data',onData);input.once('end',cancel);input.once('error',finish);signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
  });
}
