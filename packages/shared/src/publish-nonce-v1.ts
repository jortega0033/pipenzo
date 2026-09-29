/**
 * The publish-nonce wire contract (Pipenzo issue #182).
 *
 * ## The gap this closes
 *
 * `apps/daemon/src/publish-service.ts`'s own module comment already names it: agentdock's
 * discovery file writes `{port, token}` to a mode-0600 file under the OS temp directory, and
 * `TEMP`/`TMP`/`HOME` sit on the reviewed allowlist a session's environment can see. A file-read-
 * capable agent session could in principle locate and read that file, and with it the daemon's
 * bearer token — mode 0600 separates *users*, not the agent from the daemon that spawned it. No
 * agent session has a *tool* that calls the publish route and no *environment* that addresses the
 * daemon (see that module's own token-boundary tests), so this is a narrow, multi-step gap rather
 * than a live exploit path — but it is a real one, and the publish route is the one place on the
 * daemon's authenticated surface that can push a branch or open a pull request.
 *
 * The fix is a second factor the bearer token alone cannot satisfy: a short-lived, single-use
 * nonce, minted by Electron main **at the instant** a human clicks "Push branch" or "Push & open
 * PR" (`apps/desktop/electron/main.ts`'s `daemon:pipenzo-publish` handler — the one IPC channel
 * that click reaches, guarded by `isFromMainWindowFrame`), and required by the route in addition
 * to the bearer token. Even a session that somehow obtained the bearer token off disk still could
 * not mint a nonce that verifies, because the secret this module signs with never touches disk at
 * all: it travels the same stdin handoff issue #165 built for the GitHub credential
 * (`apps/daemon/src/github-credential.ts`), held only in Electron main's and the daemon's own
 * process memory for the run's lifetime.
 *
 * ## Why an HMAC rather than a server-minted, then client-fetched, token
 *
 * A "call `/publish-nonce`, get a token, then call `/publish`" design would still only require the
 * bearer token to complete both calls — exactly the credential this nonce exists to be a *second*
 * factor beyond. Minting locally, from a secret the bearer token's own leak path (the discovery
 * file) never carries, is what actually adds a factor rather than an extra round trip.
 *
 * ## Wire shape
 *
 * `${random}.${issuedAtMs base36}.${hmac-sha256 hex}`, sent as the `PIPENZO_PUBLISH_NONCE_HEADER`
 * request header (never in the JSON body `PublishService`/`pipenzoPublishRequestV1Schema` already
 * validate as the git-safety argv contract — a route-level auth factor belongs beside the bearer
 * `Authorization` header it supplements, not inside the body those two independently re-validate).
 *
 * ## This file is browser-safe on purpose
 *
 * Everything below is a pure constant, type, or string check — no `node:crypto`. The functions that
 * actually mint or verify a nonce (`generatePublishNonceSecret`, `mintPublishNonce`,
 * `verifyPublishNonceMac`) live in the sibling `publish-nonce-node-v1.ts` instead, and are
 * deliberately **not** re-exported from this package's main barrel (`index.ts`). `apps/desktop`'s
 * renderer bundle is built for the browser, and `packages/client` (which the renderer imports) only
 * ever needs `PIPENZO_PUBLISH_NONCE_HEADER` from this contract, not the crypto operations — so the
 * whole point of splitting the file is that no import path reachable from the renderer's build graph
 * can pull `node:crypto` into it. Confirmed the hard way: a single shared file that mixed both kept
 * `apps/desktop`'s `vite build` failing on `randomBytes is not exported by __vite-browser-external`,
 * because Rollup still has to resolve every named binding in a graph-reachable module regardless of
 * whether tree-shaking would later drop it. Only the daemon and Electron main (both real Node
 * processes) import the Node-only file, via `@agent-dock/shared/publish-nonce-node-v1.js`.
 */

/** The header the route reads it from, and the client attaches it to. Lower-case: Fastify and the
 * Fetch `Headers` object both normalize header names this way, so comparing against this constant
 * on either side never depends on how a caller happened to capitalize it. */
export const PIPENZO_PUBLISH_NONCE_HEADER = 'x-pipenzo-publish-nonce';

/**
 * How long a minted nonce stays acceptable. Generous relative to "mint it, then make the one HTTP
 * call that follows immediately after" (main's click handler does nothing else in between), and
 * narrow enough that a nonce observed in flight — the one channel that is not disk, and the one
 * this design does not claim to defend — is useless within half a minute.
 */
export const PUBLISH_NONCE_FRESHNESS_MS = 30_000;

/** Also used by `publish-nonce-node-v1.ts`'s `verifyPublishNonceMac` -- kept here, not duplicated,
 * since it's a pure wire-shape fact, not a crypto operation. */
export const NONCE_PATTERN = /^[0-9a-f]{32}\.[0-9a-z]+\.[0-9a-f]{64}$/;

/** 32 random bytes, hex-encoded: the shape both `buildDaemonCredentialMessage` (the sender) and
 * `PublishNonceGate` (the reader) agree the secret must have before either will use it. */
export function isPublishNonceSecretShaped(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export interface ParsedPublishNonce {
  readonly random: string;
  readonly issuedAtMs: number;
}
