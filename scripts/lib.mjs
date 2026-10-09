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
    if (spec.source === 'fixed' && !('value' in spec) && !(config.vars && name in config.vars)) {
      throw new Error(`${component.name}: ${name} is 'fixed' but has no value in wrangler.jsonc vars`);
    }
  }
}

// What the installer needs to upload this Worker on a fresh account: the
// bindings by logical name (never this installation's ids, routes or
// hostnames), Durable Object migrations, and the env contract with only the
// 'fixed' values filled in (a component's own `value` wins over wrangler.jsonc's).
export function describeWorker(component, config) {
  const bindings = [];
  for (const d of config.d1_databases || []) bindings.push({ type: 'd1', name: d.binding, database: d.database_name });
  for (const k of config.kv_namespaces || []) bindings.push({ type: 'kv_namespace', name: k.binding, namespace: `${component.name}:${k.binding}` });
  for (const d of config.durable_objects?.bindings || []) bindings.push({ type: 'durable_object_namespace', name: d.name, class_name: d.class_name });
  for (const s of config.services || []) bindings.push({ type: 'service', name: s.binding, service: s.service });
  for (const r of config.ratelimits || []) bindings.push({ type: 'ratelimit', name: r.name, simple: r.simple });
  if (config.assets?.binding) bindings.push({ type: 'assets', name: config.assets.binding });
  if (config.version_metadata?.binding) bindings.push({ type: 'version_metadata', name: config.version_metadata.binding });
  // Cloudflare Email Service (arcanum-mailer, MAIL.md phase 5): unrestricted
  // only — no destination/sender allow-lists to carry over.
  for (const e of config.send_email || []) {
    if (e.destination_address || e.allowed_destination_addresses || e.allowed_sender_addresses) throw new Error(`${component.name}: send_email restrictions aren't supported by the installer`);
    bindings.push({ type: 'send_email', name: e.name });
  }

  const known = new Set([
    '$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'dev', 'vars', 'routes', 'route',
    'd1_databases', 'kv_namespaces', 'durable_objects', 'migrations', 'services', 'ratelimits', 'assets', 'version_metadata', 'send_email',
    'observability', 'upload_source_maps', 'triggers', 'preview_urls',
    // Module rules only shape the bundle (which files become which module
    // type) — the bundle's modules carry their type, see moduleType.
    'rules',
  ]);
  const unsupported = Object.keys(config).filter((k) => !known.has(k));
  if (unsupported.length) throw new Error(`${component.name}: unsupported wrangler.jsonc key(s) ${unsupported.join(', ')}`);
  if (config.triggers?.crons?.length) throw new Error(`${component.name}: cron triggers aren't supported by the installer yet`);

  const env = Object.fromEntries(
    Object.entries(component.env)
      .filter(([, spec]) => spec.source !== 'dev')
      .map(([name, spec]) => [name, spec.source === 'fixed' ? { ...spec, value: 'value' in spec ? spec.value : config.vars[name] } : spec])
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

// A bundled module's type, as the installer uploads it: `esm` and `text`
// as UTF-8, `compiled_wasm` and `data` (a wrangler "Data" rule — e.g. the
// installer's logo and fonts, imported as ArrayBuffer) as base64.
export function moduleType(name, rules = []) {
  if (name.endsWith('.wasm')) return 'compiled_wasm';
  if (name.endsWith('.js') || name.endsWith('.mjs')) return 'esm';
  const rule = rules.find((r) => (r.globs || []).some((g) => globMatches(g, name)));
  return rule?.type === 'Data' ? 'data' : 'text';
}

// The globs wrangler rules use here ("**/*.png"): ** = any directories, * = any name part.
function globMatches(glob, name) {
  const pattern = glob
    .split('**/')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('(?:.*/)?');
  return new RegExp(`^${pattern}$`).test(name);
}

// A module of the bundle as stored in a release file.
export function bundledModule(name, content, rules = []) {
  const type = moduleType(name, rules);
  const binary = type === 'compiled_wasm' || type === 'data';
  return { name, type, ...(binary ? { base64: Buffer.from(content).toString('base64') } : { content: Buffer.from(content).toString('utf8') }) };
}

// manifest.installer — the installer as a release artifact, next to (not
// one of) the five components: what the bootstrapper uploads onto a new
// account, and what an installer uploads over itself before an update.
export function installerEntry(file, commit, content) {
  return { file, commit, sha256: sha256(content) };
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

// The release page's text (NOTES.md): the hand-written notes for this
// version (notes/<version>.md — what changed, for the people running it),
// if there are any, above the list of source commits it was built from.
export function renderNotes(version, components, notes = null) {
  const builtFrom = Object.entries(components)
    .map(([name, c]) => `- [${name}](${c.source}) \`${c.commit.slice(0, 7)}\``)
    .join('\n');
  const body = notes && notes.trim() ? `${notes.trim()}\n\n## Built from\n\n` : 'Built from:\n\n';
  return `Arcanum ${version}\n\n${body}${builtFrom}\n\nLicense: AGPL-3.0-or-later. Deploy with arcanum-installer; see manifest.json for checksums.\n`;
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error(`version must look like 1.2.3 or 1.2.3-beta.1, got "${version}"`);
}

export const ASSET_CHUNK_BYTES = 250_000;

// Groups { hash, base64 } into chunks of at most `limit` base64 bytes (a
// larger single file gets a chunk of its own). Duplicate hashes are stored once.
export function chunkAssets(contents, limit) {
  const chunks = [];
  let current = {};
  let size = 0;
  for (const { hash, base64 } of contents) {
    if (chunks.some((c) => hash in c) || hash in current) continue;
    if (size > 0 && size + base64.length > limit) {
      chunks.push(current);
      current = {};
      size = 0;
    }
    current[hash] = base64;
    size += base64.length;
  }
  if (size > 0) chunks.push(current);
  return chunks;
}

const CONTENT_TYPES = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', txt: 'text/plain',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', map: 'application/json', webmanifest: 'application/manifest+json',
  wasm: 'application/wasm', xml: 'application/xml', pdf: 'application/pdf',
};

export function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).substring(1).toLowerCase()] || 'application/octet-stream';
}

