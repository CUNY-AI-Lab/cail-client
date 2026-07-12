/**
 * @cuny-ai-lab/cail-client — the CAIL model-proxy API client.
 *
 * The consumer-side twin of `@cuny-ai-lab/cail-identity`: the one library CUNY
 * applications use to *call* the model proxy correctly. It owns the credential
 * / header / error / retry contract from `docs/INTEGRATION.md` §1–2 so no
 * application re-derives them. Consumers include independent CUNY apps and
 * scripts, Kale apps, and centrally hosted CAIL tools.
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
 *   - Never retry ordinary 4xx. Eligible calls retry 5xx + network up to
 *     `maxRetries`, subject to the gateway's `x-should-retry` decision;
 *     chat/SSE stays single-attempt (I5).
 *   - `401 authentication_required` invokes `onAuthRequired`, then still throws
 *     (I6).
 *   - 2xx `Response` returned by reference, body NOT buffered (I7).
 *   - `run()` and `chatCompletions()` own the canonical model endpoints (I8):
 *     buffered `POST /v1/run` `{model,input}` and OpenAI-shaped
 *     `POST /v1/chat/completions` (streaming-capable — the 2xx `Response`
 *     passes through by reference per I7, so SSE flows untouched).
 *     `chatFetch()` adapts the chat endpoint for OpenAI-style SDKs with raw
 *     fetch semantics (non-2xx returned, not thrown; no client-side retries —
 *     the SDK owns those).
 *   - Quota headers are advisory and all-or-none: absent/malformed quota
 *     headers mean "meter unavailable", never a client error (I9).
 *
 * The public surface is `string`/`number`/plain-object/`Response` only — no
 * ambient platform (`DOM`/Workers) types leak out of the `.d.ts`.
 */

import {
  outboundCorrelationHeaders,
  TRACEPARENT_HEADER,
  CAIL_REQUEST_ID_HEADER,
  type CailCorrelation,
} from "@cuny-ai-lab/cail-log";

/**
 * The fleet correlation contract, re-exported VERBATIM from
 * `@cuny-ai-lab/cail-log` so consumers have one source of truth where their
 * fleet requests originate: adopt inbound ids with
 * {@link correlationFromHeaders}, forward them with
 * {@link outboundCorrelationHeaders} (or by passing `correlation` in
 * {@link CailCallOptions} and letting the client attach the headers).
 */
export {
  correlationFromHeaders,
  outboundCorrelationHeaders,
  TRACEPARENT_HEADER,
  CAIL_REQUEST_ID_HEADER,
} from "@cuny-ai-lab/cail-log";
export type { CailCorrelation, CailHeadersLike } from "@cuny-ai-lab/cail-log";

/** Credential forwarded on a call. Exactly one kind reaches the wire (I1). */
export type CailCredential =
  { kind: "jwt"; token: string } | { kind: "key"; token: string };

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
  /** The precise envelope code, e.g. `"quota_exceeded"`. */
  readonly code: string;
  /** The broad OpenAI-compatible error category. */
  readonly type: string;
  /** The invalid request field when known. */
  readonly param: string | null;
  /** HTTP status; `0` for a network/transport failure with no response. */
  readonly status: number;
  /** CAIL-specific fields from `error.cail`, plus advisory response metadata. */
  readonly extras: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    extras: Record<string, unknown> = {},
    type = "unknown_error",
    param: string | null = null,
  ) {
    super(message);
    this.name = "CailError";
    this.code = code;
    this.type = type;
    this.param = param;
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
  /**
   * Max retries for eligible non-model and idempotency-keyed buffered model
   * 5xx + network errors (I5). Default 2. Never applies to 4xx, streaming
   * model POSTs, or generic non-idempotent calls (POST/PATCH) that carry no
   * `Idempotency-Key`. A PRESENT value
   * must be a finite integer >= 0 — anything else throws `invalid_config` at
   * construction (fail loud, matching `baseUrl`/`app`/`fetchImpl`; invalid
   * config is never silently coerced).
   */
  maxRetries?: number;
}

export interface CailCallOptions {
  /** Per-call spend metadata (I3), merged over any `X-CAIL-Metadata` already in `init.headers`. */
  metadata?: CailMetadata;
  /**
   * Optional correlation to forward downstream (the cail-log contract). When
   * present, the client attaches `traceparent` + `X-CAIL-Request-Id` via
   * `outboundCorrelationHeaders(correlation)` so the gateway/Workers can adopt
   * the trace. Typically obtained from `correlationFromHeaders(request)` at
   * the consuming app's own request boundary. Absent → no correlation headers
   * are added (no behavior change). A malformed value throws a `CailError`
   * (code `"invalid_correlation"`, status 0) before anything hits the wire.
   */
  correlation?: CailCorrelation;
}

