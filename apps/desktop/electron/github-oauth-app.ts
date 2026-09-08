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
 * ## It is empty until someone registers the app
 *
 * Registering an OAuth App is an action on a real GitHub account, so it is not automatable — see
 * **#220**, which carries the steps (including enabling Device Flow, which is off by default and
 * is the single most likely thing to be missed). Until then this is the empty string, and the
 * effect of that is deliberate: `GitHubDeviceFlow.configured` is false, `requestCode()` refuses
 * before making any request, and the UI reports `not_configured` — a build fault, said as one.
 *
 * That is the failure this default is chosen to produce. A placeholder id that *looked* real would
 * instead send a request to GitHub, receive an error nobody anticipated, and surface as "GitHub
 * rejected the sign-in" — sending whoever hit it to debug their account rather than this line.
 */
export const GITHUB_OAUTH_CLIENT_ID = '';
