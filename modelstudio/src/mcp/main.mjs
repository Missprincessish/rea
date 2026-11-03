#!/usr/bin/env node
import { main } from '../mcp/server.mjs';

main().catch((error) => {
  process.stderr.write(`[modelstudio-mcp] fatal: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
