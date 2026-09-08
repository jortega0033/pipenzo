/**
 * GitHub's OAuth **device flow**, run entirely inside Electron main (issue #114).
 *
 * ## Why this shape
 *
 * Epic #4's rule is that the `repo`-scoped token reaches the main-process vault and nothing else.
 * The device flow is what makes that possible: there is no redirect to catch, no embedded browser
 * to host, and no callback URL to register. Main asks GitHub for a code, the human types it into
 * their own browser, main polls, and main receives the token. The renderer's entire part is
 * displaying a short pairing code — which is why `packages/shared`'s credential contract has no
 * field that could carry a credential in either direction.
 *
 * ## Why not `@octokit/auth-oauth-device`
 *
 * Epic #4 sketches that library, and this is a deliberate departure with the same observable
 * behaviour. Three reasons, in order of weight:
 *
 * 1. **Fewer dependencies in the process that holds the credential.** Electron main here has no
 *    runtime dependencies at all. The flow is two form POSTs and one GET; adding a package tree to
 *    the one process that touches plaintext, to save sixty lines, is a bad trade for a surface
 *    whose whole argument is that it can be read end to end.
 * 2. **The polling loop is the part that needs controlling.** `slow_down` handling, a bounded
 *    total lifetime, and cancellation from the UI are exactly what this module has to get right,
 *    and wrapping a library's own loop to get them is more code than owning it.
 * 3. **Every branch of the error taxonomy becomes directly testable** against an injected `fetch`,
 *    with no network and no fake HTTP server.
 *
 * ## What never leaves this module
 *
 * `device_code` is the bearer of the pending authorization: anyone holding it can complete the
 * exchange for the token once the user authorizes. It is therefore treated exactly like the token
 * — it stays in `DeviceCodeGrant`, which stays in main. `PipenzoDeviceCodeV1`, the shape the
 * renderer sees, carries `userCode` and nothing else that could be exchanged for anything.
 */

/** The three endpoints, named rather than inlined so a test can assert what was called. */
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';

/**
 * `repo`, and the reason is on epic #4: creating labels and opening pull requests both need write
 * access to private repositories, and GitHub grants no narrower scope that covers either. This is
 * disclosed in the connect flow rather than buried in a consent screen, which is why the copy
 * naming it lives beside the button rather than in a tooltip.
 */
export const GITHUB_OAUTH_SCOPE = 'repo';

/**
 * The one host this flow will send a user to. GitHub returns `verification_uri` in its own
 * response, and a response that has been tampered with could return any https URL — which the
 * app would then open in the user's browser, showing a page asking for a GitHub device code.
 * Trusting the field to be https is not enough when the whole content of the page is "type this
 * credential-adjacent code here".
 */
export const GITHUB_VERIFICATION_HOST = 'github.com';

/**
 * GitHub's documented minimum, used when its response omits or malforms `interval` — and also as a
 * hard **floor** on whatever it does send.
 *
 * The floor is the half that is easy to leave out. `interval` is a number chosen by the response,
 * and nothing in JSON stops it being `0.001`: a tampered response could otherwise pin this client
 * at roughly a thousand requests a second against GitHub's token endpoint for the grant's whole
 * lifetime, which ends in an abuse-detection ban on the user's own IP address. Clamping only the
 * ceiling guards the direction that merely wastes time, and leaves open the one that does damage.
 */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** What GitHub adds to the interval on `slow_down`, per its own documentation. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;
/** A guard against a malicious or broken response pinning the UI on "waiting" for an hour. */
const MAX_POLL_INTERVAL_SECONDS = 60;
/** GitHub's codes last 15 minutes; this is the ceiling regardless of what `expires_in` claims. */
const MAX_GRANT_LIFETIME_MS = 20 * 60 * 1000;
/**
 * A hung connection must not stall the flow past the grant's own expiry — the expiry check only
 * runs *between* polls, so a request that never settles is a poll loop that never advances and a
 * UI that sits on "waiting" until the app is restarted.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Why a device-flow attempt ended without a credential. A closed union rather than a message,
 * because the UI says something different for each and a string would be matched on.
 */
