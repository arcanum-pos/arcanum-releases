// The release contract: which repos make up an Arcanum release, and — per
// Worker — what every configuration value is, so the installer knows what
// to generate, share, ask for or derive. build-release.mjs refuses to build
// when a repo has a var or .dev.vars.example key that isn't classified
// here, so a new setting can't silently go missing from self-hosted
// installations.
//
// Env value sources:
//   fixed            same value on every installation (taken from wrangler.jsonc —
//                    or from `value` when wrangler.jsonc holds the shared
//                    demo tenant's own value, which no own instance may get)
//   public_url       https://<the installation's address>
//   public_host      the installation's address, host only
//   zone_id          the Cloudflare zone of a custom-domain address (optional)
//   issuer_host      host of the login provider's issuer URL
//   generate         random secret, created once per installation (`format`)
//   shared           same generated secret on several Workers (`key`)
//   install          answered by the admin in the installer
//   optional         feature-specific, may stay unset
//   dev              local development only — never set by the installer

export const GITHUB_ORG = 'arcanum-pos';

// In deploy order: every Worker's service bindings point at Workers above it.
export const COMPONENTS = [
  {
    name: 'arcanum-mailer',
    env: {
      MAILER_INTERNAL_KEY: { kind: 'secret', source: 'shared', key: 'MAILER_INTERNAL_KEY' },
    },
  },
  {
    name: 'arcanum-devicehub',
    database: { name: 'arcanum-devices', schema: 'schema.sql' },
    env: {
      WS_TOKEN_SECRET: { kind: 'secret', source: 'generate', format: 'hex32' },
      INTERNAL_API_KEY: { kind: 'secret', source: 'shared', key: 'INTERNAL_API_KEY' },
    },
  },
  {
    name: 'arcanum-frontends',
    build: ['npm', 'run', 'build'],
    env: {},
  },
  {
    name: 'arcanum-backend',
    database: { name: 'arcanum-backend', schema: 'schema.sql', migrations: 'migrations' },
    env: {
      AUTH_SCHEME: { kind: 'var', source: 'fixed' },
      PUBLIC_BASE_URL: { kind: 'var', source: 'public_url' },
      CLOUDFLARE_ZONE_ID: { kind: 'var', source: 'optional', note: 'custom domains per org' },
      // base64 of 32 bytes — never hex (see CLAUDE.md); must never change after install.
      ENCRYPTION_KEY: { kind: 'secret', source: 'generate', format: 'base64-32' },
      INTERNAL_API_KEY: { kind: 'secret', source: 'shared', key: 'INTERNAL_API_KEY' },
      BFF_INTERNAL_KEY: { kind: 'secret', source: 'shared', key: 'BFF_INTERNAL_KEY' },
      MAILER_INTERNAL_KEY: { kind: 'secret', source: 'shared', key: 'MAILER_INTERNAL_KEY' },
      DEFAULT_IDP_ISSUER_URL: { kind: 'secret', source: 'install', question: 'login.issuer' },
      DEFAULT_IDP_CLIENT_ID: { kind: 'secret', source: 'install', question: 'login.clientId' },
      DEFAULT_IDP_CLIENT_SECRET: { kind: 'secret', source: 'install', question: 'login.clientSecret' },
      DEFAULT_IDP_CONNECTION_NAME: { kind: 'secret', source: 'optional', note: 'Auth0 only' },
      // Google: no offline_access, and a separate Web-application client for browser login.
      DEFAULT_IDP_SCOPES: { kind: 'secret', source: 'optional', note: 'e.g. "openid profile email" for Google' },
      DEFAULT_IDP_AUTH_CODE_CLIENT_ID: { kind: 'secret', source: 'optional', note: 'separate browser-login client (Google)' },
      DEFAULT_IDP_AUTH_CODE_CLIENT_SECRET: { kind: 'secret', source: 'optional', note: 'separate browser-login client (Google)' },
      INSTANCE_ADMIN_EMAILS: { kind: 'secret', source: 'install', question: 'admins' },
      // An own instance: its first org only (wrangler.jsonc says "internal" — the demo instance).
      ORG_CREATION: { kind: 'var', source: 'fixed', value: 'single' },
      // The demo instance's demo orgs — never on an own instance.
      DEMO_LIFETIME_HOURS: { kind: 'var', source: 'optional', note: 'demo instance only' },
      DEMO_MAX_LIVE: { kind: 'var', source: 'optional', note: 'demo instance only' },
      DEMO_INSTALL_URL: { kind: 'var', source: 'optional', note: 'demo instance only' },
      BOOTSTRAP_API_KEY: { kind: 'secret', source: 'optional', note: 'demo instance only (the bootstrapper)' },
      DEFAULT_SMTP_HOST: { kind: 'secret', source: 'optional', note: 'mail is configured per org in the portal' },
      DEFAULT_SMTP_PORT: { kind: 'secret', source: 'optional' },
      DEFAULT_SMTP_USER: { kind: 'secret', source: 'optional' },
      DEFAULT_SMTP_PASS: { kind: 'secret', source: 'optional' },
      DEFAULT_SMTP_FROM_ADDRESS: { kind: 'secret', source: 'optional' },
      DEFAULT_SMTP_FROM_NAME: { kind: 'secret', source: 'optional' },
      CLOUDFLARE_API_TOKEN: { kind: 'secret', source: 'optional', note: 'custom domains per org' },
      DEVICEHUB_LOCAL_URL: { kind: 'var', source: 'dev' },
      MAILER_LOCAL_URL: { kind: 'var', source: 'dev' },
    },
  },
  {
    name: 'arcanum-bff',
    // The one public Worker: the installation's address points here.
    publicEntry: true,
    env: {
      SESSION_TTL: { kind: 'var', source: 'fixed' },
      FRONTEND_URL: { kind: 'var', source: 'public_url' },
      AUTH0_DOMAIN: { kind: 'var', source: 'issuer_host', note: 'legacy Bearer-token path only' },
      BFF_INTERNAL_KEY: { kind: 'secret', source: 'shared', key: 'BFF_INTERNAL_KEY' },
      SOURCE_URL: { kind: 'var', source: 'optional', note: 'AGPL "Broncode" link; unset = upstream repos' },
      ARCANUM_VERSION: { kind: 'var', source: 'optional', note: 'the installed release, shown in the console footer; set by the installer' },
      COOKIE_DOMAIN: { kind: 'var', source: 'optional' },
      ALLOWED_ORIGINS: { kind: 'var', source: 'optional' },
      GIT_COMMIT_SHA: { kind: 'var', source: 'optional', note: 'the installer can set it from the manifest' },
      // Set by the installer (with an ARCANUM_INSTALLER_SERVICE binding) when it moves behind Arcanum.
      INSTALLER_INTERNAL_KEY: { kind: 'secret', source: 'optional', note: 'installer behind /installer' },
      BANCONTACT_LOCAL_URL: { kind: 'var', source: 'dev' },
      DEVICEHUB_LOCAL_URL: { kind: 'var', source: 'dev' },
      CONSOLE_LOCAL_URL: { kind: 'var', source: 'dev' },
    },
  },
];

