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
| `arcanum-installer.json` | the installer itself, same shape as a Worker file — **not** one of the five components (`manifest.components` doesn't list it): `manifest.installer` = `{ file, commit, sha256 }`. Its logo and fonts are `data` modules (base64). The bootstrapper (arcanum.kaboutersoft.be) uploads it onto a new account; an installer uploads it over itself before updating Arcanum to this release |
| `database.json` | `schema.sql` + migrations per D1 database |
| `LICENSE`, `THIRD_PARTY_NOTICES.txt` | AGPL-3.0-or-later, and the licenses of bundled dependencies |
| `manifest.json` | version, source commit per component (and of the installer), size + sha256 of every file |

`releases.json` on this repo's `main` branch lists every release (newest
first, plus `latest`); the installer reads it instead of the GitHub API.
Releases before 0.1.1 (no `format_version`) use an older layout and aren't listed.

The env contract (`scripts/components.mjs`) says for every setting whether
it is fixed, generated per installation, shared between Workers, asked by
the installer, derived from the address, or optional. A build fails when a
component repo has a setting that isn't classified there.
The installer has its own contract there (`INSTALLER`): its index URL
(fixed), the release it comes from (`release_version`), and the secrets
whoever uploads it handles — `INSTALLER_STATE_KEY` and `BOOTSTRAP_CONFIG`
(`bootstrap`: set by the bootstrapper). Module types in a Worker file: `esm` and `text`
(UTF-8 `content`), `compiled_wasm` and `data` (`base64`).

## Making a release

First write what's new in `notes/<version>.md` — for the people running an
installation: what they get, what changes for them, anything to do when
updating. The build puts it on the release page above the source commits
(a release without one only lists the commits).

Then Actions → **Release** → Run workflow (version, component ref, pre-release),
or `gh workflow run release.yml -R arcanum-pos/arcanum-releases -f version=0.1.0`.
It runs the component and installer test suites first — a failing test means no release.

Locally: clone the five repos and arcanum-installer side by side, then
`npm ci && npm test && node scripts/build-release.mjs --version 0.1.0 --work .. --out dist`.

## License

AGPL-3.0-or-later — see [LICENSE](LICENSE).
