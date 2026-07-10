/**
 * @cuny-ai-lab/cail-client — the CAIL model-proxy API client.
 *
 * The consumer-side twin of `@cuny-ai-lab/cail-identity`: the one library every
 * CAIL tool uses to *call* the model proxy correctly. It owns the credential /
 * header / error / retry contract from `docs/INTEGRATION.md` §1–2 so no tool
 * re-derives them.
 *
 * Design contract (see README + CAIL_CLIENT_PRIMITIVE_SPEC.md, invariants
 * I1–I9):
 *   - Pure Web-standard `fetch`/`Request`/`Response` — runs unchanged in the
 *     browser, Cloudflare Workers, and Node >=20. No SDK deps.
 *   - Exactly ONE credential reaches the wire (I1): the JWT path strips any
 *     `Authorization` the caller/SDK injected (the dummy-bearer footgun).
 *   - `X-CAIL-App` is a validated, low-cardinality slug (I2), sent on every call.
 *   - Optional `X-CAIL-Metadata` is validated and serialized as JSON (I3).
 *   - Non-2xx → a typed `CailError` with the envelope's `message` VERBATIM;
 *     a non-JSON error body is never swallowed as success (I4).
 *   - Never retry 4xx; retry 5xx + network up to `maxRetries` with backoff (I5).
 *   - `401 authentication_required` invokes `onAuthRequired`, then still throws
 *     (I6).
 *   - 2xx `Response` returned by reference, body NOT buffered (SSE passthrough,
 *     I7); `init.body` and the `model` id forwarded verbatim (I8).
 *   - Quota headers are advisory and all-or-none: absent/malformed quota
 *     headers mean "meter unavailable", never a client error (I9).
 *
 * The public surface is `string`/`number`/plain-object/`Response` only — no
 * ambient platform (`DOM`/Workers) types leak out of the `.d.ts`.
 */

/** Credential forwarded on a call. Exactly one kind reaches the wire (I1). */
export type CailCredential =
  | { kind: "jwt"; token: string }
  | { kind: "key"; token: string };

/** Per-call spend metadata (I3). Merged with any `X-CAIL-Metadata` in `init`. */
export type CailMetadata = Record<string, string | number>;

/** Advisory quota meter carried on model-proxy responses (I9). */
export interface CailQuota {
  limit: number;
  used: number;
  remaining: number;
  reset: number;
  window_seconds: number;
  state: "ok" | "stale";
}

/** Snapshot returned by `GET /quota`. */
export interface CailQuotaSnapshot extends CailQuota {
  subject: string;
  enforced: boolean;
  as_of: number;
}

/**
 * A typed CAIL backbone error. Thrown by `call()` on any non-2xx response (I4)
 * and on retry exhaustion (I5). `message` is the envelope's `message` verbatim
 * — safe to show the user as-is (INTEGRATION.md §2).
 */
export class CailError extends Error {
  /** The envelope `error` code, e.g. `"quota_exceeded"`; `"unknown_error"` / `"network_error"` for non-envelope failures. */
  readonly code: string;
  /** HTTP status; `0` for a network/transport failure with no response. */
  readonly status: number;
  /** Any extra envelope fields beyond `error`/`message` (e.g. `login_url`, `retry_after_seconds`). */
  readonly extras: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    extras: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CailError";
    this.code = code;
    this.status = status;
    this.extras = extras;
    // Preserve prototype chain when compiled to ES5-ish targets / bundlers.
    Object.setPrototypeOf(this, CailError.prototype);
  }
}

export interface CailClientOptions {
  /** CAIL_API_BASE, e.g. `https://api.…` — no trailing slash (trailing slashes are trimmed). */
  baseUrl: string;
  /** X-CAIL-App slug — validated at construction against `/^[a-z0-9][a-z0-9-]{0,63}$/`. */
  app: string;
  /**
   * 401 hook (I6). Invoked with the `CailError` when the proxy returns
   * `401 authentication_required`, immediately before `call()` throws it.
   * Default (when running in a browser): {@link browserAuthRedirect}.
   */
  onAuthRequired?: (err: CailError) => void;
  /** Injectable fetch (tests / custom transports). Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Max retries for 5xx + network errors (I5). Default 2. Never applies to 4xx. */
  maxRetries?: number;
}

export interface CailCallOptions {
  /** Per-call spend metadata (I3), merged over any `X-CAIL-Metadata` already in `init.headers`. */
  metadata?: CailMetadata;
}

