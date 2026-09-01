// connection-labels.mjs — the ONE place a connection key becomes a human name.
//
// Why (2026-08-09, Sam's dashboard audit): the Overview card and the Connections
// page grew separate label maps. The page knew "notion" is Notion; the card knew
// three keys and rendered every other server as its raw lowercase key, so a real
// box showed "gmail" while the shot rig (whose fixture was hand-capitalised)
// showed "Gmail". Two maps WILL diverge again; one module cannot.
//
// Rule for consumers: never render a key. Render connectionLabel(key). Unknown
// keys fall back to de-kebab + title-case, so a member who connects
// "youtube-transcript" reads "Youtube Transcript", never the wire name.

export const CONNECTION_LABELS = {
  // provider bridges
  ms365: 'Microsoft 365 (Outlook + Calendar)',
  google: 'Google Workspace',
  todoist: 'Todoist',
  // featured MCP catalogue (labels here; urls/blurbs live with the catalogue)
  notion: 'Notion',
  linear: 'Linear',
  sentry: 'Sentry',
  canva: 'Canva',
  vercel: 'Vercel',
  apify: 'Apify',
  // shown-but-not-connectable Google endpoints
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  // AI note-takers (2026-08-24). Named here as well as in the catalogue because
  // the catalogue's label dies at connect time: once a server is IN .mcp.json,
  // every surface renders it through connectionLabel(key). Left to the
  // fallback, 'otter' would read "Otter" on the Overview card while the
  // directory tile it was connected from said "Otter.ai".
  otter: 'Otter.ai',
  fireflies: 'Fireflies.ai',
  granola: 'Granola',
  avoma: 'Avoma',
  krisp: 'Krisp',
  fyxer: 'Fyxer',
  // box-native channels
  telegram: 'Telegram',
};

export function connectionLabel(key) {
  const k = key == null ? '' : String(key).trim();
  if (CONNECTION_LABELS[k]) return CONNECTION_LABELS[k];
  const words = k.split(/[-_]+/).filter(Boolean);
  if (!words.length) return k;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
