import {
  captureManifestSetV1Schema,
  type CaptureManifestSetV1,
  type CaptureManifestV1,
} from '@agent-dock/shared';

/**
 * The capture manifest's validator (Pipenzo issue #138).
 *
 * The schema in `@agent-dock/shared` says what a manifest *is*. This says what it is allowed to
 * mean once the daemon is about to act on it, and the difference is the whole ticket: a manifest
 * is agent-proposed, so the step between "parsed successfully" and "handed to Playwright" is the
 * last place anything can be checked.
 *
 * Two things happen here that a schema cannot do on its own:
 *
 * 1. **The route is resolved and the *resolved* origin is re-checked.** `captureRouteV1Schema`
 *    refuses schemes, authorities and protocol-relative paths, and this still resolves the route
 *    against the ephemeral origin with the URL parser and then compares origins. That is
 *    deliberate redundancy: the schema is a set of rules someone wrote about strings, and this is
 *    the question actually at stake — "after the browser resolves this, which origin is it on?".
 *    If those two ever disagree, the answer that wins is the parser's.
 * 2. **The origin itself is constrained to loopback.** The daemon starts the dev server, so it
 *    knows the origin; binding to it here means a future caller cannot pass a manifest and a
 *    remote base URL and have the capture step fetch it.
 *
 * What this module deliberately does not do is repair a manifest. A route with a scheme in it is
 * not stripped and retried, and a selector with an engine prefix is not rewritten into CSS. A
 * proposal that failed validation failed; silently normalising it into a passing one is how the
 * agent's actual proposal stops being the thing that was reviewed.
 */

export type CaptureManifestErrorCode =
  | 'invalid_manifest'
  | 'unsafe_route'
  | 'origin_not_loopback'
  | 'invalid_origin';

export class CaptureManifestError extends Error {
  readonly code: CaptureManifestErrorCode;
  readonly details: readonly string[];

  constructor(code: CaptureManifestErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'CaptureManifestError';
    this.code = code;
    this.details = details.slice(0, 20).map((detail) => detail.slice(0, 500));
  }
}

/** Hostnames a capture may ever be pointed at. The daemon started the server; it is local. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Validates a raw, agent-proposed payload into a manifest set.
 *
 * Fails with `invalid_manifest` and the first twenty schema issues. The issue paths are safe to
 * surface — they name fields, not values — and an operator staring at a rejected capture proposal
 * needs to know which field the agent got wrong.
 */
export function parseCaptureManifestSet(raw: unknown): CaptureManifestSetV1 {
  const parsed = captureManifestSetV1Schema.safeParse(raw);
  if (!parsed.success) {
    throw new CaptureManifestError(
      'invalid_manifest',
      'the capture manifest did not match the v1 schema',
      parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/**
 * Parses and normalises the ephemeral origin the daemon started, refusing anything that is not
 * loopback HTTP.
 *
 * `https` is refused as well as remote hosts, and not for security theatre: the daemon starts this
 * server itself on a port it chose, so an `https` origin here would mean the origin did not come
 * from where this module thinks it did.
 */
export function assertEphemeralOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new CaptureManifestError('invalid_origin', 'the capture origin is not a URL');
  }
  if (url.protocol !== 'http:') {
    throw new CaptureManifestError(
      'origin_not_loopback',
      'a capture origin must be plain http on loopback',
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && !LOOPBACK_HOSTS.has(url.host.split(':')[0] ?? '')) {
    throw new CaptureManifestError(
      'origin_not_loopback',
      'a capture may only be pointed at the loopback dev server the daemon started',
      [url.hostname],
    );
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new CaptureManifestError(
      'invalid_origin',
      'a capture origin must be a bare origin, with no path, query or fragment',
    );
  }
  return url;
}

/**
 * Resolves one capture's route against the ephemeral origin and proves the result stayed there.
 *
 * The origin comparison after resolution is the actual guarantee. Everything before it is a set of
 * rules about strings; this is the browser's own answer to "where does this go?", asked before the
 * browser is the one asking.
 */
export function resolveCaptureUrl(origin: URL, route: string): URL {
  let resolved: URL;
  try {
    resolved = new URL(route, origin);
  } catch {
    throw new CaptureManifestError('unsafe_route', 'the capture route is not resolvable');
  }
  if (resolved.origin !== origin.origin) {
    throw new CaptureManifestError(
      'unsafe_route',
      'the capture route resolves off the daemon’s own dev-server origin',
      [resolved.origin],
    );
  }
  return resolved;
}

export interface ResolvedCapture {
  readonly capture: CaptureManifestV1;
  /** The absolute URL the daemon will navigate to. Every one of them is on `origin`. */
  readonly url: URL;
}

/**
 * The one call a caller should make: parse, bind to the origin, resolve every route.
 *
 * Returning resolved URLs rather than routes means the executor (issue #139) never re-does this
 * join, so there is exactly one place where a route becomes a destination and exactly one place
 * that has to be right.
 */
export function resolveCaptureManifestSet(
  raw: unknown,
  origin: string,
): { readonly set: CaptureManifestSetV1; readonly captures: readonly ResolvedCapture[] } {
  const base = assertEphemeralOrigin(origin);
  const set = parseCaptureManifestSet(raw);
  return {
    set,
    captures: set.captures.map((capture) => ({
      capture,
      url: resolveCaptureUrl(base, capture.route),
    })),
  };
}
