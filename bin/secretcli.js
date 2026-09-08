#!/usr/bin/env node
import { run } from '../src/cli/main.js';
run().catch(error=>{
  process.stderr.write(`\n  ${error.code==='ENOSPC'?'Disk is full. Free some space and try again.':error.message}\n\n`);
  process.exitCode=1;
});
