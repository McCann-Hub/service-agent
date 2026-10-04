// Packs the package, installs the tarball into a throwaway project, and checks
// what CommonJS and ESM consumers get from it: at runtime through require() and
// import, and at compile time through tsc under node16, nodenext, and bundler.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { name } = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
const tscPath = join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');

// require() keeps the function on .default, so CommonJS callers see no change
const requireCheck = `
const { default: serviceAgent, DEFAULT_REDACT_FIELDS } = require('${name}');
if (typeof serviceAgent !== 'function') throw new Error('require: default export is ' + typeof serviceAgent);
if (typeof serviceAgent()({}).get !== 'function') throw new Error('require: no axios client');
if (!DEFAULT_REDACT_FIELDS?.includes('password')) throw new Error('require: DEFAULT_REDACT_FIELDS missing');
`;
const importCheck = `
const { default: serviceAgent, DEFAULT_REDACT_FIELDS } = await import('${name}');
if (typeof serviceAgent !== 'function') throw new Error('import: default export is ' + typeof serviceAgent);
if (typeof serviceAgent()({}).get !== 'function') throw new Error('import: no axios client');
if (!DEFAULT_REDACT_FIELDS?.includes('password')) throw new Error('import: DEFAULT_REDACT_FIELDS missing');
`;
const typeFixture = `
import serviceAgent, { DEFAULT_REDACT_FIELDS } from '${name}';
const client = serviceAgent({ redactFields: [...DEFAULT_REDACT_FIELDS, 'ssn'] })({});
void client.get;
`;
// [config name, fixture file, module, moduleResolution, declaration tsc must pick]
const typeChecks = [
  ['node16', 'node16.cts', 'Node16', 'Node16', 'dist/cjs/index.d.ts'],
  ['nodenext', 'nodenext.mts', 'NodeNext', 'NodeNext', 'dist/esm/index.d.ts'],
  ['bundler', 'bundler.ts', 'ESNext', 'Bundler', 'dist/esm/index.d.ts'],
];

const temporaryRoot = await mkdtemp(join(tmpdir(), 'check-package-'));
const run = (command, args, cwd, capture = false) => execFileSync(command, args, {
  cwd,
  encoding: capture ? 'utf8' : undefined,
  stdio: capture ? 'pipe' : 'inherit',
});

try {
  let tarballPath = process.argv[2] ? resolve(process.argv[2]) : null;
  if (!tarballPath) {
    const packDirectory = join(temporaryRoot, 'package');
    await mkdir(packDirectory);
    run('npm', ['pack', '--pack-destination', packDirectory], projectRoot);
    const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'));
    if (tarballs.length !== 1) throw new Error(`Expected one tarball, found ${tarballs.length}.`);
    tarballPath = join(packDirectory, tarballs[0]);
  }

  const consumerRoot = join(temporaryRoot, 'consumer');
  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({ private: true }, null, 2));
  // A Node consumer has @types/node, and dependencies' types (winston's) need it
  run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarballPath,
    '@types/node',
  ], consumerRoot);

  run(process.execPath, ['--input-type=commonjs', '--eval', requireCheck], consumerRoot);
  run(process.execPath, ['--input-type=module', '--eval', importCheck], consumerRoot);

  for (const [config, source, module, moduleResolution, expected] of typeChecks) {
    await writeFile(join(consumerRoot, source), typeFixture);
    const configPath = join(consumerRoot, `tsconfig.${config}.json`);
    await writeFile(configPath, JSON.stringify({
      compilerOptions: { target: 'ES2022', module, moduleResolution, strict: true, noEmit: true },
      files: [source],
    }, null, 2));
    run(process.execPath, [tscPath, '-p', configPath], consumerRoot);
    const trace = run(process.execPath, [tscPath, '-p', configPath, '--traceResolution'], consumerRoot, true);
    const resolved = trace.match(new RegExp(`Module name '${name}' was successfully resolved to '([^']+)'`));
    if (!resolved?.[1].endsWith(`/${expected}`)) {
      throw new Error(`${config} resolved ${resolved?.[1] ?? 'nothing'}, expected ${expected}.`);
    }
  }

  console.log(`${name}: require, import, and types verified for node16, nodenext, and bundler`);
} finally {
  if (process.env.KEEP_PACKAGE_TEST_TEMP) {
    console.log(`Package test files kept at ${temporaryRoot}`);
  } else {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