export interface CailClient {
  /**
   * Call the proxy. Returns the 2xx `Response` by reference (body NOT buffered,
   * I7). Throws {@link CailError} on any non-2xx response or transport failure.
   *
   * @param path   e.g. `/v1/compat/chat/completions` (joined onto `baseUrl`).
   * @param init   method / body / headers; `body` and `model` forwarded verbatim (I8).
   * @param credential  the single credential to forward (I1).
   * @param options  optional per-call metadata (I3).
   */
  call(
    path: string,
    init: RequestInit,
    credential: CailCredential,
    options?: CailCallOptions,
  ): Promise<Response>;

  /**
   * Read the authenticated subject's quota snapshot from `GET /quota`.
   * Non-2xx responses throw the same {@link CailError} envelope as `call()`;
   * malformed 2xx quota bodies throw `code:"unknown_error"`.
   */
  getQuota(credential: CailCredential): Promise<CailQuotaSnapshot>;
}

const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_METADATA_KEYS = new Set(["user_id", "app", "via"]);
const POLLUTION_METADATA_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const MAX_METADATA_KEYS = 8;
const MAX_METADATA_STRING_LEN = 128;
const CREDENTIAL_CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
const QUOTA_STATE_VALUES = new Set(["ok", "stale"]);
const QUOTA_INTEGER_RE = /^\d+$/;

function parseQuotaInteger(value: string | null): number | null {
  if (value === null || !QUOTA_INTEGER_RE.test(value)) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function isQuotaState(value: unknown): value is CailQuota["state"] {
  return typeof value === "string" && QUOTA_STATE_VALUES.has(value);
}

/**
 * Parse advisory quota headers from any model-proxy response (I9). The six
 * `X-CAIL-Quota-*` headers are all-or-none: if any member is absent,
 * malformed, negative, unsafe, or has an unknown state, the meter is
 * unavailable and this returns `null`. Header problems are NEVER errors.
 */
export function parseQuotaHeaders(headers: Headers): CailQuota | null {
  const limit = parseQuotaInteger(headers.get("X-CAIL-Quota-Limit"));
  const used = parseQuotaInteger(headers.get("X-CAIL-Quota-Used"));
  const remaining = parseQuotaInteger(headers.get("X-CAIL-Quota-Remaining"));
  const reset = parseQuotaInteger(headers.get("X-CAIL-Quota-Reset"));
  const windowSeconds = parseQuotaInteger(headers.get("X-CAIL-Quota-Window"));
  const state = headers.get("X-CAIL-Quota-State");

  if (
    limit === null ||
    used === null ||
    remaining === null ||
    reset === null ||
    windowSeconds === null ||
    !isQuotaState(state)
  ) {
    return null;
  }

  return {
    limit,
    used,
    remaining,
    reset,
    window_seconds: windowSeconds,
    state,
  };
}

/**
 * Validate + serialize `X-CAIL-Metadata` (I3). Throws a `CailError` (code
 * `"invalid_metadata"`, status 0 — a client-side validation error, never on the
 * wire) if the object breaks any rule. Returns the JSON string, or `null` when
 * there is nothing to send.
 */
function serializeMetadata(meta: CailMetadata): string {
  const keys = Object.keys(meta);
  if (keys.length > MAX_METADATA_KEYS) {
    throw new CailError(
      "invalid_metadata",
      `X-CAIL-Metadata may have at most ${MAX_METADATA_KEYS} keys (got ${keys.length}).`,
      0,
    );
  }
  for (const key of keys) {
    if (RESERVED_METADATA_KEYS.has(key)) {
      throw new CailError(
        "invalid_metadata",
        `X-CAIL-Metadata key "${key}" is reserved and cannot be set by the client.`,
        0,
      );
    }
    if (POLLUTION_METADATA_KEYS.has(key)) {
      throw new CailError(
        "invalid_metadata",
        `X-CAIL-Metadata key "${key}" is not allowed.`,
        0,
      );
    }
    const value = meta[key];
    const t = typeof value;
    if (t !== "string" && t !== "number") {
      throw new CailError(
        "invalid_metadata",
        `X-CAIL-Metadata value for "${key}" must be a string or number.`,
        0,
      );
    }
    if (t === "number" && !Number.isFinite(value as number)) {
      throw new CailError(
        "invalid_metadata",
        `X-CAIL-Metadata value for "${key}" must be a finite number.`,
        0,
      );
    }
    if (t === "string" && (value as string).length > MAX_METADATA_STRING_LEN) {
      throw new CailError(
        "invalid_metadata",
        `X-CAIL-Metadata string value for "${key}" exceeds ${MAX_METADATA_STRING_LEN} chars.`,
        0,
      );
    }
  }
  return JSON.stringify(meta);
}

/**
 * Browser default `onAuthRequired` (I6): redirect to the proxy-supplied
 * `login_url` (SAME-ORIGIN ONLY — open-redirect guard) or, failing that, to
 * `/login?rt=<current-path>`. A no-op off the browser (no `window`/`location`).
 */
export function browserAuthRedirect(err: CailError): void {
  const loc = (globalThis as { location?: Location }).location;
  if (!loc || typeof loc.href !== "string") return;

  const loginUrl = err.extras["login_url"];
  if (typeof loginUrl === "string" && loginUrl.length > 0) {
    // Same-origin guard: resolve against the current origin and reject any
    // destination that lands on a different origin (open-redirect defense, Q3).
    try {
      const resolved = new URL(loginUrl, loc.href);
      if (resolved.origin === loc.origin) {
        loc.href = resolved.href;
        return;
      }
    } catch {
      // fall through to the safe default
    }
  }

  const rt = `${loc.pathname}${loc.search}`;
  loc.href = `/login?rt=${encodeURIComponent(rt)}`;
}

/** Case-insensitively delete a header from a plain `Record` (Headers handles its own casing). */
function deleteHeaderCI(record: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) delete record[key];
  }
}