export type DeviceFlowFailureReason =
  /** The code expired before the user finished authorizing. Recoverable: ask for a new one. */
  | 'expired'
  /** The user pressed Cancel on GitHub's own page. Recoverable, but not by retrying silently. */
  | 'denied'
  /** The user cancelled from inside Pipenzo. */
  | 'cancelled'
  /**
   * Device flow is not enabled on the OAuth app, or the client id is wrong or missing. This is a
   * deployment fault, not a user fault, and the copy has to say so — otherwise the user retries
   * forever against an app that can never answer.
   */
  | 'not_configured'
  /** GitHub could not be reached, or answered something this module cannot interpret. */
  | 'unreachable';

export class DeviceFlowError extends Error {
  readonly reason: DeviceFlowFailureReason;

  constructor(reason: DeviceFlowFailureReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = 'DeviceFlowError';
  }
}

/** Main's view of a pending authorization. Never crosses the bridge — see the module comment. */
export interface DeviceCodeGrant {
  /** The pairing code the human reads out. Safe to display; useless without the device code. */
  readonly userCode: string;
  /** Always on `GITHUB_VERIFICATION_HOST`, validated before this object exists. */
  readonly verificationUri: string;
  /** Epoch milliseconds. Already clamped to `MAX_GRANT_LIFETIME_MS`. */
  readonly expiresAt: number;
  /** Seconds between polls, as GitHub asked. Raised on `slow_down`. */
  readonly intervalSeconds: number;
  /** The bearer of this pending authorization. Treat exactly like the token itself. */
  readonly deviceCode: string;
}

export interface DeviceFlowCredential {
  readonly token: string;
  readonly login: string;
}

export interface GitHubDeviceFlowOptions {
  /**
   * The OAuth app's client id. Public by construction — device flow is a public client with no
   * secret, and this value ships in the binary of every desktop app that uses one. See #220 for
   * registering the app this belongs to.
   */
  readonly clientId: string;
  /** Injected so every branch below is testable without a network or a fake server. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** Injected so the polling tests do not spend real seconds sleeping. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * GitHub answers both OAuth endpoints with HTTP 200 and an `error` field in the body, so the
 * status code says almost nothing and the body has to be read either way.
 */
interface GitHubOAuthBody {
  readonly error?: unknown;
  readonly device_code?: unknown;
  readonly user_code?: unknown;
  readonly verification_uri?: unknown;
  readonly expires_in?: unknown;
  readonly interval?: unknown;
  readonly access_token?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Maps GitHub's `error` strings onto the closed union above.
 *
 * The default is `unreachable` rather than a pass-through of GitHub's string, so an error nobody
 * anticipated cannot reach a UI branch that was never written for it. `incorrect_client_credentials`
 * and `unsupported_grant_type` both mean the same thing to a user — this build is misconfigured —
 * and both are far more likely during setup than in the field.
 */
function classifyOAuthError(error: string): DeviceFlowFailureReason {
  switch (error) {
    case 'expired_token':
      return 'expired';
    case 'access_denied':
      return 'denied';
    case 'device_flow_disabled':
    case 'incorrect_client_credentials':
    case 'unsupported_grant_type':
    case 'incorrect_device_code':
      return 'not_configured';
    default:
      return 'unreachable';
  }
}

export class GitHubDeviceFlow {
  readonly #clientId: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: GitHubDeviceFlowOptions) {
    this.#clientId = options.clientId;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Whether this build can run the flow at all. A missing client id is #220, not a user error. */
  get configured(): boolean {
    return this.#clientId.length > 0;
  }

  /**
   * The caller's cancellation, combined with a request timeout.
   *
   * The timeout is not belt-and-braces: the grant's expiry is only checked *between* polls, so a
   * request that never settles is a poll loop that never advances and a UI that sits on "waiting"
   * until the app restarts. `AbortSignal.any` keeps the caller's own cancellation working; where it
   * is unavailable the timeout alone is still better than nothing.
   */
  #timeoutSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (!signal) return timeout;
    return typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : signal;
  }