/** The canonical model request accepted by `POST /v1/run`. */
export interface CailRunRequest {
  model: string;
  input: unknown;
}

/** Options accepted by {@link CailClient.run} — the shared call options plus run-only knobs. */
export interface CailRunOptions extends CailCallOptions {
  /**
   * Caller-supplied UUID v4 `Idempotency-Key` for the buffered run. Lets an
   * app dedupe the SAME logical run across its own restarts/timeouts, beyond
   * the per-call UUID v4 the client mints by default. Reused verbatim on every
   * retry attempt; any non-UUID-v4 value is rejected before fetch.
   */
  idempotencyKey?: string;
}

/**
 * The OpenAI-compatible chat request accepted by `POST /v1/chat/completions`.
 * Extra OpenAI parameters (`temperature`, `max_tokens`, `tools`,
 * `stream_options`, …) pass through verbatim; the gateway force-injects
 * `stream_options.include_usage` on streams for its own metering.
 */
export interface CailChatRequest {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface CailClient {
  /**
   * Run a model through the canonical `POST /v1/run` endpoint. The request
   * body is serialized as exactly `{ model, input }`.
   */
  run(
    request: CailRunRequest,
    credential: CailCredential,
    options?: CailRunOptions,
  ): Promise<Response>;

  /**
   * Run an OpenAI-compatible chat call through `POST /v1/chat/completions`.
   * With `stream: true` the returned 2xx `Response` body is the live SSE
   * stream (I7 — by reference, never buffered): read `chat.completion.chunk`
   * events until `data: [DONE]`. Non-2xx throws the usual {@link CailError}.
   */
  chatCompletions(
    request: CailChatRequest,
    credential: CailCredential,
    options?: CailCallOptions,
  ): Promise<Response>;

  /**
   * Build a `fetch`-shaped adapter for OpenAI-style SDKs (e.g. the Vercel AI
   * SDK's `createOpenAICompatible({ fetch })`): it enforces the credential /
   * app / metadata discipline (I1–I3) and the redirect protection, but keeps
   * RAW FETCH SEMANTICS — non-2xx responses are returned (not thrown) and the
   * client never retries (the SDK owns retry policy). It serves ONLY
   * `POST {baseUrl}/v1/chat/completions`; any other URL throws, catching SDK
   * base-URL misconfiguration loudly. The 401 `onAuthRequired` hook still
   * fires (on a cloned body) before the response is returned.
   */
  chatFetch(
    credential: CailCredential,
    options?: CailCallOptions,
  ): (input: string | URL, init?: RequestInit) => Promise<Response>;

  /**
   * Call a non-model gateway endpoint such as `/v1/models`, `/quota`, or key
   * delegation. Model invocation belongs in {@link run} /
   * {@link chatCompletions}.
   *
   * @param path   joined onto `baseUrl`.
   * @param init   method, body, and headers for the gateway endpoint.
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
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

/**
 * HTTP methods that are idempotent by definition (RFC 9110 §9.2.2 / MDN):
 * safe to retry without an idempotency key. POST and PATCH are NOT here —
 * retrying them without an `Idempotency-Key` risks duplicate side effects
 * (Stripe idempotent requests; IETF draft-ietf-httpapi-idempotency-key-header).
 */
const IDEMPOTENT_HTTP_METHODS = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "OPTIONS",
  "TRACE",
]);

/** Uniform random fraction in [0, 1) from Web Crypto (the client's RNG everywhere). */
function randomFraction(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}

/**
 * UUID v4 via `crypto.randomUUID` where available; otherwise built from
 * `getRandomValues` — browsers expose `randomUUID` only in SECURE contexts,
 * and `run()` must not throw a raw TypeError on plain-HTTP dev origins. Same
 * fallback cail-log uses to mint request ids.
 */
function mintIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function backoffDelayMs(attempt: number): number {
  // attempt is 0-based for the first retry. FULL JITTER per the AWS Builders'
  // Library ("Timeouts, retries, and backoff with jitter"):
  // delay = random(0, min(cap, base·2^attempt)) — desynchronizes retrying
  // clients so a shared outage doesn't produce a thundering herd.
  return randomFraction() * Math.min(200 * 2 ** attempt, 2000);
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

/**
 * Ceiling on how long a server `Retry-After` hint can hold a retry. RFC 9110
 * §10.2.3 lets the server ask for an arbitrary wait; we honor it up to 30s —
 * three windows of the old 10s cap, still bounded for interactive tools (a
 * hint longer than 30s is a "come back later" the caller should surface, not
 * a delay worth silently sitting on; peer SDKs cap at 30–60s or drop the hint
 * entirely). Hints at or under the ceiling are honored in full — the client
 * never retries earlier than the server asked.
 */
const RETRY_AFTER_CAP_MS = 30_000;

function retryDelayMs(response: Response, attempt: number): number {
  const backoff = backoffDelayMs(attempt);
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter === null) return backoff;
  // RFC 9110 §10.2.3: Retry-After = HTTP-date / delay-seconds.
  let hintMs: number | null = null;
  if (/^\d+$/.test(retryAfter)) {
    hintMs = Number(retryAfter) * 1000;
  } else {
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) hintMs = Math.max(0, dateMs - Date.now());
  }
  if (hintMs === null) return backoff; // malformed hint → jittered backoff
  return Math.min(Math.max(backoff, hintMs), RETRY_AFTER_CAP_MS);
}

function shouldRetryHeader(response: Response): boolean | null {
  const value = response.headers.get("x-should-retry")?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadableStreamBody(body: RequestInit["body"] | undefined): boolean {
  return (
    typeof ReadableStream !== "undefined" && body instanceof ReadableStream
  );
}

function addResponseMetadataExtras(
  response: Response,
  extras: Record<string, unknown>,
): void {
  const requestId = response.headers.get("x-request-id");
  if (requestId !== null && !("request_id" in extras)) {
    extras["request_id"] = requestId;
  }
  const shouldRetry = shouldRetryHeader(response);
  if (shouldRetry !== null && !("should_retry" in extras)) {
    extras["should_retry"] = shouldRetry;
  }
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter !== null && !("retry_after" in extras)) {
    extras["retry_after"] = retryAfter;
  }
}

