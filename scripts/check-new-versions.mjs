import { execFileSync } from 'node:child_process';
import semver from 'semver';

const FIRST_SEA_VERSION = '2.1.113';

export async function checkNewVersions({ existing = [] } = {}) {
  const allVersionsRaw = execFileSync('npm', [
    'view', '@anthropic-ai/claude-code', 'versions', '--json',
  ], { encoding: 'utf8', timeout: 30_000 });

  const allVersions = JSON.parse(allVersionsRaw);
  const existingSet = new Set(existing);

  // Only ever the single newest upstream version: this fork republishes the
  // current release, not the whole back catalogue. Without this the first
  // auto-detected run builds every unreleased version since 2.1.113.
  const newestExisting = existing
    .filter(v => semver.valid(v))
    .sort(semver.rcompare)[0];

  const candidates = allVersions
    .filter(v => semver.gte(v, FIRST_SEA_VERSION))
    .filter(v => !existingSet.has(v))
    .filter(v => !newestExisting || semver.gt(v, newestExisting))
    .sort(semver.compare)
    .slice(-1);

  // Verify each candidate is actually a SEA version
  // (has platform optionalDeps, not @img/sharp-*)
  const seaVersions = [];
  for (const v of candidates) {
    try {
      const depsRaw = execFileSync('npm', [
        'view', `@anthropic-ai/claude-code@${v}`, 'optionalDependencies', '--json',
      ], { encoding: 'utf8', timeout: 15_000 });
      const deps = JSON.parse(depsRaw || '{}');
      if (deps['@anthropic-ai/claude-code-linux-x64']) {
        seaVersions.push(v);
      }
    } catch {}
  }

  return seaVersions;
}

const isMain = process.argv[1]?.endsWith('check-new-versions.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  let existing = [];
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--existing' && args[i+1]) {
      try { existing = JSON.parse(args[++i]); } catch {}
    }
    if (args[i] === '--json') json = true;
  }

  const versions = await checkNewVersions({ existing });

  if (json) {
    process.stdout.write(JSON.stringify(versions));
  } else {
    if (versions.length === 0) {
      console.log('No new SEA versions found.');
    } else {
      console.log(`Found ${versions.length} new version(s):`);
      versions.forEach(v => console.log(`  ${v}`));
    }
  }
}
