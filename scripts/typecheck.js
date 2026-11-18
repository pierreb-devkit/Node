import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const projects = [
  'tsconfig.check.json',
  ...readdirSync('.')
    .filter((f) => /^tsconfig\.check\..+\.json$/.test(f))
    .sort(),
];

for (const project of projects) {
  const { status } = spawnSync(process.execPath, [tsc, '-p', project], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
