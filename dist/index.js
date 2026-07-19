/**
 * @cuny-ai-lab/cail-client — the CAIL model-proxy API client.
 *
 * The consumer-side twin of `@cuny-ai-lab/cail-identity`: the one library CUNY
 * applications use to *call* the model proxy correctly. It owns the credential
 * / header / error / retry contract so no
 * application re-derives them. Consumers include independent CUNY apps and
 * scripts, Kale apps, and centrally hosted CAIL tools.
 *
 * Design contract (see README, invariants I1–I9):
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
 *     `chatFetch()` adapts the chat endpoint for OpenAI-style SDKs without
 *     adding client-side retries. Gateway-declared non-retryable errors throw
 *     by default so SDK status heuristics cannot replay an ambiguous request.
 *   - Quota headers are advisory and all-or-none: absent/malformed quota
 *     headers mean "meter unavailable", never a client error (I9).
 *
 * The public surface uses Web-standard fetch, Request, Response, and
 * AbortSignal types supported by browsers, Workers, and Node >=20.
 */
import { outboundCorrelationHeaders, TRACEPARENT_HEADER, TRACESTATE_HEADER, CAIL_REQUEST_ID_HEADER, } from "@cuny-ai-lab/cail-log";
/**
 * The fleet correlation contract, re-exported VERBATIM from
 * `@cuny-ai-lab/cail-log` so consumers have one source of truth where their
 * fleet requests originate: adopt inbound ids with
 * {@link correlationFromHeaders}, forward them with
 * {@link outboundCorrelationHeaders} (or by passing `correlation` in
 * {@link CailCallOptions} and letting the client attach the headers).
 */
export { correlationFromHeaders, outboundCorrelationHeaders, TRACEPARENT_HEADER, TRACESTATE_HEADER, CAIL_REQUEST_ID_HEADER, } from "@cuny-ai-lab/cail-log";
/**
 * A typed CAIL backbone error. Thrown by `call()` on any non-2xx response (I4)
 * and on retry exhaustion (I5). `message` is the envelope's `message` verbatim
 * — safe to show the user as-is (INTEGRATION.md §2).
 */
