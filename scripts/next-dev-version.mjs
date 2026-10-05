// The version of the next development build (see lib.mjs nextDevVersion).
//   node scripts/next-dev-version.mjs → 0.1.25-dev.3
import { existsSync, readFileSync } from 'node:fs';
import { nextDevVersion } from './lib.mjs';

const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
console.log(nextDevVersion(read('releases.json'), read('releases-dev.json')));
