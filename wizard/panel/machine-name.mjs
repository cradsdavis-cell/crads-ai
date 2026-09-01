// machine-name.mjs — what to call the computer a member is sitting at.
//
// Lifted out of device-enrol.mjs on 2026-08-13 (finding 116) so BOTH enrolment
// paths can name a device the same way. device-enrol imports member-connect, so
// member-connect could not import back from device-enrol without a cycle; this
// module is the shared floor under both. device-enrol re-exports it, so every
// existing importer is untouched.
import { hostname } from 'node:os';

// The junk list is the migration: app builds already shipped keep sending
// navigator.platform, so a supplied name is honoured ONLY when it is not one of
// those strings. That leaves room for a future "type a name for this computer"
// without re-opening the hole.
const PLATFORM_JUNK = new Set([
  'win32', 'win64', 'windows', 'winnt', 'macintel', 'macppc', 'mac68k', 'macintosh',
  'linux x86_64', 'linux i686', 'linux armv7l', 'linux armv8l', 'linux aarch64',
  'iphone', 'ipad', 'ipod', 'android', 'computer', 'this computer', 'device',
]);

/** The name a roster should use for the machine this process is running on. */
export function machineName(supplied = '') {
  const given = String(supplied || '').trim();
  if (given && !PLATFORM_JUNK.has(given.toLowerCase())) return given.slice(0, 60);
  // first label only: "sams-laptop.local" and "sams-laptop" are one machine to
  // a human, and the FQDN suffix is noise on a device card
  const own = String(hostname() || '').trim().split('.')[0];
  if (own && own.toLowerCase() !== 'localhost') return own.slice(0, 60);
  return 'This computer';
}

/** The slug shape a roster row gets for this machine, before collision suffixes. */
export const machineSlug = (supplied = '') => String(machineName(supplied)).toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'this-computer';