export class CailError extends Error {
    /** The precise envelope code, e.g. `"quota_exceeded"`. */
    code;
    /** The broad OpenAI-compatible error category. */
    type;
    /** The invalid request field when known. */
    param;
    /** HTTP status; `0` for a network/transport failure with no response. */
    status;
    /** CAIL-specific fields from `error.cail`, plus advisory response metadata. */
    extras;
    constructor(code, message, status, extras = {}, type = "unknown_error", param = null) {
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
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUOTA_STATE_VALUES = new Set(["ok", "stale"]);
const QUOTA_INTEGER_RE = /^\d+$/;
function parseQuotaInteger(value) {
    if (value === null || !QUOTA_INTEGER_RE.test(value))
        return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0)
        return null;
    return n;
}
function isQuotaState(value) {
    return typeof value === "string" && QUOTA_STATE_VALUES.has(value);
}
/**
 * Parse advisory quota headers from any model-proxy response (I9). The six
 * `X-CAIL-Quota-*` headers are all-or-none: if any member is absent,
 * malformed, negative, unsafe, or has an unknown state, the meter is
 * unavailable and this returns `null`. Header problems are NEVER errors.
 */
export function parseQuotaHeaders(headers) {
    const limit = parseQuotaInteger(headers.get("X-CAIL-Quota-Limit"));
    const used = parseQuotaInteger(headers.get("X-CAIL-Quota-Used"));
    const remaining = parseQuotaInteger(headers.get("X-CAIL-Quota-Remaining"));
    const reset = parseQuotaInteger(headers.get("X-CAIL-Quota-Reset"));
    const windowSeconds = parseQuotaInteger(headers.get("X-CAIL-Quota-Window"));
    const state = headers.get("X-CAIL-Quota-State");
    if (limit === null ||
        used === null ||
        remaining === null ||
        reset === null ||
        windowSeconds === null ||
        !isQuotaState(state)) {
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
function serializeMetadata(meta) {
    const keys = Object.keys(meta);
    if (keys.length > MAX_METADATA_KEYS) {
        throw new CailError("invalid_metadata", `X-CAIL-Metadata may have at most ${MAX_METADATA_KEYS} keys (got ${keys.length}).`, 0);
    }
    for (const key of keys) {
        if (RESERVED_METADATA_KEYS.has(key)) {
            throw new CailError("invalid_metadata", `X-CAIL-Metadata key "${key}" is reserved and cannot be set by the client.`, 0);
        }
        if (POLLUTION_METADATA_KEYS.has(key)) {
            throw new CailError("invalid_metadata", `X-CAIL-Metadata key "${key}" is not allowed.`, 0);
        }
        const value = meta[key];
        const t = typeof value;
        if (t !== "string" && t !== "number") {
            throw new CailError("invalid_metadata", `X-CAIL-Metadata value for "${key}" must be a string or number.`, 0);
        }
        if (t === "number" && !Number.isFinite(value)) {
            throw new CailError("invalid_metadata", `X-CAIL-Metadata value for "${key}" must be a finite number.`, 0);
        }
        if (t === "string" && value.length > MAX_METADATA_STRING_LEN) {
            throw new CailError("invalid_metadata", `X-CAIL-Metadata string value for "${key}" exceeds ${MAX_METADATA_STRING_LEN} chars.`, 0);
        }
    }
    return JSON.stringify(meta);
}
/**
 * Browser default `onAuthRequired` (I6): redirect to the proxy-supplied
 * `login_url` (SAME-ORIGIN ONLY — open-redirect guard) or, failing that, to
 * `/login?rt=<current-path>`. A no-op off the browser (no `window`/`location`).
 */
export function browserAuthRedirect(err) {
    const loc = globalThis.location;
    if (!loc || typeof loc.href !== "string")
        return;
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
        }
        catch {
            // fall through to the safe default
        }
    }
    const rt = `${loc.pathname}${loc.search}`;
    loc.href = `/login?rt=${encodeURIComponent(rt)}`;
}
/** Case-insensitively delete a header from a plain `Record` (Headers handles its own casing). */
function deleteHeaderCI(record, name) {
    const lower = name.toLowerCase();
    for (const key of Object.keys(record)) {
        if (key.toLowerCase() === lower)
            delete record[key];
    }
}
/**
 * Normalize any `HeadersInit` (Headers | array | record | undefined) into a
 * mutable plain `Record<string,string>`, preserving the caller's entries so we
 * can then apply credential + CAIL headers deterministically.
 */
function toHeaderRecord(init) {
    const out = {};
    if (!init)
        return out;
    if (typeof Headers !== "undefined" && init instanceof Headers) {
        init.forEach((value, key) => {
            out[key] = value;
        });
    }
    else if (Array.isArray(init)) {
        for (const [key, value] of init) {
            let existingKey;
            for (const k of Object.keys(out)) {
                if (k.toLowerCase() === key.toLowerCase()) {
                    existingKey = k;
                    break;
                }
            }
            if (existingKey !== undefined) {
                out[existingKey] = `${out[existingKey]}, ${value}`;
            }
            else {
                out[key] = value;
            }
        }
    }
    else {
        for (const [key, value] of Object.entries(init))
            out[key] = value;
    }
    return out;
}
/** Extract an existing `X-CAIL-Metadata` string from a header record, if present. */
function existingMetadataHeader(record) {
    for (const key of Object.keys(record)) {
        if (key.toLowerCase() === "x-cail-metadata")
            return record[key];
    }
    return undefined;
}
function isRetriableNetworkError(err) {
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
function randomFraction() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 2 ** 32;
}
/**
 * UUID v4 via `crypto.randomUUID` where available; otherwise built from
 * `getRandomValues` — browsers expose `randomUUID` only in SECURE contexts,
 * and `run()` must not throw a raw TypeError on plain-HTTP dev origins. Same
 * fallback cail-log uses to mint request ids.
 */
function mintIdempotencyKey() {
    if (typeof crypto.randomUUID === "function")
        return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function backoffDelayMs(attempt) {
    // attempt is 0-based for the first retry. FULL JITTER per the AWS Builders'
    // Library ("Timeouts, retries, and backoff with jitter"):
    // delay = random(0, min(cap, base·2^attempt)) — desynchronizes retrying
    // clients so a shared outage doesn't produce a thundering herd.
    return randomFraction() * Math.min(200 * 2 ** attempt, 2000);
}
function abortReason(signal) {
    if (signal.reason !== undefined)
        return signal.reason;
    if (typeof DOMException !== "undefined") {
        return new DOMException("The operation was aborted.", "AbortError");
    }
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    return err;
}
function sleep(ms, signal) {
    if (!signal)
        return new Promise((resolve) => setTimeout(resolve, ms));
    if (signal.aborted)
        return Promise.reject(abortReason(signal));
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
function retryDelayMs(response, attempt) {
    const backoff = backoffDelayMs(attempt);
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter === null)
        return backoff;
    // RFC 9110 §10.2.3: Retry-After = HTTP-date / delay-seconds.
    let hintMs = null;
    if (/^\d+$/.test(retryAfter)) {
        hintMs = Number(retryAfter) * 1000;
    }
    else {
        const dateMs = Date.parse(retryAfter);
        if (!Number.isNaN(dateMs))
            hintMs = Math.max(0, dateMs - Date.now());
    }
    if (hintMs === null)
        return backoff; // malformed hint → jittered backoff
    return Math.min(Math.max(backoff, hintMs), RETRY_AFTER_CAP_MS);
}
function shouldRetryHeader(response) {
    const value = response.headers.get("x-should-retry")?.trim().toLowerCase();
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return null;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isReadableStreamBody(body) {
    return (typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
}
function addResponseMetadataExtras(response, extras) {
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
export async function parseCailError(response) {
    const status = response.status;
    let bodyText;
    try {
        bodyText = await response.text();
    }
    catch (err) {
        if (err &&
            typeof err === "object" &&
            err.name === "AbortError") {
            throw err;
        }
        bodyText = "";
    }
    let parsed;
    try {
        parsed = JSON.parse(bodyText);
    }
    catch {
        parsed = undefined;
    }
    if (isRecord(parsed) && isRecord(parsed["error"])) {
        const error = parsed["error"];
        const cail = error["cail"];
        const param = error["param"];
        const validCail = cail === undefined || isRecord(cail);
        const validParam = param === null || typeof param === "string";
        if (typeof error["message"] === "string" &&
            typeof error["type"] === "string" &&
            typeof error["code"] === "string" &&
            validParam &&
            validCail) {
            const extras = cail === undefined ? {} : { ...cail };
            // Preserve Retry-After alongside the CAIL extension fields.
            addResponseMetadataExtras(response, extras);
            return new CailError(error["code"], error["message"], status, extras, error["type"], param);
        }
    }
    // Non-JSON / shape-invalid body: NOT swallowed, NOT thrown away (I4).
    const extras = {};
    addResponseMetadataExtras(response, extras);
    return new CailError("unknown_error", `The CAIL backbone returned an unexpected response (status ${status}).`, status, extras);
}
/** Try to parse a string as JSON; non-strings and unparseable strings pass through. */
function parseJsonLayer(value) {
    if (typeof value !== "string")
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
/** A plausible HTTP status carried on an SDK wrapper (`statusCode` / `status`). */
function wrapperStatus(record) {
    for (const key of ["statusCode", "status"]) {
        const value = record[key];
        if (typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 100 &&
            value <= 599) {
            return value;
        }
    }
    return undefined;
}
/**
 * Build a `CailError` from the wire envelope's inner `error` member
 * (`{message,type,param,code,cail?}`), or return `null` when the shape does
 * not match the contract. Mirrors the shape validation in
 * {@link parseCailError}.
 */
function cailErrorFromEnvelope(error, status) {
    const cail = error["cail"];
    const param = error["param"];
    const validCail = cail === undefined || isRecord(cail);
    const validParam = param === undefined || param === null || typeof param === "string";
    if (typeof error["message"] !== "string" ||
        typeof error["type"] !== "string" ||
        typeof error["code"] !== "string" ||
        !validParam ||
        !validCail) {
        return null;
    }
    return new CailError(error["code"], error["message"], status, cail === undefined ? {} : { ...cail }, error["type"], typeof param === "string" ? param : null);
}
/**
 * Recognize a bare CailError-shaped record — a `CailError` that lost its
 * prototype by crossing a bundle boundary, a structured clone, or the wire
 * envelope's inner `error` object reached directly. Requires string
 * `code` + `message` plus at least one corroborating CAIL marker so ordinary
 * platform errors (e.g. Node's `code: "ECONNRESET"`) never match.
 */
function cailErrorFromBareShape(record, fallbackStatus) {
    if (typeof record["code"] !== "string" ||
        typeof record["message"] !== "string") {
        return null;
    }
    const hasMarker = record["name"] === "CailError" ||
        isRecord(record["cail"]) ||
        isRecord(record["extras"]) ||
        (typeof record["status"] === "number" &&
            typeof record["type"] === "string");
    if (!hasMarker)
        return null;
    const status = typeof record["status"] === "number" &&
        Number.isInteger(record["status"]) &&
        record["status"] >= 0
        ? record["status"]
        : fallbackStatus;
    const extras = {
        ...(isRecord(record["cail"]) ? record["cail"] : {}),
        ...(isRecord(record["extras"]) ? record["extras"] : {}),
    };
    const param = record["param"];
    return new CailError(record["code"], record["message"], status, extras, typeof record["type"] === "string" ? record["type"] : "unknown_error", typeof param === "string" ? param : null);
}
/** Safety cap on layers visited by {@link extractCailError} (adversarial inputs). */
const EXTRACT_MAX_LAYERS = 256;
/**
 * Extract a `CailError` from an ALREADY-CONSUMED, possibly SDK-wrapped error
 * *object* — the counterpart to {@link parseCailError}, which needs the live
 * `Response`.
 *
 * AI SDKs bury the CAIL envelope: an `AI_RetryError` wraps `AI_APICallError`s
 * whose `responseBody` is the envelope as a JSON *string*, provider adapters
 * nest it under `cause`/`error`/`data`, and retry wrappers keep `lastError` +
 * `errors[]` arrays. This walks those layers breadth-first (JSON-parsing any
 * string layer before inspecting it) and returns the first of:
 *
 *   - a live `CailError` instance (returned by reference), or
 *   - the wire envelope `{error:{message,type,param,code,cail?}}`
 *     (per docs/ERROR_CONTRACT.md), rebuilt as a `CailError` with
 *     `error.cail` spread into `extras` (so `extras.retry_after_seconds`
 *     survives), or
 *   - a bare CailError-shaped record (`{code,message,...}` with a CAIL
 *     marker: `name:"CailError"`, a `cail`/`extras` object, or
 *     `status` + `type`) — a copy that crossed a bundle/clone boundary.
 *
 * The `status` of a rebuilt error comes from the nearest wrapper's
 * `statusCode`/`status` when the envelope itself carries none; `0` otherwise.
 * Returns `null` when no CAIL envelope is found — callers keep their own
 * handling for non-CAIL errors. This never sniffs bare HTTP statuses or
 * message text: a plain 429 without a typed envelope is NOT a CAIL error.
 *
 * Dependency-free, synchronous, cycle-safe.
 */
export function extractCailError(value) {
    const layers = [
        { value, status: 0 },
    ];
    const seen = new Set();
    let visited = 0;
    while (layers.length > 0 && visited < EXTRACT_MAX_LAYERS) {
        const entry = layers.shift();
        const layer = parseJsonLayer(entry.value);
        if (!layer || typeof layer !== "object" || seen.has(layer)) {
            continue;
        }
        seen.add(layer);
        visited++;
        if (layer instanceof CailError)
            return layer;
        const record = layer;
        const status = wrapperStatus(record) ?? entry.status;
        if (isRecord(record["error"])) {
            const fromEnvelope = cailErrorFromEnvelope(record["error"], status);
            if (fromEnvelope !== null)
                return fromEnvelope;
        }
        const fromBareShape = cailErrorFromBareShape(record, status);
        if (fromBareShape !== null)
            return fromBareShape;
        for (const nested of [
            record["responseBody"],
            record["cause"],
            record["error"],
            record["data"],
            record["lastError"],
        ]) {
            if (nested !== undefined)
                layers.push({ value: nested, status });
        }
        if (Array.isArray(record["errors"])) {
            for (const nested of record["errors"]) {
                layers.push({ value: nested, status });
            }
        }
    }
    return null;
}
function quotaBodyUnknownError(status) {
    return new CailError("unknown_error", `The CAIL backbone returned an unexpected quota response (status ${status}).`, status);
}
function quotaBodyInteger(obj, key) {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        return null;
    }
    return value;
}
function parseQuotaSnapshotBody(body, status) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw quotaBodyUnknownError(status);
    }
    const obj = body;
    const limit = quotaBodyInteger(obj, "limit");
    const used = quotaBodyInteger(obj, "used");
    const remaining = quotaBodyInteger(obj, "remaining");
    const reset = quotaBodyInteger(obj, "reset");
    const windowSeconds = quotaBodyInteger(obj, "window_seconds");
    const asOf = quotaBodyInteger(obj, "as_of");
    const state = obj["state"];
    if (obj["object"] !== "quota" ||
        typeof obj["subject"] !== "string" ||
        typeof obj["enforced"] !== "boolean" ||
        limit === null ||
        used === null ||
        remaining === null ||
        reset === null ||
        windowSeconds === null ||
        asOf === null ||
        !isQuotaState(state)) {
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
function inBrowser() {
    const g = globalThis;
    return typeof g.location !== "undefined" && typeof g.document !== "undefined";
}
/**
 * Build a CAIL model-proxy client. Validates the `app` slug at construction
 * (I2) — an invalid slug throws immediately (fail fast) rather than at call time.
 */
export function createCailClient(opts) {
    if (typeof opts !== "object" || opts === null) {
        throw new CailError("invalid_config", "createCailClient requires an options object.", 0);
    }
    if (typeof opts.baseUrl !== "string" || opts.baseUrl.length === 0) {
        throw new CailError("invalid_config", "createCailClient requires a non-empty `baseUrl`.", 0);
    }
    if (opts.baseUrl.trim() !== opts.baseUrl ||
        CREDENTIAL_CONTROL_CHAR_RE.test(opts.baseUrl)) {
        throw new CailError("invalid_config", "`baseUrl` must not contain surrounding whitespace or control characters.", 0);
    }
    for (const [name, value] of [
        ["allowInsecureLoopback", opts.allowInsecureLoopback],
        ["allowAmbientCredentials", opts.allowAmbientCredentials],
    ]) {
        if (value !== undefined && typeof value !== "boolean") {
            throw new CailError("invalid_config", `\`${name}\` must be a boolean when present.`, 0);
        }
    }
    let parsedBaseUrl;
    try {
        parsedBaseUrl = new URL(opts.baseUrl);
    }
    catch {
        throw new CailError("invalid_config", "createCailClient requires an absolute HTTPS `baseUrl` URL.", 0);
    }
    if (parsedBaseUrl.username !== "" || parsedBaseUrl.password !== "") {
        throw new CailError("invalid_config", "`baseUrl` must not contain embedded credentials.", 0);
    }
    if (parsedBaseUrl.search !== "" || parsedBaseUrl.hash !== "") {
        throw new CailError("invalid_config", "`baseUrl` must not contain a query string or fragment.", 0);
    }
    const secureProtocol = parsedBaseUrl.protocol === "https:";
    const exactLoopbackHttp = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(opts.baseUrl);
    const allowedLoopbackHttp = parsedBaseUrl.protocol === "http:" &&
        opts.allowInsecureLoopback === true &&
        exactLoopbackHttp;
    if (!secureProtocol && !allowedLoopbackHttp) {
        throw new CailError("invalid_config", "`baseUrl` must use HTTPS. Plaintext HTTP is allowed only for an exact loopback host when `allowInsecureLoopback` is true.", 0);
    }
    if (typeof opts.app !== "string" || !APP_SLUG_RE.test(opts.app)) {
        throw new CailError("invalid_config", `Invalid X-CAIL-App slug ${JSON.stringify(opts.app)}: must match /^[a-z0-9][a-z0-9-]{0,63}$/ (low-cardinality, per-tool).`, 0);
    }
    const app = opts.app;
    const normalizedPath = parsedBaseUrl.pathname.replace(/\/+$/, "");
    const baseUrl = `${parsedBaseUrl.origin}${normalizedPath}`;
    const allowAmbientCredentials = opts.allowAmbientCredentials === true;
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw new CailError("invalid_config", "No `fetch` available: pass `fetchImpl` in this runtime.", 0);
    }
    // Invalid-config posture (aligned with the sibling fields above and with the
    // cail-identity twin's non-finite `now`/`clockToleranceSeconds` rejection):
    // absent means "use the default", but a PRESENT invalid value fails loud —
    // it is never silently coerced to the default.
    let maxRetries;
    if (opts.maxRetries === undefined) {
        maxRetries = 2;
    }
    else if (typeof opts.maxRetries !== "number" ||
        !Number.isInteger(opts.maxRetries) ||
        opts.maxRetries < 0) {
        throw new CailError("invalid_config", "`maxRetries` must be a finite integer >= 0 when present (omit it for the default of 2).", 0);
    }
    else {
        maxRetries = opts.maxRetries;
    }
    const onAuthRequired = opts.onAuthRequired ?? (inBrowser() ? browserAuthRedirect : undefined);
    async function call(path, init, credential, options, internal) {
        if ((path === "/v1/run" || path === "/v1/chat/completions") &&
            internal?.modelRun !== true) {
            throw new CailError("invalid_request", "Use run() or chatCompletions() for model invocation.", 0);
        }
        if (typeof credential !== "object" ||
            credential === null ||
            (credential.kind !== "jwt" && credential.kind !== "key") ||
            typeof credential.token !== "string") {
            throw new CailError("invalid_credential", 'call() requires a credential { kind: "jwt" | "key", token: string }.', 0);
        }
        if (credential.token.length === 0 ||
            CREDENTIAL_CONTROL_CHAR_RE.test(credential.token)) {
            throw new CailError("invalid_credential", "Credential token must be non-empty and contain no control characters.", 0);
        }
        if (credential.kind === "key" &&
            (!credential.token.startsWith("sk-cail-") ||
                credential.token.length === "sk-cail-".length)) {
            throw new CailError("invalid_credential", "Key credential must be a non-empty CAIL-issued key.", 0);
        }
        if (options?.retryNonIdempotent !== undefined &&
            typeof options.retryNonIdempotent !== "boolean") {
            throw new CailError("invalid_request", "`retryNonIdempotent` must be a boolean when present.", 0);
        }
        const headers = toHeaderRecord(init.headers);
        if (!allowAmbientCredentials) {
            const hasCookie = Object.keys(headers).some((key) => key.toLowerCase() === "cookie");
            if (hasCookie ||
                (init.credentials !== undefined && init.credentials !== "omit")) {
                throw new CailError("invalid_request", "Ambient credentials are disabled. Remove Cookie/credential inclusion or construct the client with `allowAmbientCredentials: true` after reviewing the gateway boundary.", 0);
            }
        }
        // I1 — exactly one credential on the wire.
        if (credential.kind === "jwt") {
            // Strip ANY Authorization the caller/SDK injected (the dummy-bearer
            // footgun): the proxy is JWT-first-strict, so a stray bearer must not
            // reach the wire.
            deleteHeaderCI(headers, "Authorization");
            deleteHeaderCI(headers, "X-CAIL-Identity-JWT");
            headers["X-CAIL-Identity-JWT"] = credential.token;
        }
        else {
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
        let merged;
        if (headerMeta !== undefined || options?.metadata !== undefined) {
            merged = Object.create(null);
            if (headerMeta !== undefined) {
                let base;
                try {
                    base = JSON.parse(headerMeta);
                }
                catch {
                    throw new CailError("invalid_metadata", "Existing X-CAIL-Metadata header is not valid JSON.", 0);
                }
                if (typeof base !== "object" || base === null || Array.isArray(base)) {
                    throw new CailError("invalid_metadata", "X-CAIL-Metadata must be a JSON object.", 0);
                }
                Object.assign(merged, base);
            }
            if (options?.metadata !== undefined) {
                Object.assign(merged, options.metadata);
            }
        }
        deleteHeaderCI(headers, "X-CAIL-Metadata");
        if (merged !== undefined) {
            headers["X-CAIL-Metadata"] = serializeMetadata(merged);
        }
        // Optional correlation forwarding (the cail-log contract): replace the
        // traceparent/tracestate/request-id carrier as one unit so the next hop can
        // ADOPT this
        // trace. Applied once, before any transport attempt — retries of the same
        // logical request deliberately carry the same correlation. Absent → no
        // headers added, no behavior change.
        if (options?.correlation !== undefined) {
            let correlationHeaders;
            try {
                correlationHeaders = outboundCorrelationHeaders(options.correlation);
            }
            catch (err) {
                // cail-log throws TypeError on a malformed correlation (forwarding a
                // broken id would silently fork the trace); surface it in this
                // client's error vocabulary, client-side (status 0), nothing on the wire.
                throw new CailError("invalid_correlation", err instanceof Error && err.message
                    ? err.message
                    : "Invalid correlation: expected { trace_id, span_id, trace_flags, request_id } from correlationFromHeaders().", 0);
            }
            deleteHeaderCI(headers, TRACEPARENT_HEADER);
            deleteHeaderCI(headers, TRACESTATE_HEADER);
            deleteHeaderCI(headers, CAIL_REQUEST_ID_HEADER);
            Object.assign(headers, correlationHeaders);
        }
        const url = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
        // I8 — body + model forwarded verbatim: we never touch init.body.
        const signal = options?.signal ?? init.signal;
        if (signal != null &&
            (typeof signal !== "object" ||
                typeof signal.aborted !== "boolean" ||
                typeof signal.addEventListener !== "function" ||
                typeof signal.removeEventListener !== "function")) {
            throw new CailError("invalid_request", "`signal` must be an AbortSignal when present.", 0);
        }
        const hasNonReplayableBody = isReadableStreamBody(init.body);
        const retry5xx = internal?.retry5xx !== false;
        // Retry safety for the generic path: a non-idempotent endpoint requires
        // BOTH a non-empty Idempotency-Key and an explicit assertion that the
        // endpoint implements durable claim/replay. A key cannot create server-side
        // semantics. run() supplies its stronger internal gateway contract.
        const method = (init.method ?? "GET").toUpperCase();
        let wireIdempotencyKey;
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === "idempotency-key" &&
                headers[key].trim().length > 0) {
                wireIdempotencyKey = headers[key];
                break;
            }
        }
        const methodIsIdempotent = IDEMPOTENT_HTTP_METHODS.has(method);
        if (!methodIsIdempotent &&
            internal?.idempotentModelRun !== true &&
            options?.retryNonIdempotent === true &&
            wireIdempotencyKey === undefined) {
            throw new CailError("invalid_request", "`retryNonIdempotent: true` requires a non-empty Idempotency-Key header.", 0);
        }
        const retrySafeMethod = methodIsIdempotent ||
            internal?.idempotentModelRun === true ||
            (options?.retryNonIdempotent === true && wireIdempotencyKey !== undefined);
        const requestInit = {
            ...init,
            headers,
            redirect: "manual",
            signal,
            credentials: allowAmbientCredentials ? init.credentials : "omit",
        };
        let attempt = 0;
        // Total tries = 1 + maxRetries.
        for (;;) {
            let response;
            try {
                response = await fetchImpl(url, requestInit);
            }
            catch (err) {
                if (signal?.aborted)
                    throw err;
                // chatFetch never retries. Its default mode wraps an ambiguous network
                // failure in CailError so status-based SDK retry logic cannot replay it.
                // Explicit return mode leaves the platform error to an SDK whose retry
                // contract the caller has reviewed.
                if (internal?.rawMode === "return")
                    throw err;
                if (internal?.rawMode === "throw") {
                    throw new CailError("network_error", "Network request to the CAIL backbone failed.", 0);
                }
                // Network/transport error (I5): retry up to maxRetries, else throw.
                if ((internal?.modelRun !== true ||
                    internal?.idempotentModelRun === true) &&
                    retrySafeMethod &&
                    !hasNonReplayableBody &&
                    isRetriableNetworkError(err) &&
                    attempt < maxRetries) {
                    await sleep(backoffDelayMs(attempt), signal);
                    attempt++;
                    continue;
                }
                throw new CailError("network_error", "Network request to the CAIL backbone failed.", 0);
            }
            // A redirect from the proxy is never a valid model-proxy response. With
            // redirect:"manual" the platform surfaces it as an opaque redirect
            // (status 0); a mock/transport may surface the raw 3xx. Either way: do NOT
            // follow (would leak X-CAIL-Identity-JWT cross-origin) and do NOT treat as
            // success — throw immediately, no retry.
            if (response.type === "opaqueredirect" ||
                (response.status >= 300 && response.status < 400)) {
                throw new CailError("unexpected_redirect", `The CAIL backbone returned a redirect (status ${response.status}), which is never a valid model-proxy response.`, response.status);
            }
            // I7 — 2xx passthrough by reference, body NOT buffered.
            if (response.status >= 200 && response.status < 300) {
                return response;
            }
            // chatFetch never retries. It returns ordinary provider errors for the
            // SDK parser, but by default throws gateway-declared non-retryable errors
            // so an SDK's status-only heuristic cannot replay an ambiguous request.
            // The explicit return mode is only for SDKs that honor x-should-retry.
            if (internal?.rawMode !== undefined) {
                const shouldRetry = shouldRetryHeader(response);
                let peek = null;
                if (response.status === 401 ||
                    response.status === 429 ||
                    shouldRetry === false) {
                    try {
                        peek = await parseCailError(response.clone());
                    }
                    catch {
                        // A malformed body is parsed from the original only if we must throw.
                    }
                }
                if (response.status === 401 &&
                    peek?.code === "authentication_required" &&
                    onAuthRequired) {
                    try {
                        onAuthRequired(peek);
                    }
                    catch {
                        // The hook is advisory; it must never mask the gateway result.
                    }
                }
                const quotaExceeded = response.status === 429 && peek?.code === "quota_exceeded";
                if (quotaExceeded) {
                    if (internal.rawMode === "return" && shouldRetry === false) {
                        return response;
                    }
                    throw peek;
                }
                if (shouldRetry === false && internal.rawMode === "throw") {
                    throw peek ?? (await parseCailError(response));
                }
                return response;
            }
            // A transport retry can reach the gateway while the original buffered
            // request is still completing. Only this explicit idempotency conflict is
            // retryable; ordinary 4xx responses remain final.
            if (response.status === 409 &&
                shouldRetryHeader(response) !== false &&
                internal?.idempotentModelRun === true &&
                !hasNonReplayableBody &&
                attempt < maxRetries) {
                let conflict = null;
                try {
                    conflict = await parseCailError(response.clone());
                }
                catch {
                    // An unreadable conflict is handled as an ordinary non-2xx below.
                }
                if (conflict?.code === "idempotency_in_progress") {
                    try {
                        await response.body?.cancel();
                    }
                    catch {
                        /* ignore */
                    }
                    await sleep(retryDelayMs(response, attempt), signal);
                    attempt++;
                    continue;
                }
            }
            // I5 — retry eligible 5xx unless the gateway explicitly forbids it.
            const is5xx = response.status >= 500 && response.status < 600;
            if (is5xx &&
                shouldRetryHeader(response) !== false &&
                (internal?.modelRun !== true ||
                    internal?.idempotentModelRun === true) &&
                retrySafeMethod &&
                retry5xx &&
                !hasNonReplayableBody &&
                attempt < maxRetries) {
                // Drain the failed response body so the connection can be reused.
                try {
                    await response.body?.cancel();
                }
                catch {
                    /* ignore */
                }
                await sleep(retryDelayMs(response, attempt), signal);
                attempt++;
                continue;
            }
            // I4 — non-2xx (and non-retriable, or retries exhausted) → typed error.
            const error = await parseCailError(response);
            // I6 — 401 authentication_required hook, then still throw.
            if (error.status === 401 &&
                error.code === "authentication_required" &&
                onAuthRequired) {
                try {
                    onAuthRequired(error);
                }
                catch {
                    // The hook is advisory; it must never mask the backbone error.
                }
            }
            throw error;
        }
    }
    async function getQuota(credential) {
        const response = await call("/quota", { method: "GET" }, credential, undefined, { retry5xx: false });
        let body;
        try {
            body = await response.json();
        }
        catch {
            throw quotaBodyUnknownError(response.status);
        }
        return parseQuotaSnapshotBody(body, response.status);
    }
    async function run(request, credential, options) {
        if (typeof request !== "object" ||
            request === null ||
            typeof request.model !== "string" ||
            request.model.length === 0 ||
            !("input" in request) ||
            request.input === undefined) {
            throw new CailError("invalid_request", "run() requires { model: string, input }.", 0);
        }
        if (options?.idempotencyKey !== undefined &&
            (typeof options.idempotencyKey !== "string" ||
                !UUID_V4_RE.test(options.idempotencyKey))) {
            throw new CailError("invalid_request", "run() options.idempotencyKey must be a UUID v4.", 0);
        }
        let body;
        try {
            body = JSON.stringify({ model: request.model, input: request.input });
        }
        catch {
            throw new CailError("invalid_request", "run() input must be JSON-serializable.", 0);
        }
        return call("/v1/run", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "Idempotency-Key": options?.idempotencyKey ?? mintIdempotencyKey(),
            },
            body,
        }, credential, options, { modelRun: true, idempotentModelRun: true });
    }
    async function chatCompletions(request, credential, options) {
        if (typeof request !== "object" ||
            request === null ||
            typeof request.model !== "string" ||
            request.model.length === 0 ||
            !Array.isArray(request.messages) ||
            (request.stream !== undefined && typeof request.stream !== "boolean")) {
            throw new CailError("invalid_request", "chatCompletions() requires { model: string, messages: unknown[] } with optional boolean stream.", 0);
        }
        let body;
        try {
            body = JSON.stringify(request);
        }
        catch {
            throw new CailError("invalid_request", "chatCompletions() request must be JSON-serializable.", 0);
        }
        return call("/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        }, credential, options, { modelRun: true });
    }
    function chatFetch(credential, options) {
        const rawMode = options?.nonRetryableErrorMode ?? "throw";
        if (rawMode !== "throw" && rawMode !== "return") {
            throw new CailError("invalid_request", '`chatFetch()` nonRetryableErrorMode must be "throw" or "return".', 0);
        }
        const target = `${baseUrl}/v1/chat/completions`;
        const canonicalTarget = new URL(target).href;
        return async (input, init) => {
            let url;
            let requestInit;
            const requestLike = typeof input === "object" &&
                input !== null &&
                "url" in input &&
                typeof input.url === "string";
            if (requestLike) {
                if (typeof Request === "undefined") {
                    throw new CailError("invalid_request", "This runtime cannot adapt a Request input.", 0);
                }
                let request;
                try {
                    request = new Request(input, init);
                }
                catch {
                    throw new CailError("invalid_request", "chatFetch() received an invalid or already-consumed Request.", 0);
                }
                url = request.url;
                requestInit = {
                    method: request.method,
                    headers: request.headers,
                    body: request.body,
                    cache: request.cache,
                    credentials: request.credentials === "same-origin"
                        ? undefined
                        : request.credentials,
                    integrity: request.integrity,
                    keepalive: request.keepalive,
                    mode: request.mode,
                    redirect: request.redirect,
                    referrer: request.referrer,
                    referrerPolicy: request.referrerPolicy,
                    signal: request.signal,
                };
                if (request.body !== null) {
                    requestInit.duplex = "half";
                }
            }
            else if (typeof input === "string") {
                url = input;
                requestInit = init ?? {};
            }
            else {
                url = String(input);
                requestInit = init ?? {};
            }
            let canonicalInput;
            try {
                canonicalInput = new URL(url).href;
            }
            catch {
                throw new CailError("invalid_request", "chatFetch() requires the configured chat-completions URL.", 0);
            }
            if (canonicalInput !== canonicalTarget) {
                throw new CailError("invalid_request", "chatFetch() serves only the configured POST /v1/chat/completions endpoint.", 0);
            }
            if ((requestInit.method ?? "GET").toUpperCase() !== "POST") {
                throw new CailError("invalid_request", "chatFetch() requires method POST.", 0);
            }
            return call("/v1/chat/completions", requestInit, credential, options, {
                modelRun: true,
                rawMode,
                retry5xx: false,
            });
        };
    }
    return { run, chatCompletions, chatFetch, call, getQuota };
}