/**
 * Normalize any `HeadersInit` (Headers | array | record | undefined) into a
 * mutable plain `Record<string,string>`, preserving the caller's entries so we
 * can then apply credential + CAIL headers deterministically.
 */
function toHeaderRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (typeof Headers !== "undefined" && init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(init)) {
    for (const [key, value] of init) {
      let existingKey: string | undefined;
      for (const k of Object.keys(out)) {
        if (k.toLowerCase() === key.toLowerCase()) {
          existingKey = k;
          break;
        }
      }
      if (existingKey !== undefined) {
        out[existingKey] = `${out[existingKey]}, ${value}`;
      } else {
        out[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(init)) out[key] = value;
  }
  return out;
}

/** Extract an existing `X-CAIL-Metadata` string from a header record, if present. */
function existingMetadataHeader(
  record: Record<string, string>,
): string | undefined {
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === "x-cail-metadata") return record[key];
  }
  return undefined;
}

function isRetriableNetworkError(err: unknown): boolean {
  // A thrown error from fetch (DNS/connect/reset) — not a CailError we minted.
  return !(err instanceof CailError);
}

function backoffDelayMs(attempt: number): number {
  // attempt is 0-based for the first retry. Exponential base 200ms, capped.
  return Math.min(200 * 2 ** attempt, 2000);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelayMs(response: Response, attempt: number): number {
  const backoff = backoffDelayMs(attempt);
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter === null || !/^\d+$/.test(retryAfter)) return backoff;
  const seconds = Number(retryAfter);
  return Math.min(Math.max(backoff, seconds * 1000), 10_000);
}

function isReadableStreamBody(body: RequestInit["body"] | undefined): boolean {
  return (
    typeof ReadableStream !== "undefined" && body instanceof ReadableStream
  );
}

function addRetryAfterExtra(
  response: Response,
  extras: Record<string, unknown>,
): void {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter !== null && !("retry_after" in extras)) {
    extras["retry_after"] = retryAfter;
  }
}

/**
 * Parse a non-2xx `Response` into a `CailError` (I4). The envelope
 * `{error, message, ...extras}` is honored verbatim; a non-JSON or
 * shape-invalid body yields `code:"unknown_error"` with a generic message —
 * never swallowed as success.
 *
 * Exported for tools that want the same parsing without the full client (e.g.
 * to classify an error from a raw `Response`).
 */
export async function parseCailError(response: Response): Promise<CailError> {
  const status = response.status;
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      (err as { name?: unknown }).name === "AbortError"
    ) {
      throw err;
    }
    bodyText = "";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>)["error"] === "string" &&
    typeof (parsed as Record<string, unknown>)["message"] === "string"
  ) {
    const obj = parsed as Record<string, unknown>;
    const code = obj["error"] as string;
    const message = obj["message"] as string;
    const extras: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (key !== "error" && key !== "message") extras[key] = obj[key];
    }
    // Preserve the Retry-After header alongside the envelope (INTEGRATION.md §2).
    addRetryAfterExtra(response, extras);
    return new CailError(code, message, status, extras);
  }

  // Non-JSON / shape-invalid body: NOT swallowed, NOT thrown away (I4).
  const extras: Record<string, unknown> = {};
  addRetryAfterExtra(response, extras);
  return new CailError(
    "unknown_error",
    `The CAIL backbone returned an unexpected response (status ${status}).`,
    status,
    extras,
  );
}

