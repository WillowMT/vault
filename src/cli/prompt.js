import { StringDecoder } from 'node:string_decoder';
export function readPassword({input,output,label,signal}){
  if(!input.isTTY||typeof input.setRawMode!=='function')return Promise.reject(new Error('Run SecretCLI in an interactive terminal to enter your password.'));
  return new Promise((resolve,reject)=>{
    const decoder=new StringDecoder('utf8');let characters=[],finished=false;
    const wasRaw=Boolean(input.isRaw);
    function finish(error){
      if(finished)return;finished=true;
      input.off('data',onData);input.off('end',cancel);input.off('error',finish);signal?.removeEventListener('abort',cancel);
      input.setRawMode(wasRaw);input.pause();output.write('\n');
      const result=Buffer.from(characters.join(''));characters.fill('');characters=[];
      if(error){result.fill(0);reject(error);}else resolve(result);
    }
    function cancel(){finish(new Error('Password entry cancelled'));}
    function onData(chunk){
      for(const character of decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))){
        if(character==='\x03'||character==='\x04'){cancel();return;}
        if(character==='\r'||character==='\n'){finish();return;}
        if(character==='\x7f'||character==='\b')characters.pop();
        else if(character==='\x15')characters=[];
        else if(character>=' '&&character!=='\x1b'){if(characters.length<1024)characters.push(character);}
      }
    }
    output.write(`  ${label}  `);input.setRawMode(true);input.resume();
    input.on('data',onData);input.once('end',cancel);input.once('error',finish);signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
  });
}

export function readText({input,output,label,signal}){
  if(!input.isTTY||typeof input.setRawMode!=='function')return Promise.reject(new Error('Run SecretCLI in an interactive terminal to continue.'));
  return new Promise((resolve,reject)=>{
    let value='',finished=false;
    const wasRaw=Boolean(input.isRaw);
    function render(){output.write(`\r\x1b[2K  ${label}  ${value}`);}
    function finish(error){
      if(finished)return;finished=true;
      input.off('data',onData);input.off('end',cancel);input.off('error',finish);signal?.removeEventListener('abort',cancel);
      input.setRawMode(wasRaw);input.pause();output.write('\n');
      if(error)reject(error);else resolve(Buffer.from(value));
    }
    function cancel(){finish(new Error('Entry cancelled'));}
    function onData(chunk){
      for(const character of chunk.toString('utf8')){
        if(character==='\x03'||character==='\x04'){cancel();return;}
        if(character==='\r'||character==='\n'){finish();return;}
        if(character==='\x7f'||character==='\b')value=value.slice(0,-1);
        else if(character==='\x15')value='';
        else if(character>=' '&&character!=='\x1b'&&value.length<1024)value+=character;
        else continue;
        render();
      }
    }
    input.setRawMode(true);input.resume();render();
    input.on('data',onData);input.once('end',cancel);input.once('error',finish);signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
  });
}
