const paint=(value,code,color)=>color?`\x1b[${code}m${value}\x1b[0m`:value;
export function banner(color){return `\n  ${paint('◆','38;5;115',color)} ${paint('secret','1',color)}${paint('cli','2',color)}\n  ${paint('A little space. Only yours.','2',color)}\n\n`;}
export function renderStatus({origin,startedAt,color,width=80,message='',locked=false}){
  const minutes=Math.floor((Date.now()-startedAt)/60000),duration=minutes<60?`${minutes}m`:`${Math.floor(minutes/60)}h ${minutes%60}m`;
  const lines=[`  ◆ Vault ${locked?'locked - waiting for passkey or recovery':'unlocked'}`,'',`  Local    ${origin}`,`  Session  ${duration}`, '',locked?(width<48?'  O open · L link · R recover':'  O open browser · L show link · R recovery password'):(width<48?'  O open · L link':'  O open browser · L show launch link'),'  Ctrl+C lock & quit'];
  if(message)lines.push('',`  ${message}`);
  const clipped=lines.map(line=>line.length>width?line.slice(0,Math.max(1,width-1))+'…':line);
  if(color)clipped[0]=paint(clipped[0],'38;5;115',true);
  return clipped.join('\n')+'\n';
}
export async function busy(output,label,fn){
  if(!output.isTTY){output.write(`  ${label}\n`);return fn();}
  const frames=['◐','◓','◑','◒'];let i=0;
  output.write(`  ${frames[0]} ${label}`);
  const timer=setInterval(()=>output.write(`\r  ${frames[++i%frames.length]} ${label}`),120);
  try{return await fn();}finally{clearInterval(timer);output.write('\r\x1b[2K');}
}