function quotaBodyUnknownError(status: number): CailError {
  return new CailError(
    "unknown_error",
    `The CAIL backbone returned an unexpected quota response (status ${status}).`,
    status,
  );
}

function quotaBodyInteger(
  obj: Record<string, unknown>,
  key: string,
): number | null {
  const value = obj[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return null;
  }
  return value;
}

function parseQuotaSnapshotBody(
  body: unknown,
  status: number,
): CailQuotaSnapshot {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw quotaBodyUnknownError(status);
  }

  const obj = body as Record<string, unknown>;
  const limit = quotaBodyInteger(obj, "limit");
  const used = quotaBodyInteger(obj, "used");
  const remaining = quotaBodyInteger(obj, "remaining");
  const reset = quotaBodyInteger(obj, "reset");
  const windowSeconds = quotaBodyInteger(obj, "window_seconds");
  const asOf = quotaBodyInteger(obj, "as_of");
  const state = obj["state"];

  if (
    obj["object"] !== "quota" ||
    typeof obj["subject"] !== "string" ||
    typeof obj["enforced"] !== "boolean" ||
    limit === null ||
    used === null ||
    remaining === null ||
    reset === null ||
    windowSeconds === null ||
    asOf === null ||
    !isQuotaState(state)
  ) {
    throw quotaBodyUnknownError(status);
  }

  return {
    subject: obj["subject"],
    limit,
    used,
    remaining,
    reset,
    window_seconds: windowSeconds,
    state,
    enforced: obj["enforced"],
    as_of: asOf,
  };
}

/** Is this a browser-like environment (used to pick the default 401 hook)? */
function inBrowser(): boolean {
  const g = globalThis as { location?: unknown; document?: unknown };
  return typeof g.location !== "undefined" && typeof g.document !== "undefined";
}

/**
 * Build a CAIL model-proxy client. Validates the `app` slug at construction
 * (I2) — an invalid slug throws immediately (fail fast) rather than at call time.
 */
