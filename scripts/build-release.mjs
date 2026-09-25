// Builds an Arcanum release from checked-out component repos:
//
//   node scripts/build-release.mjs --version 0.1.0 --work <dir with the 5 repos> --out dist
//
// Output (one file per concern, all JSON except the texts, so the installer
// Worker can read them without unpacking archives):
//   arcanum-<worker>.json          descriptor (bindings, DO migrations, env contract) + bundled modules
//   arcanum-frontends-assets.json  asset manifest (path → hash, size, content type, chunk), hashed like wrangler
//   arcanum-frontends-assets-NN.json  the asset contents (hash → base64), ~250 KB per chunk
//   database.json                  schema.sql + migrations per D1 database
//   LICENSE, THIRD_PARTY_NOTICES.txt, NOTES.md
//   manifest.json                  version, source commit per component, sha256 of every file
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { COMPONENTS, GITHUB_ORG } from './components.mjs';
import { ASSET_CHUNK_BYTES, assertVersion, bundledPackages, checkEnvContract, chunkAssets, contentTypeFor, describeWorker, devVarsKeys, hashAsset, readWranglerConfig, renderNotices, sha256 } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
assertVersion(args.version);
const work = args.work || 'work';
const out = args.out || 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } }).toString();

// format_version: the layout of a release (bumped when files change shape;
// the installer refuses layouts it doesn't know). 1 = chunked assets.
const manifest = { format: 'arcanum-release', format_version: 1, version: args.version, released_at: new Date().toISOString(), license: 'AGPL-3.0-or-later', components: {}, files: {} };
const notices = [];
const databases = [];

function readPackage(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  return { name: pkg.name, version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type, text: licenseFile ? readFileSync(join(dir, licenseFile), 'utf8') : '' };
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

for (const component of COMPONENTS) {
  const repo = join(work, component.name);
  const config = readWranglerConfig(readFileSync(join(repo, 'wrangler.jsonc'), 'utf8'));
  const devKeys = existsSync(join(repo, '.dev.vars.example')) ? devVarsKeys(readFileSync(join(repo, '.dev.vars.example'), 'utf8')) : [];
  checkEnvContract(component, config, devKeys);
  const descriptor = describeWorker(component, config);
  const commit = run('git', ['rev-parse', 'HEAD'], repo).trim();
  manifest.components[component.name] = { repo: `https://github.com/${GITHUB_ORG}/${component.name}`, commit, source: `https://github.com/${GITHUB_ORG}/${component.name}/tree/${commit}` };

  if (component.build) run(component.build[0], component.build.slice(1), repo);

  // The exact bundle `wrangler deploy` would upload.
  const bundleDir = mkdtempSync(join(tmpdir(), `${component.name}-`));
  run('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', bundleDir, '--metafile', join(bundleDir, 'bundle-meta.json')], repo);
  const metafile = JSON.parse(readFileSync(join(bundleDir, 'bundle-meta.json'), 'utf8'));
  const entry = Object.entries(metafile.outputs).find(([, o]) => o.entryPoint);
  const modules = filesUnder(bundleDir)
    // Not modules: source maps, the metafile, and the README.md wrangler writes into --outdir.
    .filter((f) => !f.endsWith('.map') && !f.endsWith('bundle-meta.json') && relative(bundleDir, f) !== 'README.md')
    .map((f) => {
      const name = relative(bundleDir, f);
      const type = name.endsWith('.wasm') ? 'compiled_wasm' : name.endsWith('.js') || name.endsWith('.mjs') ? 'esm' : 'text';
      const content = readFileSync(f);
      return { name, type, ...(type === 'compiled_wasm' ? { base64: content.toString('base64') } : { content: content.toString('utf8') }) };
    });
  descriptor.main_module = relative(bundleDir, join(bundleDir, entry[0].split('/').pop()));
  if (!modules.some((m) => m.name === descriptor.main_module)) throw new Error(`${component.name}: main module ${descriptor.main_module} not in the bundle`);
  for (const root of bundledPackages(metafile)) {
    const dir = join(repo, root.replace(/^(\.\.\/)+/, ''));
    if (existsSync(join(dir, 'package.json'))) notices.push(readPackage(dir));
  }
  rmSync(bundleDir, { recursive: true, force: true });
  writeFileSync(join(out, `${component.name}.json`), JSON.stringify({ ...descriptor, modules }));

  if (config.assets?.directory) {
    // A manifest without content + content in chunks of ~250 KB: the
    // installer runs on the Workers Free plan (~10 ms CPU, 50 subrequests
    // per request), so it must never parse all assets in one request.
    const dir = join(repo, config.assets.directory);
    const files = {};
    const contents = [];
    for (const f of filesUnder(dir).sort()) {
      const path = '/' + relative(dir, f).split('\\').join('/');
      if (path === '/.assetsignore') continue;
      const { hash, base64 } = hashAsset(path, readFileSync(f));
      files[path] = { hash, size: statSync(f).size, contentType: contentTypeFor(path) };
      contents.push({ hash, base64 });
    }
    const chunks = chunkAssets(contents, ASSET_CHUNK_BYTES);
    chunks.forEach((chunk, i) => {
      const name = `${component.name}-assets-${String(i + 1).padStart(2, '0')}.json`;
      writeFileSync(join(out, name), JSON.stringify(chunk));
      for (const hash of Object.keys(chunk)) for (const f of Object.values(files)) if (f.hash === hash) f.chunk = name;
    });
    writeFileSync(join(out, `${component.name}-assets.json`), JSON.stringify({ config: descriptor.assets.config, files }));
    // Frontend dependencies ship inside the assets, not the Worker bundle.
    const paths = run('npm', ['ls', '--omit=dev', '--all', '--parseable'], repo).split('\n').filter(Boolean).slice(1);
    for (const p of paths) if (existsSync(join(p, 'package.json'))) notices.push(readPackage(p));
  }

  if (component.database) {
    const db = component.database;
    const migrations = db.migrations
      ? readdirSync(join(repo, db.migrations))
          .filter((f) => f.endsWith('.sql'))
          .sort()
          .map((name) => ({ name, sql: readFileSync(join(repo, db.migrations, name), 'utf8') }))
      : [];
    databases.push({ name: db.name, component: component.name, schema: readFileSync(join(repo, db.schema), 'utf8'), migrations, tracked: !!db.migrations });
  }
  console.log(`built ${component.name} @ ${commit.slice(0, 7)}`);
}

writeFileSync(join(out, 'database.json'), JSON.stringify({ databases }));
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), renderNotices(notices));
writeFileSync(join(out, 'LICENSE'), readFileSync(join(work, 'arcanum-backend', 'LICENSE')));
writeFileSync(
  join(out, 'NOTES.md'),
  `Arcanum ${args.version}\n\nBuilt from:\n\n${Object.entries(manifest.components)
    .map(([name, c]) => `- [${name}](${c.source}) \`${c.commit.slice(0, 7)}\``)
    .join('\n')}\n\nLicense: AGPL-3.0-or-later. Deploy with arcanum-installer; see manifest.json for checksums.\n`
);

for (const file of readdirSync(out).sort()) {
  const content = readFileSync(join(out, file));
  manifest.files[file] = { size: content.length, sha256: sha256(content) };
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`release ${args.version}: ${Object.keys(manifest.files).length + 1} files in ${out}`);
