/** Base class for every error this client throws: `catch (e) { if (e instanceof AgentDockClientError) ... }` catches all of them. */
export abstract class AgentDockClientError extends Error {}

/** The daemon could not be reached at all: connection refused, DNS failure, timeout, aborted. */
export class DaemonUnavailableError extends AgentDockClientError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DaemonUnavailableError';
  }
}

/** The daemon rejected the request's bearer token (HTTP 401). */
export class UnauthorizedError extends AgentDockClientError {
  constructor(message = "the daemon rejected this client's token") {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The daemon's protocol version doesn't match what this client was built against. Thrown from
 * the first call any client method makes (see client.ts's compatibility check), never something
 * you need to check for manually.
 */
export class ProtocolMismatchError extends AgentDockClientError {
  constructor(
    public readonly clientVersion: number,
    public readonly daemonVersion: number,
  ) {
    super(
      `this client supports protocol ${clientVersion}, but the daemon reports protocol ${daemonVersion}`,
    );
    this.name = 'ProtocolMismatchError';
  }
}

/** The daemon rejected the request as malformed (HTTP 400), or an SSE frame failed schema validation. */
export class ValidationError extends AgentDockClientError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** `GET/POST /sessions/:id...` referenced a session id the daemon doesn't know about (HTTP 404). */
export class SessionNotFoundError extends AgentDockClientError {
  constructor(public readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/** `GET /providers/:id` referenced a provider id the daemon has no adapter for (HTTP 404), or `POST /sessions` named an unsupported provider (HTTP 400). */
export class ProviderUnavailableError extends AgentDockClientError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Any other daemon-declared failure: preserves the daemon's own status, code, message, and
 * `details`.
 *
 * `details` is the unvalidated `details` field of the daemon's error body, carried through rather
 * than discarded because some refusals are only actionable with it. The `replay_gap` a bounded
 * event stream answers with is the motivating case: the daemon reports the window it *can* still
 * serve, and a caller that never sees it has no way to pick a cursor that would be accepted, so it
 * can only retry the same rejected cursor forever. Typed as `unknown` on purpose -- it crosses the
 * wire, so a caller parses it against the schema it expects instead of trusting the shape.
 */
export class DaemonError extends AgentDockClientError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DaemonError';
  }
}
