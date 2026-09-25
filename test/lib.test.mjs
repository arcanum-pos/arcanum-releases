import assert from 'node:assert/strict';
import { test } from 'node:test';
import blake3 from 'blake3-wasm';
import { COMPONENTS } from '../scripts/components.mjs';
import { assertVersion, bundledPackages, checkEnvContract, chunkAssets, contentTypeFor, describeWorker, devVarsKeys, hashAsset, readWranglerConfig, renderNotices } from '../scripts/lib.mjs';

const backend = COMPONENTS.find((c) => c.name === 'arcanum-backend');
const bff = COMPONENTS.find((c) => c.name === 'arcanum-bff');

const BACKEND_CONFIG = `{
  // comments are allowed
  "name": "arcanum-backend",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-11",
  "workers_dev": false,
  "vars": { "AUTH_SCHEME": "Bearer", "PUBLIC_BASE_URL": "https://arcanum.kaboutersoft.be", "CLOUDFLARE_ZONE_ID": "f689" },
  "services": [{ "binding": "ARCANUM_MAILER_SERVICE", "service": "arcanum-mailer" }],
  "d1_databases": [{ "binding": "DB", "database_name": "arcanum-backend", "database_id": "684e3e7c", "migrations_dir": "migrations" }],
  "durable_objects": { "bindings": [{ "name": "CHARGE_POLLER", "class_name": "ChargePoller" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ChargePoller"] }],
  "observability": { "enabled": true },
}`;

test('describeWorker keeps logical bindings and drops this installation\'s ids, hostnames and routes', () => {
  const config = readWranglerConfig(BACKEND_CONFIG);
  const d = describeWorker(backend, config);
  assert.deepEqual(d.bindings, [
    { type: 'd1', name: 'DB', database: 'arcanum-backend' },
    { type: 'durable_object_namespace', name: 'CHARGE_POLLER', class_name: 'ChargePoller' },
    { type: 'service', name: 'ARCANUM_MAILER_SERVICE', service: 'arcanum-mailer' },
  ]);
  assert.deepEqual(d.durable_object_migrations, [{ tag: 'v1', new_sqlite_classes: ['ChargePoller'] }]);
  const text = JSON.stringify(d);
  for (const leaked of ['684e3e7c', 'kaboutersoft', 'f689']) assert.ok(!text.includes(leaked), `leaked ${leaked}`);
  assert.equal(d.env.AUTH_SCHEME.value, 'Bearer');
  assert.equal(d.env.PUBLIC_BASE_URL.source, 'public_url');
  assert.equal(d.env.ENCRYPTION_KEY.format, 'base64-32');
  assert.ok(!('DEVICEHUB_LOCAL_URL' in d.env), 'dev-only settings are left out');
});

test('describeWorker refuses config it does not understand', () => {
  assert.throws(() => describeWorker(backend, { ...readWranglerConfig(BACKEND_CONFIG), r2_buckets: [] }), /unsupported wrangler.jsonc key/);
  assert.throws(() => describeWorker(backend, { ...readWranglerConfig(BACKEND_CONFIG), triggers: { crons: ['*/5 * * * *'] } }), /cron/);
});

test('checkEnvContract fails on an unclassified var or .dev.vars key', () => {
  const config = readWranglerConfig(BACKEND_CONFIG);
  assert.doesNotThrow(() => checkEnvContract(backend, config, ['ENCRYPTION_KEY', 'MAILER_LOCAL_URL']));
  assert.throws(() => checkEnvContract(backend, config, ['BRAND_NEW_SECRET']), /BRAND_NEW_SECRET/);
  assert.throws(() => checkEnvContract(backend, { ...config, vars: { ...config.vars, NEW_VAR: 'x' } }, []), /NEW_VAR/);
  assert.throws(() => checkEnvContract(bff, { vars: {} }, []), /SESSION_TTL is 'fixed'/);
});

test('every shared secret is declared on at least two Workers', () => {
  const holders = {};
  for (const c of COMPONENTS) for (const spec of Object.values(c.env)) if (spec.source === 'shared') (holders[spec.key] ||= []).push(c.name);
  for (const [key, names] of Object.entries(holders)) assert.ok(names.length >= 2, `${key} only on ${names}`);
});

test('the only public Worker is arcanum-bff, and service bindings point at Workers deployed before them', () => {
  assert.deepEqual(COMPONENTS.filter((c) => c.publicEntry).map((c) => c.name), ['arcanum-bff']);
});