const REPO_URL = 'https://github.com/arcanum-pos/arcanum-releases';

// releases.json: every published release, newest first; `latest` = newest non-pre-release.
// "0.1.24" < "0.1.25-dev.1" < "0.1.25-dev.2" < "0.1.25": numeric parts,
// then a release above its own pre-releases, then the pre-release parts
// (numbers numerically). The installer compares the same way.
export function compareVersions(a, b) {
  const [ca, pa] = [a.split('-')[0], a.split('-').slice(1).join('-')];
  const [cb, pb] = [b.split('-')[0], b.split('-').slice(1).join('-')];
  const x = ca.split('.').map(Number);
  const y = cb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1;
  const xs = pa.split('.');
  const ys = pb.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(xs[i]), /^\d+$/.test(ys[i])];
    if (xs[i] !== ys[i]) return nx && ny ? (Number(xs[i]) < Number(ys[i]) ? -1 : 1) : xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

// The next development build: the patch after the highest release, then
// -dev.N counting up — "0.1.24" released → "0.1.25-dev.1", "0.1.25-dev.2" …
export function nextDevVersion(stableIndex, devIndex) {
  const highest = (stableIndex?.releases || []).map((r) => r.version).sort(compareVersions).pop() || '0.0.0';
  const [maj, min, patch] = highest.split('-')[0].split('.').map(Number);
  const base = `${maj}.${min}.${patch + 1}`;
  const n = Math.max(0, ...(devIndex?.releases || []).map((r) => r.version.match(new RegExp(`^${base.replace(/\./g, '\\.')}-dev\\.(\\d+)$`))?.[1]).filter(Boolean).map(Number));
  return `${base}-dev.${n + 1}`;
}

// Development builds: only the newest `keep` stay listed (the workflow
// deletes the GitHub releases of the ones dropped). `builtFrom`: the
// component commits of the newest build — nothing new, no build.
export function pruneIndex(index, keep) {
  const releases = [...index.releases].sort((a, b) => compareVersions(b.version, a.version));
  return { index: { ...index, releases: releases.slice(0, keep) }, removed: releases.slice(keep).map((r) => r.version) };
}

export function addToIndex(index, manifest, prerelease) {
  const releases = (index?.releases || []).filter((r) => r.version !== manifest.version);
  releases.unshift({
    version: manifest.version,
    tag: `v${manifest.version}`,
    prerelease,
    released_at: manifest.released_at,
    format_version: manifest.format_version,
    manifest_url: `${REPO_URL}/releases/download/v${manifest.version}/manifest.json`,
    notes_url: `${REPO_URL}/releases/tag/v${manifest.version}`,
  });
  releases.sort((a, b) => (a.released_at < b.released_at ? 1 : -1));
  return { format: 'arcanum-releases-index', latest: releases.find((r) => !r.prerelease)?.version ?? null, releases };
}