// The installer itself — part of every release, but NOT one of the
// components above: it installs them. Uploaded onto a new account by the
// bootstrapper (start.kaboutersoft.be), and by an installer over itself
// before it updates Arcanum (HOSTING_PLAN.md, decision 4). Its own sources:
//   bootstrap        a secret the bootstrapper sets (the handoff; the state key)
//   keep             an existing secret of the running installer, re-sent unchanged
//   release_version  the version of the release it comes from
export const INSTALLER = {
  name: 'arcanum-installer',
  env: {
    RELEASES_INDEX_URL: { kind: 'var', source: 'fixed' },
    INSTALLER_RELEASE: { kind: 'var', source: 'release_version' },
    // Installers made with the Deploy button: the setup page's password.
    INSTALLER_PASSWORD: { kind: 'secret', source: 'keep', note: 'Deploy-button installers only' },
    // Bootstrapped installers: the root of the key sealing its state — set
    // once, must never change (it seals ENCRYPTION_KEY).
    INSTALLER_STATE_KEY: { kind: 'secret', source: 'bootstrap', note: 'set once by the bootstrapper, never changed' },
    // The handoff from the bootstrapper (see arcanum-installer's README).
    BOOTSTRAP_CONFIG: { kind: 'secret', source: 'bootstrap', note: 'the bootstrapper hands over token, login client and owner' },
    CLOUDFLARE_API_BASE: { kind: 'var', source: 'dev' },
  },
};