test('devVarsKeys reads KEY=value lines only', () => {
  assert.deepEqual(devVarsKeys('# comment\nA=1\n\nB = two\nnot a key\n'), ['A', 'B']);
});

test("hashAsset matches wrangler's hash: blake3(base64 + extension), 32 hex chars", () => {
  const contents = Buffer.from('<!doctype html><title>x</title>');
  const expected = blake3.hash(contents.toString('base64') + 'html').toString('hex').slice(0, 32);
  const { hash, base64 } = hashAsset('/kassa.html', contents);
  assert.equal(hash, expected);
  assert.equal(hash.length, 32);
  assert.equal(base64, contents.toString('base64'));
  assert.notEqual(hashAsset('/kassa.txt', contents).hash, hash, 'the extension is part of the hash');
});

test('bundledPackages finds package roots (scoped too) in an esbuild metafile', () => {
  const metafile = {
    inputs: {
      'src/index.ts': {},
      'node_modules/jsonc-parser/lib/esm/main.js': {},
      'node_modules/@scope/pkg/dist/a.js': {},
      'node_modules/@scope/pkg/dist/b.js': {},
      '../node_modules/outer/index.js': {},
    },
  };
  assert.deepEqual(bundledPackages(metafile), ['../node_modules/outer', 'node_modules/@scope/pkg', 'node_modules/jsonc-parser']);
});

test('renderNotices deduplicates and names every package and license', () => {
  const text = renderNotices([
    { name: 'react', version: '19.0.0', license: 'MIT', text: 'MIT License …' },
    { name: 'react', version: '19.0.0', license: 'MIT', text: 'MIT License …' },
    { name: 'a-lib', version: '1.0.0', license: undefined, text: '' },
  ]);
  assert.match(text, /2 packages/);
  assert.match(text, /a-lib 1\.0\.0\nLicense: UNKNOWN/);
  assert.ok(text.indexOf('a-lib') < text.indexOf('react'), 'sorted by name');
});

test('assertVersion accepts semver only', () => {
  assert.doesNotThrow(() => assertVersion('0.1.0'));
  assert.doesNotThrow(() => assertVersion('1.2.3-beta.1'));
  for (const bad of ['v0.1.0', '1.2', '', undefined]) assert.throws(() => assertVersion(bad));
});

test('chunkAssets keeps chunks under the limit, stores duplicates once, gives a big file its own chunk', () => {
  const chunks = chunkAssets(
    [
      { hash: 'a', base64: 'x'.repeat(60) },
      { hash: 'b', base64: 'x'.repeat(30) },
      { hash: 'a', base64: 'x'.repeat(60) },
      { hash: 'c', base64: 'x'.repeat(30) },
      { hash: 'big', base64: 'x'.repeat(500) },
      { hash: 'd', base64: 'x'.repeat(10) },
    ],
    100
  );
  assert.deepEqual(chunks.map((c) => Object.keys(c)), [['a', 'b'], ['c'], ['big'], ['d']]);
});

test('contentTypeFor maps common web extensions', () => {
  assert.equal(contentTypeFor('/kassa.html'), 'text/html');
  assert.equal(contentTypeFor('/assets/app-x.js'), 'text/javascript');
  assert.equal(contentTypeFor('/fonts/geist.WOFF2'), 'font/woff2');
  assert.equal(contentTypeFor('/weird.bin'), 'application/octet-stream');
});

test('addToIndex keeps newest first, replaces a re-added version, and tracks latest non-pre-release', async () => {
  const { addToIndex } = await import('../scripts/lib.mjs');
  const m = (version, day) => ({ version, format_version: 1, released_at: `2026-10-${day}T00:00:00.000Z` });
  let index = addToIndex(null, m('0.1.1', '01'), true);
  assert.equal(index.latest, null);
  index = addToIndex(index, m('0.2.0', '05'), false);
  index = addToIndex(index, m('0.3.0-beta.1', '09'), true);
  assert.deepEqual(index.releases.map((r) => r.version), ['0.3.0-beta.1', '0.2.0', '0.1.1']);
  assert.equal(index.latest, '0.2.0');
  assert.equal(index.releases[1].manifest_url, 'https://github.com/arcanum-pos/arcanum-releases/releases/download/v0.2.0/manifest.json');
  index = addToIndex(index, m('0.2.0', '05'), false);
  assert.equal(index.releases.length, 3);
});
