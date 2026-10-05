// Adds a published release to releases.json (committed to main by the
// Release workflow). The installer reads this from raw.githubusercontent.com
// instead of the GitHub API, which is limited to 60 requests/hour per IP —
// and Workers share outgoing IPs.
//
//   node scripts/update-index.mjs --version 0.1.1 --prerelease true --manifest dist/manifest.json
//
// Development builds (the Development build workflow) go to their own list,
// releases-dev.json — an installer only reads it on the development channel,
// and installers from before that channel never see one:
//
//   node scripts/update-index.mjs --index releases-dev.json --keep 20 --built-from built-from.json --removed removed.txt …
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { addToIndex, pruneIndex } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const file = args.index || 'releases.json';
const index = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const manifest = JSON.parse(readFileSync(args.manifest || 'dist/manifest.json', 'utf8'));
let updated = addToIndex(index, manifest, args.prerelease === 'true');
if (args.keep) {
  const pruned = pruneIndex(updated, Number(args.keep));
  updated = pruned.index;
  if (args.removed) writeFileSync(args.removed, pruned.removed.join('\n') + (pruned.removed.length ? '\n' : ''));
}
if (args['built-from']) updated.built_from = JSON.parse(readFileSync(args['built-from'], 'utf8'));
writeFileSync(file, JSON.stringify(updated, null, 2) + '\n');
console.log(`${file}: added ${manifest.version}`);
