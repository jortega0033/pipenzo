/**
 * The identity of Pipenzo's GitHub OAuth App (issue #114).
 *
 * ## This constant is public, and that is not an oversight
 *
 * A device flow is a **public client**. It has no client secret at all — GitHub does not issue one
 * for this grant type, precisely because a distributed desktop application cannot keep one. The
 * client id is an identifier, not a credential: it ships in the binary of every desktop app that
 * signs in this way, and anyone can read it out of any copy of the app in seconds.
 *
 * What actually authorizes anything is the human typing a code into github.com under their own
 * account, and the resulting token, which never leaves the machine it was issued on. So this file
 * is safe to commit, and deliberately is: an id fetched from a server at runtime would add a
 * network dependency and a spoofing surface in exchange for hiding something that is not hidden.
 *
 * ## Where this value comes from
 *
 * Registering an OAuth App is an action on a real GitHub account, so it was not something an agent
 * could do on its own — see **#220**, which carried the steps (including enabling Device Flow,
 * which is off by default and was the single most likely thing to be missed). The app is now
 * registered under the maintainer's GitHub account, with Device Flow enabled and no client secret
 * generated, and this is that app's client id.
 *
 * If this is ever blanked back out to the empty string (a fork, a revoked/deleted app, a fresh
 * clone that intentionally strips it), the failure mode is still deliberate:
 * `GitHubDeviceFlow.configured` goes false, `requestCode()` refuses before making any request, and
 * the UI reports `not_configured` — a build fault, said as one, rather than a placeholder id that
 * *looked* real sending a request to GitHub and surfacing as "GitHub rejected the sign-in."
 */
export const GITHUB_OAUTH_CLIENT_ID = 'Ov23liswKZIFMnbznUMY';
