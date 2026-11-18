// Builds a library package to dist/cjs (CommonJS, for the NestJS API) and dist/esm (ES modules, for web).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const tsc = createRequire(process.cwd() + '/package.json').resolve('typescript/bin/tsc');
rmSync('dist', { recursive: true, force: true });
const run = (args) => execFileSync(process.execPath, [tsc, ...args], { stdio: 'inherit' });
run(['-p', 'tsconfig.json', '--module', 'commonjs', '--moduleResolution', 'node10', '--outDir', 'dist/cjs']);
run(['-p', 'tsconfig.json', '--module', 'es2022', '--moduleResolution', 'bundler', '--outDir', 'dist/esm']);
mkdirSync('dist/esm', { recursive: true });
writeFileSync('dist/esm/package.json', '{ "type": "module" }\n');
writeFileSync('dist/cjs/package.json', '{ "type": "commonjs" }\n');