/**
 * Parse a non-2xx `Response` into a `CailError` (I4). The envelope
 * `{error:{message,type,param,code,cail?}}` is honored verbatim; a non-JSON or
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

  if (isRecord(parsed) && isRecord(parsed["error"])) {
    const error = parsed["error"];
    const cail = error["cail"];
    const param = error["param"];
    const validCail = cail === undefined || isRecord(cail);
    const validParam = param === null || typeof param === "string";
    if (
      typeof error["message"] === "string" &&
      typeof error["type"] === "string" &&
      typeof error["code"] === "string" &&
      validParam &&
      validCail
    ) {
      const extras: Record<string, unknown> =
        cail === undefined ? {} : { ...cail };
      // Preserve Retry-After alongside the CAIL extension fields.
      addResponseMetadataExtras(response, extras);
      return new CailError(
        error["code"],
        error["message"],
        status,
        extras,
        error["type"],
        param as string | null,
      );
    }
  }

  // Non-JSON / shape-invalid body: NOT swallowed, NOT thrown away (I4).
  const extras: Record<string, unknown> = {};
  addResponseMetadataExtras(response, extras);
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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
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
  // Fail loud at construction on a garbage base URL (same posture as `app` /
  // `maxRetries`): otherwise it only surfaces later, per call, disguised as a
  // `network_error`.
  try {
    new URL(opts.baseUrl);
  } catch {
    throw new CailError(
      "invalid_config",
      `createCailClient requires an absolute \`baseUrl\` URL; ${JSON.stringify(
        opts.baseUrl,
      )} does not parse (new URL threw).`,
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
  // Invalid-config posture (aligned with the sibling fields above and with the
  // cail-identity twin's non-finite `now`/`clockToleranceSeconds` rejection):
  // absent means "use the default", but a PRESENT invalid value fails loud —
  // it is never silently coerced to the default.
  let maxRetries: number;
  if (opts.maxRetries === undefined) {
    maxRetries = 2;
  } else if (
    typeof opts.maxRetries !== "number" ||
    !Number.isInteger(opts.maxRetries) ||
    opts.maxRetries < 0
  ) {
    throw new CailError(
      "invalid_config",
      "`maxRetries` must be a finite integer >= 0 when present (omit it for the default of 2).",
      0,
    );
  } else {
    maxRetries = opts.maxRetries;
  }
  const onAuthRequired =
    opts.onAuthRequired ?? (inBrowser() ? browserAuthRedirect : undefined);

  async function call(
    path: string,
    init: RequestInit,
    credential: CailCredential,
    options?: CailCallOptions,
    internal?: {
      retry5xx?: boolean;
      modelRun?: boolean;
      idempotentModelRun?: boolean;
      raw?: boolean;
    },
  ): Promise<Response> {
    if (
      (path === "/v1/run" || path === "/v1/chat/completions") &&
      internal?.modelRun !== true
    ) {
      throw new CailError(
        "invalid_request",
        "Use run() or chatCompletions() for model invocation.",
        0,
      );
    }

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
        if (typeof base !== "object" || base === null || Array.isArray(base)) {
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

    // Optional correlation forwarding (the cail-log contract): attach
    // `traceparent` + `X-CAIL-Request-Id` so the next hop can ADOPT this
    // trace. Applied once, before any transport attempt — retries of the same
    // logical request deliberately carry the same correlation. Absent → no
    // headers added, no behavior change.
    if (options?.correlation !== undefined) {
      let correlationHeaders: Record<string, string>;
      try {
        correlationHeaders = outboundCorrelationHeaders(options.correlation);
      } catch (err) {
        // cail-log throws TypeError on a malformed correlation (forwarding a
        // broken id would silently fork the trace); surface it in this
        // client's error vocabulary, client-side (status 0), nothing on the wire.
        throw new CailError(
          "invalid_correlation",
          err instanceof Error && err.message
            ? err.message
            : "Invalid correlation: expected { trace_id, span_id, request_id } from correlationFromHeaders().",
          0,
        );
      }
      deleteHeaderCI(headers, TRACEPARENT_HEADER);
      deleteHeaderCI(headers, CAIL_REQUEST_ID_HEADER);
      Object.assign(headers, correlationHeaders);
    }

    const url = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    // I8 — body + model forwarded verbatim: we never touch init.body.
    const signal = init.signal;
    const hasNonReplayableBody = isReadableStreamBody(init.body);
    const retry5xx = internal?.retry5xx !== false;

    // Retry safety for the generic path: a non-idempotent method (POST/PATCH —
    // MDN "Idempotent") is only retried when an `Idempotency-Key` travels with
    // the request (caller-supplied here, or minted by run()), per Stripe's
    // idempotent-requests contract and IETF
    // draft-ietf-httpapi-idempotency-key-header. Without a key, a network/5xx
    // retry of e.g. `POST /keys` could duplicate the side effect. Idempotent
    // methods (GET/HEAD/PUT/DELETE) retry as before. The billed model paths
    // keep their own stricter gate (`modelRun`/`idempotentModelRun`) below.
    const method = (init.method ?? "GET").toUpperCase();
    let wireIdempotencyKey: string | undefined;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "idempotency-key" && headers[key]!.length > 0) {
        wireIdempotencyKey = headers[key];
        break;
      }
    }
    const retrySafeMethod =
      IDEMPOTENT_HTTP_METHODS.has(method) || wireIdempotencyKey !== undefined;
    const requestInit: RequestInit = { ...init, headers, redirect: "manual" };

    let attempt = 0;
    // Total tries = 1 + maxRetries.
    for (;;) {
      let response: Response;
      try {
        response = await fetchImpl(url, requestInit);
      } catch (err) {
        if (signal?.aborted) throw err;
        // Raw mode (chatFetch): preserve fetch semantics — the SDK recognizes
        // its platform's own network errors; a CailError wrap would not be
        // retried by it. No client-side retry either (the SDK owns those).
        if (internal?.raw === true) throw err;
        // Network/transport error (I5): retry up to maxRetries, else throw.
        if (
          (internal?.modelRun !== true ||
            internal?.idempotentModelRun === true) &&
          retrySafeMethod &&
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

      // Raw mode (chatFetch): non-2xx is RETURNED, not thrown — the SDK parses
      // provider error bodies and owns retry/backoff. The 401 hook (I6) still
      // fires so browser tools can bounce to login; it inspects a CLONE so the
      // body the SDK reads stays intact.
      //
      // ONE carve-out: a 429 `quota_exceeded` envelope THROWS the CailError
      // instead. AI SDKs treat any 429 Response as retryable, but a CAIL quota
      // 429 resets on a budget window, not a rate blip — retrying it can only
      // burn attempts and then bury the envelope inside the SDK's RetryError
      // (the fleet's known quota-surfacing bug). A thrown CailError is not a
      // type any SDK retries, so the verbatim quota message (with
      // extras.retry_after_seconds) surfaces on the first failure.
      if (internal?.raw === true) {
        if (response.status === 401 && onAuthRequired) {
          try {
            const peek = await parseCailError(response.clone());
            if (peek.code === "authentication_required") onAuthRequired(peek);
          } catch {
            // Advisory only; never mask the response.
          }
        }
        if (response.status === 429) {
          let peek: CailError | null = null;
          try {
            peek = await parseCailError(response.clone());
          } catch {
            // Unreadable 429 body: return it raw.
          }
          if (peek?.code === "quota_exceeded") throw peek;
        }
        return response;
      }

      // A transport retry can reach the gateway while the original buffered
      // request is still completing. Only this explicit idempotency conflict is
      // retryable; ordinary 4xx responses remain final.
      if (
        response.status === 409 &&
        shouldRetryHeader(response) !== false &&
        internal?.idempotentModelRun === true &&
        !hasNonReplayableBody &&
        attempt < maxRetries
      ) {
        let conflict: CailError | null = null;
        try {
          conflict = await parseCailError(response.clone());
        } catch {
          // An unreadable conflict is handled as an ordinary non-2xx below.
        }
        if (conflict?.code === "idempotency_in_progress") {
          try {
            await response.body?.cancel();
          } catch {
            /* ignore */
          }
          await sleep(retryDelayMs(response, attempt), signal);
          attempt++;
          continue;
        }
      }

      // I5 — retry eligible 5xx unless the gateway explicitly forbids it.
      const is5xx = response.status >= 500 && response.status < 600;
      if (
        is5xx &&
        shouldRetryHeader(response) !== false &&
        (internal?.modelRun !== true ||
          internal?.idempotentModelRun === true) &&
        retrySafeMethod &&
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

  async function run(
    request: CailRunRequest,
    credential: CailCredential,
    options?: CailRunOptions,
  ): Promise<Response> {
    if (
      typeof request !== "object" ||
      request === null ||
      typeof request.model !== "string" ||
      request.model.length === 0 ||
      !("input" in request) ||
      request.input === undefined
    ) {
      throw new CailError(
        "invalid_request",
        "run() requires { model: string, input }.",
        0,
      );
    }

    if (
      options?.idempotencyKey !== undefined &&
      (typeof options.idempotencyKey !== "string" ||
        !UUID_V4_RE.test(options.idempotencyKey))
    ) {
      throw new CailError(
        "invalid_request",
        "run() options.idempotencyKey must be a UUID v4.",
        0,
      );
    }

    let body: string;
    try {
      body = JSON.stringify({ model: request.model, input: request.input });
    } catch {
      throw new CailError(
        "invalid_request",
        "run() input must be JSON-serializable.",
        0,
      );
    }

    return call(
      "/v1/run",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": options?.idempotencyKey ?? mintIdempotencyKey(),
        },
        body,
      },
      credential,
      options,
      { modelRun: true, idempotentModelRun: true },
    );
  }

  async function chatCompletions(
    request: CailChatRequest,
    credential: CailCredential,
    options?: CailCallOptions,
  ): Promise<Response> {
    if (
      typeof request !== "object" ||
      request === null ||
      typeof request.model !== "string" ||
      request.model.length === 0 ||
      !Array.isArray(request.messages) ||
      (request.stream !== undefined && typeof request.stream !== "boolean")
    ) {
      throw new CailError(
        "invalid_request",
        "chatCompletions() requires { model: string, messages: unknown[] } with optional boolean stream.",
        0,
      );
    }

    let body: string;
    try {
      body = JSON.stringify(request);
    } catch {
      throw new CailError(
        "invalid_request",
        "chatCompletions() request must be JSON-serializable.",
        0,
      );
    }

    return call(
      "/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      },
      credential,
      options,
      { modelRun: true },
    );
  }

  function chatFetch(
    credential: CailCredential,
    options?: CailCallOptions,
  ): (input: string | URL, init?: RequestInit) => Promise<Response> {
    const target = `${baseUrl}/v1/chat/completions`;
    return async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : undefined;
      if (url !== target) {
        throw new CailError(
          "invalid_request",
          `chatFetch() serves only POST ${target}; got ${String(url ?? input)}. ` +
            "Point the SDK baseURL at `${baseUrl}/v1` so it derives /v1/chat/completions.",
          0,
        );
      }
      return call("/v1/chat/completions", init ?? {}, credential, options, {
        modelRun: true,
        raw: true,
        retry5xx: false,
      });
    };
  }

  return { run, chatCompletions, chatFetch, call, getQuota };
}
