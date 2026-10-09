#!/usr/bin/env node
(async () => {
  const { launch } = await import('./runtime.mjs');
  await launch();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
