#!/usr/bin/env node
(async () => {
  const { install } = await import('./runtime.mjs');
  await install();
})().catch(error => {
  console.error(`[@cometix/anthropic-cc postinstall] ${error.message}`);
  process.exitCode = 1;
});