  async #postForm(
    url: string,
    body: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GitHubOAuthBody> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          // Without this GitHub answers `application/x-www-form-urlencoded`, and the parse below
          // would fail on every response including the successful one.
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        // The signal matters more on the token exchange than it looks. Without it, a cancel landing
        // mid-exchange still lets the request complete server-side: GitHub issues a real,
        // `repo`-scoped token that this app then drops on the floor. A device flow is a public
        // client with no secret, so there is no revoke call it could make to clean that up -- the
        // credential just exists on the user's account until they revoke it by hand. Not starting
        // the work is the only way to not finish it.
        signal: this.#timeoutSignal(signal),
      });
    } catch (error) {
      throw new DeviceFlowError(
        'unreachable',
        `could not reach GitHub: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new DeviceFlowError('unreachable', `GitHub answered ${response.status} with no JSON`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new DeviceFlowError('unreachable', 'GitHub answered with a non-object body');
    }
    return parsed as GitHubOAuthBody;
  }

  /**
   * Step one: ask GitHub for a pairing code.
   *
   * Every field of the response is validated before a grant exists, including the host of
   * `verification_uri` — see `GITHUB_VERIFICATION_HOST` for why a plain https check is not enough
   * for a URL this app will open in the user's browser.
   */
  async requestCode(): Promise<DeviceCodeGrant> {
    if (!this.configured) {
      throw new DeviceFlowError(
        'not_configured',
        'this build has no GitHub OAuth client id, so it cannot start a sign-in',
      );
    }

    const body = await this.#postForm(GITHUB_DEVICE_CODE_URL, {
      client_id: this.#clientId,
      scope: GITHUB_OAUTH_SCOPE,
    });

    const error = asString(body.error);
    if (error) {
      throw new DeviceFlowError(
        classifyOAuthError(error),
        `GitHub refused the device-code request: ${error}`,
      );
    }

    const deviceCode = asString(body.device_code);
    const userCode = asString(body.user_code);
    const verificationUri = asString(body.verification_uri);
    if (!deviceCode || !userCode || !verificationUri) {
      throw new DeviceFlowError('unreachable', 'GitHub returned an incomplete device-code response');
    }

    let parsedUri: URL;
    try {
      parsedUri = new URL(verificationUri);
    } catch {
      throw new DeviceFlowError('unreachable', 'GitHub returned a malformed verification URL');
    }
    // Pinned, not merely https. This URL is opened in the user's own browser, and the page it
    // leads to asks them to type a code — so a tampered response pointing anywhere else is a
    // ready-made phishing page delivered by the app itself.
    if (
      parsedUri.protocol !== 'https:' ||
      parsedUri.hostname !== GITHUB_VERIFICATION_HOST ||
      // Userinfo and a non-default port are rejected *here* rather than left to the launch gate.
      // `openAllowedExternalUrl` does refuse a URL carrying userinfo, but it refuses it by logging
      // and returning -- so the user would click "Verify at github.com/login/device" and watch
      // nothing happen, with no error anywhere they can see. Failing at grant time turns a silent
      // dead button into a stated outcome.
      parsedUri.username ||
      parsedUri.password ||
      parsedUri.port
    ) {
      throw new DeviceFlowError(
        'unreachable',
        'GitHub returned a verification URL that is not plainly on github.com',
      );
    }

    const expiresIn = asPositiveNumber(body.expires_in);
    const interval = asPositiveNumber(body.interval);
    return {
      userCode,
      verificationUri: parsedUri.toString(),
      // Clamped both ways: a response claiming a very long life would leave a dead poll running,
      // and a missing one would otherwise expire the grant instantly.
      //
      // Floored, because the wire schema declares `expiresAt` an integer. A fractional
      // `expires_in` would otherwise produce a grant that main polls happily and the preload
      // refuses to parse -- and since the grant is live by then, every retry returns the same
      // unparseable one, leaving the screen stuck until it expires up to twenty minutes later.
      expiresAt: Math.floor(
        this.#now() +
          Math.min(expiresIn ? expiresIn * 1000 : MAX_GRANT_LIFETIME_MS, MAX_GRANT_LIFETIME_MS),
      ),
      // Clamped on *both* sides -- see DEFAULT_POLL_INTERVAL_SECONDS for why the floor is the half
      // that matters. `Math.max` first, so a hostile sub-second value is raised before the ceiling
      // is applied rather than passing straight through it.
      intervalSeconds: Math.min(
        Math.max(interval ?? DEFAULT_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_SECONDS),
        MAX_POLL_INTERVAL_SECONDS,
      ),
      deviceCode,
    };
  }

  /**
   * Step two: wait for the human, then exchange the device code for a token.
   *
   * Resolves only with a real credential; every other outcome is a `DeviceFlowError` carrying one
   * of the closed reasons. The first sleep happens *before* the first poll, because the user
   * cannot possibly have authorized in the time it took to render the code, and an immediate poll
   * only brings the `slow_down` rate limit closer.
   */
  async poll(grant: DeviceCodeGrant, options: { signal?: AbortSignal } = {}): Promise<DeviceFlowCredential> {
    const { signal } = options;
    let intervalSeconds = grant.intervalSeconds;

    for (;;) {
      if (signal?.aborted) throw new DeviceFlowError('cancelled', 'sign-in was cancelled');
      await this.#sleep(intervalSeconds * 1000, signal);
      if (signal?.aborted) throw new DeviceFlowError('cancelled', 'sign-in was cancelled');
      // Checked on this side too, not only trusted to GitHub's `expired_token`: a device code that
      // stopped being polled successfully would otherwise leave the UI on "waiting" indefinitely.
      if (this.#now() >= grant.expiresAt) {
        throw new DeviceFlowError('expired', 'the device code expired before it was authorized');
      }

      const body = await this.#postForm(
        GITHUB_ACCESS_TOKEN_URL,
        {
          client_id: this.#clientId,
          device_code: grant.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        signal,
      );

      const error = asString(body.error);
      if (!error) {
        const token = asString(body.access_token);
        if (!token) {
          throw new DeviceFlowError('unreachable', 'GitHub reported success with no access token');
        }
        return { token, login: await this.#readLogin(token, signal) };
      }

      if (error === 'authorization_pending') continue;
      if (error === 'slow_down') {
        // GitHub's own instruction: add five seconds and keep going. Its response also carries an
        // `interval`, but the documented contract is the increment, and honouring a returned value
        // uncritically is how a hostile response pins this loop.
        intervalSeconds = Math.min(
          intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS,
          MAX_POLL_INTERVAL_SECONDS,
        );
        continue;
      }
      throw new DeviceFlowError(classifyOAuthError(error), `GitHub ended the sign-in: ${error}`);
    }
  }

  /**
   * The account the token belongs to, which the vault needs in order to say who is connected.
   *
   * A failure here fails the whole sign-in rather than storing a credential with an unknown owner:
   * "connected" with no name is a state the user cannot check, and this is the one moment the app
   * can cheaply verify that the token it just received actually works.
   */
  async #readLogin(token: string, signal?: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(GITHUB_USER_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new DeviceFlowError(
        'unreachable',
        `could not read the account for the new token: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    if (!response.ok) {
      throw new DeviceFlowError(
        'unreachable',
        `GitHub answered ${response.status} when asked who the new token belongs to`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new DeviceFlowError('unreachable', 'GitHub returned a non-JSON account response');
    }
    const login =
      typeof parsed === 'object' && parsed !== null
        ? asString((parsed as { login?: unknown }).login)
        : undefined;
    if (!login) {
      throw new DeviceFlowError('unreachable', 'GitHub returned an account with no login');
    }
    return login;
  }
}
