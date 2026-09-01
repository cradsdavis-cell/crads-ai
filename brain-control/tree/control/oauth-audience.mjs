// The OAuth audience every verified handshake is checked against.
//
// This is the Crads-AI DESKTOP (installed-app) client id, the same constant the
// app ships in wizard/panel/google-signin.mjs. Google classes installed-app
// client ids as non-confidential; PKCE carries the real proof. It is a PLATFORM
// constant, identical for every rock, and it was never per-rock configuration.
//
// It used to have to be configured anyway, and nothing in provisioning ever
// wrote it, so on every rock ever stamped three scripts sat dormant:
//   join-reconcile    the rock never saw a member's request to join, so the
//                     member's app said "Request sent, waiting for their
//                     approval, it resumes by itself" and it never did
//   invite-reconcile  a redeemed device never appeared under Approve a device,
//                     so the admin had to paste the public key line by hand,
//                     while the panel promised it would appear by itself
//   auto-approve      never ran at all
// Found 2026-08-05 by asking to join a community for real and watching the
// request land nowhere.
//
// An org bringing its own OAuth client still overrides via env or repo .env.
// The public repository ships no client id: set AIOS_OAUTH_AUDIENCE (env or
// repo .env) to your own installed-app client if you run the handshake.
export const DEFAULT_OAUTH_AUDIENCE = '';
