import { run } from '../../src/cli/main.js';
await run({argv:['--vault',process.argv[2],'--no-open'],passwordReader:async()=>Buffer.from('lifecycle test passphrase'),onReady:async app=>{process.send({origin:app.origin,launchUrl:app.launchUrl});}});
process.disconnect();
