import { run } from '../../src/cli/main.js';
import { startServer } from '../../src/server/server.js';
await run({argv:['--vault',process.argv[2],'--no-open'],passwordReader:async()=>Buffer.from('lifecycle test passphrase'),startEnrollmentServer:async vault=>startServer(vault),onReady:async app=>{process.send({origin:app.origin,launchUrl:app.launchUrl});}});
process.disconnect();