export function createCailClient(opts: CailClientOptions): CailClient {
  if (typeof opts !== "object" || opts === null) {
    throw new CailError(
      "invalid_config",
      "createCailClient requires an options object.",
      0,
    );
  }
  if (typeof opts.baseUrl !== "string" || opts.baseUrl.length === 0) {
    throw new CailError(
      "invalid_config",
      "createCailClient requires a non-empty `baseUrl`.",
      0,
    );
  }
  if (typeof opts.app !== "string" || !APP_SLUG_RE.test(opts.app)) {
    throw new CailError(
      "invalid_config",
      `Invalid X-CAIL-App slug ${JSON.stringify(
        opts.app,
      )}: must match /^[a-z0-9][a-z0-9-]{0,63}$/ (low-cardinality, per-tool).`,
      0,
    );
  }

  const app = opts.app;
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  if (typeof fetchImpl !== "function") {
    throw new CailError(
      "invalid_config",
      "No `fetch` available: pass `fetchImpl` in this runtime.",
      0,
    );
  }
  const maxRetries =
    typeof opts.maxRetries === "number" &&
    Number.isFinite(opts.maxRetries) &&
    opts.maxRetries >= 0
      ? Math.floor(opts.maxRetries)
      : 2;
  const onAuthRequired =
    opts.onAuthRequired ?? (inBrowser() ? browserAuthRedirect : undefined);

  async function call(
    path: string,
    init: RequestInit,
    credential: CailCredential,
    options?: CailCallOptions,
    internal?: { retry5xx?: boolean },
  ): Promise<Response> {
    if (
      typeof credential !== "object" ||
      credential === null ||
      (credential.kind !== "jwt" && credential.kind !== "key") ||
      typeof credential.token !== "string"
    ) {
      throw new CailError(
        "invalid_credential",
        'call() requires a credential { kind: "jwt" | "key", token: string }.',
        0,
      );
    }
    if (
      credential.token.length === 0 ||
      CREDENTIAL_CONTROL_CHAR_RE.test(credential.token)
    ) {
      throw new CailError(
        "invalid_credential",
        "Credential token must be non-empty and contain no control characters.",
        0,
      );
    }

    const headers = toHeaderRecord(init.headers);

    // I1 — exactly one credential on the wire.
    if (credential.kind === "jwt") {
      // Strip ANY Authorization the caller/SDK injected (the dummy-bearer
      // footgun): the proxy is JWT-first-strict, so a stray bearer must not
      // reach the wire.
      deleteHeaderCI(headers, "Authorization");
      deleteHeaderCI(headers, "X-CAIL-Identity-JWT");
      headers["X-CAIL-Identity-JWT"] = credential.token;
    } else {
      // key path — bearer only, never the JWT header.
      deleteHeaderCI(headers, "Authorization");
      deleteHeaderCI(headers, "X-CAIL-Identity-JWT");
      headers["Authorization"] = `Bearer ${credential.token}`;
    }

    // I2 — X-CAIL-App is always the constructed slug (caller cannot override it).
    deleteHeaderCI(headers, "X-CAIL-App");
    headers["X-CAIL-App"] = app;

    // I3 — X-CAIL-Metadata: merge per-call `options.metadata` over any header
    // already present, validate, serialize.
    const headerMeta = existingMetadataHeader(headers);
    let merged: CailMetadata | undefined;
    if (headerMeta !== undefined || options?.metadata !== undefined) {
      merged = Object.create(null) as CailMetadata;
      if (headerMeta !== undefined) {
        let base: unknown;
        try {
          base = JSON.parse(headerMeta);
        } catch {
          throw new CailError(
            "invalid_metadata",
            "Existing X-CAIL-Metadata header is not valid JSON.",
            0,
          );
        }
        if (
          typeof base !== "object" ||
          base === null ||
          Array.isArray(base)
        ) {
          throw new CailError(
            "invalid_metadata",
            "X-CAIL-Metadata must be a JSON object.",
            0,
          );
        }
        Object.assign(merged, base as Record<string, unknown>);
      }
      if (options?.metadata !== undefined) {
        Object.assign(merged, options.metadata);
      }
    }
    deleteHeaderCI(headers, "X-CAIL-Metadata");
    if (merged !== undefined) {
      headers["X-CAIL-Metadata"] = serializeMetadata(merged);
    }

    const url = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    // I8 — body + model forwarded verbatim: we never touch init.body.
    const signal = init.signal;
    const hasNonReplayableBody = isReadableStreamBody(init.body);
    const retry5xx = internal?.retry5xx !== false;
    const requestInit: RequestInit = { ...init, headers, redirect: "manual" };

    let attempt = 0;
    // Total tries = 1 + maxRetries.
    for (;;) {
      let response: Response;
      try {
        response = await fetchImpl(url, requestInit);
      } catch (err) {
        if (signal?.aborted) throw err;
        // Network/transport error (I5): retry up to maxRetries, else throw.
        if (
          !hasNonReplayableBody &&
          isRetriableNetworkError(err) &&
          attempt < maxRetries
        ) {
          await sleep(backoffDelayMs(attempt), signal);
          attempt++;
          continue;
        }
        throw new CailError(
          "network_error",
          err instanceof Error && err.message
            ? err.message
            : "Network request to the CAIL backbone failed.",
          0,
        );
      }

      // A redirect from the proxy is never a valid model-proxy response. With
      // redirect:"manual" the platform surfaces it as an opaque redirect
      // (status 0); a mock/transport may surface the raw 3xx. Either way: do NOT
      // follow (would leak X-CAIL-Identity-JWT cross-origin) and do NOT treat as
      // success — throw immediately, no retry.
      if (
        (response as { type?: string }).type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
      ) {
        throw new CailError(
          "unexpected_redirect",
          `The CAIL backbone returned a redirect (status ${response.status}), which is never a valid model-proxy response.`,
          response.status,
        );
      }

      // I7 — 2xx passthrough by reference, body NOT buffered.
      if (response.status >= 200 && response.status < 300) {
        return response;
      }

      // I5 — retry policy: NEVER 4xx; retry 5xx up to maxRetries.
      const is5xx = response.status >= 500 && response.status < 600;
      if (
        is5xx &&
        retry5xx &&
        !hasNonReplayableBody &&
        attempt < maxRetries
      ) {
        // Drain the failed response body so the connection can be reused.
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        await sleep(retryDelayMs(response, attempt), signal);
        attempt++;
        continue;
      }

      // I4 — non-2xx (and non-retriable, or retries exhausted) → typed error.
      const error = await parseCailError(response);

      // I6 — 401 authentication_required hook, then still throw.
      if (
        error.status === 401 &&
        error.code === "authentication_required" &&
        onAuthRequired
      ) {
        try {
          onAuthRequired(error);
        } catch {
          // The hook is advisory; it must never mask the backbone error.
        }
      }

      throw error;
    }
  }

  async function getQuota(
    credential: CailCredential,
  ): Promise<CailQuotaSnapshot> {
    const response = await call(
      "/quota",
      { method: "GET" },
      credential,
      undefined,
      { retry5xx: false },
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw quotaBodyUnknownError(response.status);
    }
    return parseQuotaSnapshotBody(body, response.status);
  }

  return { call, getQuota };
}
