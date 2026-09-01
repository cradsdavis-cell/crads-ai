// wizard/panel/mcp-catalogue.mjs: the curated tier of the connections directory.
//
// Spec: docs/superpowers/specs/2026-08-09-connections-directory-design.md.
// The official registry has ~1,350 remote servers but no ranking and no
// categories, so this list IS the definition of "worth showing unprompted":
// every entry is a service a member would recognise, with a remote MCP endpoint
// we believe completes a zero-secret sign-in (DCR) or works with an API token.
// Growing the directory is editing this file; it ships inside the app bundle
// (esbuild inlines it), so a catalogue change is an app build, nothing more.
//
// boxKey: set ONLY for entries the box itself carries as FEATURED, byte-for-byte
// (mcp-catalogue.test.mjs enforces both directions). Those connect via the
// box's `add <key>`; everything else via `add-custom`.
//
// auth: 'oauth' | 'token', the sign-in kind, verified live against each
// endpoint's own discover() answer (2026-08-09). 'oauth' means dynamic client
// registration completes and the member gets a one-click sign-in; 'token'
// means the endpoint is reachable but advertises no DCR, so the member pastes
// an API token instead (the by-URL form's token field). This field is a filter
// hint for the page (see member.html's sign-in-kind pills); the probe at
// connect time remains the source of truth for which control actually shows.

export const CATEGORIES = ['Design', 'Dev', 'Docs', 'Comms', 'Data', 'Meetings', 'Payments', 'Web', 'AI'];

