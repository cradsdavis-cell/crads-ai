// run-tag.mjs: the mark of one create (2026-10-19). A random tag minted for a
// single server create and written into the build record (state.runTag), so a
// server that carries it was made by that create, by construction. Every
// cloud client puts it on the server in its own way (a DigitalOcean tag, a
// Hetzner label, a Scaleway tag), finds a lost create answer by it alone, and
// refuses to delete a server that does not carry it. Letters, digits and
// dashes only, which every provider's tags accept.
import { randomBytes } from 'node:crypto';

export const RUN_TAG_RE = /^crads-run-[0-9a-f]{16}$/;
export const newRunTag = () => `crads-run-${randomBytes(8).toString('hex')}`;
