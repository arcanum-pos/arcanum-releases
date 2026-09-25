// Adds a published release to releases.json (committed to main by the
// Release workflow). The installer reads this from raw.githubusercontent.com
// instead of the GitHub API, which is limited to 60 requests/hour per IP —
// and Workers share outgoing IPs.
//
//   node scripts/update-index.mjs --version 0.1.1 --prerelease true --manifest dist/manifest.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { addToIndex } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const index = existsSync('releases.json') ? JSON.parse(readFileSync('releases.json', 'utf8')) : null;
const manifest = JSON.parse(readFileSync(args.manifest || 'dist/manifest.json', 'utf8'));
writeFileSync('releases.json', JSON.stringify(addToIndex(index, manifest, args.prerelease === 'true'), null, 2) + '\n');
console.log(`releases.json: added ${manifest.version}`);