export const CATALOGUE = [
  // the six the box carries as FEATURED
  { key: 'notion',   boxKey: 'notion',  label: 'Notion',   category: 'Docs',     url: 'https://mcp.notion.com/mcp',   blurb: 'read and update your pages and databases', auth: 'oauth' },
  { key: 'linear',   boxKey: 'linear',  label: 'Linear',   category: 'Dev',      url: 'https://mcp.linear.app/sse',   blurb: 'see and file issues', auth: 'oauth' },
  { key: 'sentry',   boxKey: 'sentry',  label: 'Sentry',   category: 'Dev',      url: 'https://mcp.sentry.dev/mcp',   blurb: 'read errors from your apps', auth: 'oauth' },
  { key: 'canva',    boxKey: 'canva',   label: 'Canva',    category: 'Design',   url: 'https://mcp.canva.com/mcp',    blurb: 'work with your designs', auth: 'oauth' },
  { key: 'vercel',   boxKey: 'vercel',  label: 'Vercel',   category: 'Dev',      url: 'https://mcp.vercel.com',       blurb: 'see your deployments', auth: 'oauth' },
  { key: 'apify',    boxKey: 'apify',   label: 'Apify',    category: 'Data',     url: 'https://mcp.apify.com',        blurb: 'run scrapers and read results', auth: 'oauth' },
  // the wider curated tier (verified during Task 1 Step 5; entries that fail the
  // probe are REMOVED there, not shipped hopeful)
  { key: 'paypal',    label: 'PayPal',       category: 'Payments', url: 'https://mcp.paypal.com/mcp',          blurb: 'orders, payments and disputes', auth: 'oauth' },
  { key: 'square',    label: 'Square',       category: 'Payments', url: 'https://mcp.squareup.com/sse',        blurb: 'payments and point of sale', auth: 'oauth' },
  { key: 'figma',     label: 'Figma',        category: 'Design',   url: 'https://mcp.figma.com/mcp',           blurb: 'read your design files', auth: 'oauth' },
  { key: 'asana',     label: 'Asana',        category: 'Docs',     url: 'https://mcp.asana.com/sse',           blurb: 'tasks and projects', auth: 'oauth' },
  { key: 'atlassian', label: 'Atlassian',    category: 'Dev',      url: 'https://mcp.atlassian.com/v1/sse',    blurb: 'Jira issues and Confluence pages', auth: 'oauth' },
  { key: 'intercom',  label: 'Intercom',     category: 'Comms',    url: 'https://mcp.intercom.com/mcp',        blurb: 'conversations and customers', auth: 'oauth' },
  { key: 'webflow',   label: 'Webflow',      category: 'Web',      url: 'https://mcp.webflow.com/sse',         blurb: 'sites, collections and content', auth: 'oauth' },
  { key: 'wix',       label: 'Wix',          category: 'Web',      url: 'https://mcp.wix.com/sse',             blurb: 'manage your Wix site', auth: 'oauth' },
  { key: 'netlify',   label: 'Netlify',      category: 'Web',      url: 'https://netlify-mcp.netlify.app/mcp', blurb: 'deploys and site config', auth: 'oauth' },
  { key: 'neon',      label: 'Neon',         category: 'Data',     url: 'https://mcp.neon.tech/sse',           blurb: 'Postgres branches and queries', auth: 'oauth' },
  { key: 'huggingface', label: 'Hugging Face', category: 'AI',     url: 'https://huggingface.co/mcp',          blurb: 'models, datasets and Spaces', auth: 'oauth' },
  { key: 'context7',  label: 'Context7',     category: 'AI',       url: 'https://mcp.context7.com/mcp',        blurb: 'up-to-date library documentation', auth: 'oauth' },
  { key: 'semgrep',   label: 'Semgrep',      category: 'Dev',      url: 'https://mcp.semgrep.ai/sse',          blurb: 'scan code for security issues', auth: 'oauth' },
  { key: 'globalping', label: 'Globalping',  category: 'Web',      url: 'https://mcp.globalping.dev/sse',      blurb: 'network tests from anywhere', auth: 'oauth' },
  { key: 'todoist',   label: 'Todoist',      category: 'Docs',     url: 'https://ai.todoist.net/mcp',          blurb: 'tasks and projects', auth: 'oauth' },
  { key: 'heroku',    label: 'Heroku',       category: 'Dev',      url: 'https://mcp.heroku.com/mcp',          blurb: 'apps, dynos and add-ons', auth: 'oauth' },
  { key: 'exa',       label: 'Exa',          category: 'AI',       url: 'https://mcp.exa.ai/mcp',              blurb: 'web search for agents', auth: 'oauth' },
  // grown 2026-08-09 (catalogue-growth pass): each endpoint probed live with
  // discover(); 'oauth' entries advertise a registration_endpoint, 'token'
  // entries answer but do not, so a member pastes an API token instead.
  { key: 'amplitude',           label: 'Amplitude',                category: 'Data',     url: 'https://mcp.amplitude.com/mcp',                    blurb: 'product analytics and charts', auth: 'oauth' },
  { key: 'circleci',            label: 'CircleCI',                 category: 'Dev',      url: 'https://mcp.circleci.com/v1/mcp',                  blurb: 'pipelines and build failures', auth: 'oauth' },
  { key: 'close',                label: 'Close',                    category: 'Comms',    url: 'https://mcp.close.com/mcp',                        blurb: 'CRM leads and conversations', auth: 'oauth' },
  { key: 'zapier',               label: 'Zapier',                   category: 'Web',      url: 'https://mcp.zapier.com/api/mcp/mcp',               blurb: 'run your Zaps', auth: 'oauth' },
  { key: 'attio',                label: 'Attio',                    category: 'Comms',    url: 'https://mcp.attio.com/sse',                        blurb: 'CRM records and lists', auth: 'oauth' },
  { key: 'clickup',              label: 'ClickUp',                  category: 'Docs',     url: 'https://mcp.clickup.com/mcp',                      blurb: 'tasks, docs and goals', auth: 'oauth' },
  { key: 'shortcut',             label: 'Shortcut',                 category: 'Dev',      url: 'https://mcp.shortcut.com/mcp',                     blurb: 'stories and epics', auth: 'oauth' },
  { key: 'gitlab',                label: 'GitLab',                   category: 'Dev',      url: 'https://gitlab.com/api/v4/mcp',                    blurb: 'repos, issues and merge requests', auth: 'oauth' },
  { key: 'prisma',                label: 'Prisma',                   category: 'Data',     url: 'https://mcp.prisma.io/mcp',                        blurb: 'database schema and queries', auth: 'oauth' },
  { key: 'plaid',                 label: 'Plaid',                    category: 'Payments', url: 'https://api.dashboard.plaid.com/mcp/sse',          blurb: 'bank connections and items', auth: 'oauth' },
  { key: 'resend',                label: 'Resend',                   category: 'Comms',    url: 'https://mcp.resend.com/mcp',                       blurb: 'send and inspect email', auth: 'oauth' },
  { key: 'klaviyo',                label: 'Klaviyo',                  category: 'Comms',    url: 'https://mcp.klaviyo.com/mcp',                      blurb: 'campaigns and audiences', auth: 'oauth' },
  { key: 'miro',                   label: 'Miro',                     category: 'Design',   url: 'https://mcp.miro.com/',                            blurb: 'boards and diagrams', auth: 'oauth' },
  { key: 'readwise',               label: 'Readwise',                 category: 'Docs',     url: 'https://mcp.readwise.io/mcp',                      blurb: 'highlights and reading list', auth: 'oauth' },
  { key: 'honeycomb',              label: 'Honeycomb',                category: 'Dev',      url: 'https://mcp.honeycomb.io/mcp',                     blurb: 'traces and queries', auth: 'oauth' },
  { key: 'posthog',                label: 'PostHog',                  category: 'Data',     url: 'https://mcp.posthog.com/mcp',                      blurb: 'analytics and session replays', auth: 'oauth' },
  { key: 'buildkite',              label: 'Buildkite',                category: 'Dev',      url: 'https://mcp.buildkite.com/mcp',                    blurb: 'pipelines and builds', auth: 'oauth' },
  { key: 'stytch',                 label: 'Stytch',                   category: 'Dev',      url: 'https://mcp.stytch.dev/mcp',                       blurb: 'auth users and sessions', auth: 'oauth' },
  { key: 'cloudflare-obs',         label: 'Cloudflare Observability',  category: 'Dev',      url: 'https://observability.mcp.cloudflare.com/mcp',     blurb: 'Workers logs and analytics', auth: 'oauth' },
  { key: 'cloudflare-bindings',    label: 'Cloudflare Bindings',       category: 'Dev',      url: 'https://bindings.mcp.cloudflare.com/mcp',          blurb: 'D1, KV, R2 and Workers', auth: 'oauth' },
  { key: 'workos',                 label: 'WorkOS',                   category: 'Dev',      url: 'https://mcp.workos.com/mcp',                       blurb: 'SSO and directory sync', auth: 'oauth' },
  { key: 'algolia',                label: 'Algolia',                  category: 'Web',      url: 'https://mcp.algolia.com/mcp',                      blurb: 'search indices and records', auth: 'oauth' },
  { key: 'coda',                   label: 'Coda',                     category: 'Docs',     url: 'https://coda.io/mcp',                              blurb: 'docs, tables and formulas', auth: 'oauth' },
  { key: 'sanity',                 label: 'Sanity',                   category: 'Web',      url: 'https://mcp.sanity.io/mcp',                        blurb: 'content and datasets', auth: 'oauth' },
  { key: 'contentful',             label: 'Contentful',               category: 'Web',      url: 'https://mcp.contentful.com/mcp',                   blurb: 'entries and content types', auth: 'oauth' },
  { key: 'polar',                  label: 'Polar',                    category: 'Payments', url: 'https://api.polar.sh/mcp',                         blurb: 'products and subscriptions', auth: 'oauth' },
  // reachable, but no DCR: connect goes through the by-URL form's token field
  { key: 'hubspot',    label: 'HubSpot',    category: 'Comms', url: 'https://mcp.hubspot.com/anthropic', blurb: 'contacts, deals and companies', auth: 'token' },
  { key: 'render',     label: 'Render',     category: 'Web',   url: 'https://mcp.render.com/mcp',        blurb: 'services and deploys', auth: 'token' },
  { key: 'zoom',       label: 'Zoom',       category: 'Comms', url: 'https://mcp.zoom.us/',              blurb: 'meetings and recordings', auth: 'token' },
  { key: 'pagerduty',  label: 'PagerDuty',  category: 'Dev',   url: 'https://mcp.pagerduty.com/mcp',     blurb: 'incidents and on-call', auth: 'token' },
  { key: 'elevenlabs', label: 'ElevenLabs', category: 'AI',    url: 'https://api.elevenlabs.io/mcp',     blurb: 'text to speech and voices', auth: 'token' },
  { key: 'box',        label: 'Box',        category: 'Docs',  url: 'https://mcp.box.com/',              blurb: 'files and folders', auth: 'token' },
  { key: 'mongodb',    label: 'MongoDB',    category: 'Data',  url: 'https://mcp.mongodb.com/mcp',       blurb: 'collections and queries', auth: 'token' },
  // AI note-takers (2026-08-24, asked for by pebbles and rocks). Every one of
  // these was probed the way the rest of the catalogue was, and then one step
  // further: registration was actually RUN against each endpoint, not merely
  // read off its metadata. That extra step is why tl;dv is absent. It
  // advertises a registration_endpoint, so a metadata-only check passes it,
  // but the registration itself answers 403, which would have shipped exactly
  // the dead one-click button the 2026-08-09 rework existed to remove.
  // Fathom, Read.ai, Circleback, Grain, Notta, Supernormal, Spinach, Bluedot,
  // Descript and Rev were checked too and publish no remote MCP endpoint yet.
  { key: 'otter',     label: 'Otter.ai',     category: 'Meetings', url: 'https://mcp.otter.ai/mcp',     blurb: 'meeting transcripts and summaries', auth: 'oauth' },
  { key: 'fireflies', label: 'Fireflies.ai', category: 'Meetings', url: 'https://mcp.fireflies.ai/mcp', blurb: 'meeting recordings, transcripts and notes', auth: 'oauth' },
  { key: 'granola',   label: 'Granola',      category: 'Meetings', url: 'https://mcp.granola.ai/mcp',   blurb: 'your meeting notes and transcripts', auth: 'oauth' },
  { key: 'avoma',     label: 'Avoma',        category: 'Meetings', url: 'https://mcp.avoma.com/mcp',    blurb: 'meeting notes, transcripts and insights', auth: 'oauth' },
  { key: 'krisp',     label: 'Krisp',        category: 'Meetings', url: 'https://mcp.krisp.ai/mcp',     blurb: 'call transcripts and meeting notes', auth: 'oauth' },
  { key: 'fyxer',     label: 'Fyxer',        category: 'Meetings', url: 'https://mcp.fyxer.com/mcp',    blurb: 'meeting notes and drafted email replies', auth: 'oauth' },
];
