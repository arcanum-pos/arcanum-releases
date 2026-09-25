# arcanum-releases

Built release bundles of [Arcanum](https://github.com/arcanum-pos), for
self-hosted installations deployed by
[arcanum-installer](https://github.com/arcanum-pos/arcanum-installer). No
source code lives here — every release's `manifest.json` links the exact
commit of each component repo it was built from.

## A release contains

| File | What |
|---|---|
| `arcanum-<worker>.json` (×5) | the Worker's bundled code (exactly what `wrangler deploy` uploads) + a descriptor: bindings by logical name, Durable Object migrations, compatibility date, and its env contract |
| `arcanum-frontends-assets.json` + `-assets-NN.json` | the asset manifest (path → hash, size, content type, chunk; hashed with wrangler's own algorithm) and the contents in ~250 KB chunks — small enough for an installer on the Workers Free plan |
| `database.json` | `schema.sql` + migrations per D1 database |
| `LICENSE`, `THIRD_PARTY_NOTICES.txt` | AGPL-3.0-or-later, and the licenses of bundled dependencies |
| `manifest.json` | version, source commit per component, size + sha256 of every file |

`releases.json` on this repo's `main` branch lists every release (newest
first, plus `latest`); the installer reads it instead of the GitHub API.
Releases before 0.1.1 (no `format_version`) use an older layout and aren't listed.

The env contract (`scripts/components.mjs`) says for every setting whether
it is fixed, generated per installation, shared between Workers, asked by
the installer, derived from the address, or optional. A build fails when a
component repo has a setting that isn't classified there.

## Making a release

Actions → **Release** → Run workflow (version, component ref, pre-release),
or `gh workflow run release.yml -R arcanum-pos/arcanum-releases -f version=0.1.0`.
It runs the component test suites first — a failing test means no release.

Locally: clone the five repos side by side, then
`npm ci && npm test && node scripts/build-release.mjs --version 0.1.0 --work .. --out dist`.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).
