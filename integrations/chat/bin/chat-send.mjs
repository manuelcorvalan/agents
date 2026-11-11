#!/usr/bin/env node
// Detached sender entry (ADR-0003 D2). Thin wrapper: all logic in src/app/sender.mjs.
process.stdout.write = () => true;
process.stderr.write = () => true;
import('../src/app/sender.mjs')
  .then((sender) => sender.runSender())
  .catch(() => {})
  .finally(() => process.exit(0));
