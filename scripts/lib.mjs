// Pure helpers for build-release.mjs — no child processes, no network, so
// they're unit-tested in test/lib.test.mjs.
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import blake3 from 'blake3-wasm';

export function readWranglerConfig(text) {
  const errors = [];
  const config = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`wrangler.jsonc: ${errors.length} parse error(s)`);
  return config;
}

// KEY=value lines of a .dev.vars.example (comments and blanks ignored).
export function devVarsKeys(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim());
}

// Every var in wrangler.jsonc and every key in .dev.vars.example must be
// classified in components.mjs — a new setting fails the build instead of
// silently missing from self-hosted installations.
export function checkEnvContract(component, config, devKeys) {
  const unknown = [...Object.keys(config.vars || {}), ...devKeys].filter((k) => !component.env[k]);
  if (unknown.length) {
    throw new Error(`${component.name}: unclassified setting(s) ${[...new Set(unknown)].join(', ')} — add them to scripts/components.mjs`);
  }
  for (const [name, spec] of Object.entries(component.env)) {
    if (spec.source === 'fixed' && !(config.vars && name in config.vars)) {
      throw new Error(`${component.name}: ${name} is 'fixed' but has no value in wrangler.jsonc vars`);
    }
  }
}

// What the installer needs to upload this Worker on a fresh account: the
// bindings by logical name (never this installation's ids, routes or
// hostnames), Durable Object migrations, and the env contract with only the
// 'fixed' values filled in.
export function describeWorker(component, config) {
  const bindings = [];
  for (const d of config.d1_databases || []) bindings.push({ type: 'd1', name: d.binding, database: d.database_name });
  for (const k of config.kv_namespaces || []) bindings.push({ type: 'kv_namespace', name: k.binding, namespace: `${component.name}:${k.binding}` });
  for (const d of config.durable_objects?.bindings || []) bindings.push({ type: 'durable_object_namespace', name: d.name, class_name: d.class_name });
  for (const s of config.services || []) bindings.push({ type: 'service', name: s.binding, service: s.service });
  for (const r of config.ratelimits || []) bindings.push({ type: 'ratelimit', name: r.name, simple: r.simple });
  if (config.assets?.binding) bindings.push({ type: 'assets', name: config.assets.binding });
  if (config.version_metadata?.binding) bindings.push({ type: 'version_metadata', name: config.version_metadata.binding });

  const known = new Set([
    '$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'dev', 'vars', 'routes', 'route',
    'd1_databases', 'kv_namespaces', 'durable_objects', 'migrations', 'services', 'ratelimits', 'assets', 'version_metadata',
    'observability', 'upload_source_maps', 'triggers', 'preview_urls',
  ]);
  const unsupported = Object.keys(config).filter((k) => !known.has(k));
  if (unsupported.length) throw new Error(`${component.name}: unsupported wrangler.jsonc key(s) ${unsupported.join(', ')}`);
  if (config.triggers?.crons?.length) throw new Error(`${component.name}: cron triggers aren't supported by the installer yet`);

  const env = Object.fromEntries(
    Object.entries(component.env)
      .filter(([, spec]) => spec.source !== 'dev')
      .map(([name, spec]) => [name, spec.source === 'fixed' ? { ...spec, value: config.vars[name] } : spec])
  );

  return {
    name: component.name,
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags || [],
    public_entry: !!component.publicEntry,
    observability: config.observability || null,
    bindings,
    durable_object_migrations: config.migrations || [],
    assets: config.assets ? { config: omit(config.assets, ['directory', 'binding']) } : null,
    env,
  };
}

function omit(obj, keys) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

// Exactly wrangler's own asset hash (deploy-helpers/src/deploy/helpers/hash.ts):
// blake3 of the base64 contents + the extension, first 32 hex characters.
export function hashAsset(path, contents) {
  const base64 = Buffer.from(contents).toString('base64');
  return { hash: blake3.hash(base64 + extname(path).substring(1)).toString('hex').slice(0, 32), base64 };
}

// Package roots of every node_modules file esbuild put into a bundle
// (from wrangler's --metafile), e.g. "node_modules/@scope/pkg".
export function bundledPackages(metafile) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs || {})) {
    const at = input.lastIndexOf('node_modules/');
    if (at === -1) continue;
    const rest = input.slice(at + 'node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    roots.add(`${input.slice(0, at)}node_modules/${name}`);
  }
  return [...roots].sort();
}

// THIRD_PARTY_NOTICES.txt from { name, version, license, text } entries, deduplicated.
export function renderNotices(packages) {
  const unique = new Map();
  for (const p of packages) unique.set(`${p.name}@${p.version}`, p);
  const sorted = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  const header = `Third-party software included in Arcanum release bundles.\nArcanum itself is licensed AGPL-3.0-or-later (see LICENSE).\n${sorted.length} packages.\n`;
  return (
    header +
    sorted
      .map((p) => `\n${'='.repeat(72)}\n${p.name} ${p.version}\nLicense: ${p.license || 'UNKNOWN'}\n${'-'.repeat(72)}\n${(p.text || '(no license file in the package)').trim()}\n`)
      .join('')
  );
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error(`version must look like 1.2.3 or 1.2.3-beta.1, got "${version}"`);
}
