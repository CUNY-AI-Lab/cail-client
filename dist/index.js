/**
 * @cuny-ai-lab/cail-client — the CAIL model-proxy API client.
 *
 * The consumer-side twin of `@cuny-ai-lab/cail-identity`: the one library CUNY
 * applications use to *call* the model proxy correctly. It owns the credential
 * / header / error / retry contract so no
 * application re-derives them. Consumers include independent CUNY apps and
 * scripts, Kale apps, and centrally hosted CAIL tools.
 *
 * Design contract (see README):
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
 *   - Catalog and quota reads validate bounded CAIL-defined plain-data
 *     contracts; retired advisory quota headers are not supported.
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
const liveCailErrors = new WeakSet();
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
    constructor(code, message, status, extras = {}, type = "unknown_error", param = null, cause) {
        super(message);
        this.name = "CailError";
        this.code = code;
        this.type = type;
        this.param = param;
        this.status = status;
        this.extras = extras;
        if (arguments.length >= 7) {
            Object.defineProperty(this, "cause", {
                configurable: true,
                enumerable: false,
                value: cause,
                writable: true,
            });
        }
        // Preserve prototype chain when compiled to ES5-ish targets / bundlers.
        Object.setPrototypeOf(this, CailError.prototype);
        liveCailErrors.add(this);
    }
}
function isLiveCailError(value) {
    return liveCailErrors.has(value);
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
const CAIL_SUBJECT_RE = /^cail-[0-9a-f]{32}$/;
const APP_SUBJECT_RE = /^app-[0-9a-f]{32}$/;
const QUOTA_STATE_VALUES = new Set(["ok", "stale"]);
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_EXTRACT_JSON_CHARS = 256 * 1024;
const MAX_RESPONSE_METADATA_CHARS = 128;
function isQuotaState(value) {
    return typeof value === "string" && QUOTA_STATE_VALUES.has(value);
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
    const out = Object.create(null);
    try {
        const headers = new Headers(init);
        headers.forEach((value, key) => {
            out[key] = value;
        });
    }
    catch {
        throw new CailError("invalid_request", "Request headers must be valid Web Headers.", 0);
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
    if ((typeof err !== "object" && typeof err !== "function") ||
        err === null) {
        return true;
    }
    if (isLiveCailError(err))
        return false;
    try {
        Object.getPrototypeOf(err);
        return true;
    }
    catch {
        // If a rejected value cannot be classified safely, do not replay it.
        return false;
    }
}
function networkError(cause) {
    return new CailError("network_error", "Network request to the CAIL backbone failed.", 0, {}, "unknown_error", null, cause);
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
    const requestId = validRequestId(response.headers.get("x-request-id"));
    if (requestId !== null && !("request_id" in extras)) {
        extras["request_id"] = requestId;
    }
    const shouldRetry = shouldRetryHeader(response);
    if (shouldRetry !== null && !("should_retry" in extras)) {
        extras["should_retry"] = shouldRetry;
    }
    const retryAfter = validRetryAfter(response.headers.get("Retry-After"));
    if (retryAfter !== null && !("retry_after" in extras)) {
        extras["retry_after"] = retryAfter;
    }
}
function validRequestId(value) {
    if (value === null)
        return null;
    const trimmed = value.trim();
    return trimmed.length <= MAX_RESPONSE_METADATA_CHARS &&
        UUID_V4_RE.test(trimmed)
        ? trimmed.toLowerCase()
        : null;
}
function validRetryAfter(value) {
    if (value === null)
        return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 ||
        trimmed.length > MAX_RESPONSE_METADATA_CHARS ||
        CREDENTIAL_CONTROL_CHAR_RE.test(trimmed)) {
        return null;
    }
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isSafeInteger(seconds) ? trimmed : null;
    }
    return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}
const domExceptionNameGetter = typeof DOMException === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;
function isAbortError(error) {
    if (error === null || typeof error !== "object")
        return false;
    try {
        let current = error;
        while (current !== null) {
            const descriptor = Object.getOwnPropertyDescriptor(current, "name");
            if (descriptor !== undefined) {
                if ("value" in descriptor)
                    return descriptor.value === "AbortError";
                if (domExceptionNameGetter !== undefined &&
                    current === DOMException.prototype &&
                    descriptor.get === domExceptionNameGetter) {
                    return domExceptionNameGetter.call(error) === "AbortError";
                }
                return false;
            }
            current = Object.getPrototypeOf(current);
        }
    }
    catch {
        // Error classification must never replace the error being classified.
    }
    return false;
}
function beginBestEffortCleanup(cleanup) {
    try {
        void Promise.resolve(cleanup()).catch(() => { });
    }
    catch {
        // Cleanup is advisory and must not block or mask the request outcome.
    }
}
function discardResponseBody(response) {
    if (response.body === null)
        return;
    beginBestEffortCleanup(() => response.body.cancel());
}
async function responseTextWithinLimit(response, maxBytes = MAX_ERROR_BODY_BYTES, signal) {
    if (signal?.aborted)
        throw abortReason(signal);
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null &&
        /^\d+$/.test(contentLength) &&
        Number(contentLength) > maxBytes) {
        discardResponseBody(response);
        return null;
    }
    if (response.body === null) {
        try {
            const text = await response.text();
            return new TextEncoder().encode(text).byteLength <= maxBytes ? text : null;
        }
        catch (err) {
            if (signal?.aborted)
                throw abortReason(signal);
            throw err;
        }
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let total = 0;
    let text = "";
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
                if (signal?.aborted)
                    throw abortReason(signal);
                text += decoder.decode();
                return text;
            }
            total += chunk.value.byteLength;
            if (total > maxBytes) {
                beginBestEffortCleanup(() => reader.cancel());
                return null;
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
    }
    catch (err) {
        beginBestEffortCleanup(() => reader.cancel());
        if (signal?.aborted)
            throw abortReason(signal);
        throw err;
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch {
            // Releasing an error-body reader must not mask its primary result.
        }
    }
}
/**
 * Parse a non-2xx `Response` into a `CailError` (I4). The envelope
 * `{error:{message,type,param,code,cail?}}` is honored verbatim; a non-JSON or
 * shape-invalid body yields `code:"unknown_error"` with a generic message —
 * never swallowed as success.
 *
 * Exported for tools that want the same parsing without the full client (e.g.
 * to classify an error from a raw `Response`). Pass the request's signal when
 * available so an abort during the bounded body read preserves its reason.
 */
export async function parseCailError(response, signal) {
    const status = response.status;
    let bodyText;
    let bodyReadFailed = false;
    let bodyReadCause;
    try {
        bodyText = await responseTextWithinLimit(response, MAX_ERROR_BODY_BYTES, signal);
    }
    catch (cause) {
        if (signal?.aborted)
            throw abortReason(signal);
        if (isAbortError(cause))
            throw cause;
        bodyText = null;
        bodyReadFailed = true;
        bodyReadCause = cause;
    }
    let parsed;
    if (bodyText !== null) {
        try {
            parsed = JSON.parse(bodyText);
        }
        catch {
            parsed = undefined;
        }
    }
    if (isRecord(parsed) && isRecord(parsed["error"])) {
        const error = cailErrorFromEnvelope(parsed["error"], status);
        if (error !== null) {
            // Preserve Retry-After alongside the CAIL extension fields.
            addResponseMetadataExtras(response, error.extras);
            return error;
        }
    }
    // Non-JSON / shape-invalid body: NOT swallowed, NOT thrown away (I4).
    const extras = {};
    addResponseMetadataExtras(response, extras);
    const message = `The CAIL backbone returned an unexpected response (status ${status}).`;
    return bodyReadFailed
        ? new CailError("unknown_error", message, status, extras, "unknown_error", null, bodyReadCause)
        : new CailError("unknown_error", message, status, extras);
}
/** Try to parse a string as JSON; non-strings and unparseable strings pass through. */
function parseJsonLayer(value) {
    if (typeof value !== "string")
        return value;
    if (value.length > MAX_EXTRACT_JSON_CHARS)
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function safeDataProperty(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor
            ? { found: true, value: descriptor.value }
            : { found: false };
    }
    catch {
        return { found: false };
    }
}
function safeDataValue(value, key) {
    const property = safeDataProperty(value, key);
    return property.found ? property.value : undefined;
}
function safeDataEntries(value) {
    try {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const entries = [];
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (descriptor.enumerable && "value" in descriptor) {
                entries.push([key, descriptor.value]);
            }
        }
        return entries;
    }
    catch {
        return null;
    }
}
function safeRecordCopy(value) {
    if (value === null || typeof value !== "object")
        return null;
    try {
        if (Array.isArray(value))
            return null;
    }
    catch {
        return null;
    }
    const entries = safeDataEntries(value);
    if (entries === null)
        return null;
    const copy = {};
    for (const [key, item] of entries) {
        Object.defineProperty(copy, key, {
            configurable: true,
            enumerable: true,
            value: item,
            writable: true,
        });
    }
    return copy;
}
function safeArrayValues(value) {
    try {
        if (!Array.isArray(value))
            return [];
    }
    catch {
        return [];
    }
    const length = safeDataValue(value, "length");
    if (typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0) {
        return [];
    }
    const values = [];
    for (let index = 0; index < Math.min(length, EXTRACT_MAX_LAYERS); index++) {
        const item = safeDataProperty(value, String(index));
        if (item.found)
            values.push(item.value);
    }
    return values;
}
/** A plausible HTTP status carried on an SDK wrapper (`statusCode` / `status`). */
function wrapperStatus(record) {
    for (const key of ["statusCode", "status"]) {
        const value = safeDataValue(record, key);
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
    const message = safeDataValue(error, "message");
    const type = safeDataValue(error, "type");
    const code = safeDataValue(error, "code");
    const cail = safeDataProperty(error, "cail");
    const param = safeDataValue(error, "param");
    const cailExtras = cail.found ? safeRecordCopy(cail.value) : {};
    const validCail = !cail.found || cailExtras !== null;
    const validParam = param === null || typeof param === "string";
    if (typeof message !== "string" ||
        typeof type !== "string" ||
        typeof code !== "string" ||
        !validParam ||
        !validCail) {
        return null;
    }
    return new CailError(code, message, status, cailExtras ?? {}, type, typeof param === "string" ? param : null);
}
/**
 * Recognize a bare CailError-shaped record — a `CailError` that lost its
 * prototype by crossing a bundle boundary, a structured clone, or the wire
 * envelope's inner `error` object reached directly. Requires string
 * `code` + `message` plus at least one corroborating CAIL marker so ordinary
 * platform errors (e.g. Node's `code: "ECONNRESET"`) never match.
 */
function cailErrorFromBareShape(record, fallbackStatus) {
    const code = safeDataValue(record, "code");
    const message = safeDataValue(record, "message");
    if (typeof code !== "string" ||
        typeof message !== "string") {
        return null;
    }
    const name = safeDataValue(record, "name");
    const cail = safeRecordCopy(safeDataValue(record, "cail"));
    const extrasRecord = safeRecordCopy(safeDataValue(record, "extras"));
    const recordStatus = safeDataValue(record, "status");
    const recordType = safeDataValue(record, "type");
    const hasMarker = name === "CailError" ||
        cail !== null ||
        extrasRecord !== null ||
        (typeof recordStatus === "number" && typeof recordType === "string");
    if (!hasMarker)
        return null;
    const status = typeof recordStatus === "number" &&
        Number.isInteger(recordStatus) &&
        recordStatus >= 0
        ? recordStatus
        : fallbackStatus;
    const extras = {
        ...(cail ?? {}),
        ...(extrasRecord ?? {}),
    };
    const param = safeDataValue(record, "param");
    return new CailError(code, message, status, extras, typeof recordType === "string" ? recordType : "unknown_error", typeof param === "string" ? param : null);
}
/** Safety cap on layers visited by {@link extractCailError} (adversarial inputs). */
const EXTRACT_MAX_LAYERS = 256;
function responseMetadataFromWrapper(record) {
    const raw = safeDataValue(record, "responseHeaders");
    if (raw === null || typeof raw !== "object")
        return {};
    const plainEntries = safeDataEntries(raw);
    const header = (name) => {
        if (typeof Headers !== "undefined") {
            try {
                return Headers.prototype.get.call(raw, name);
            }
            catch {
                // Plain records are handled through their own data descriptors.
            }
        }
        if (plainEntries === null)
            return null;
        const match = plainEntries.find(([key, value]) => key.toLowerCase() === name && typeof value === "string");
        return typeof match?.[1] === "string" ? match[1] : null;
    };
    const metadata = {};
    const requestId = validRequestId(header("x-request-id"));
    if (requestId !== null)
        metadata.request_id = requestId;
    const retry = header("x-should-retry")?.trim().toLowerCase();
    if (retry === "true")
        metadata.should_retry = true;
    if (retry === "false")
        metadata.should_retry = false;
    const retryAfter = validRetryAfter(header("retry-after"));
    if (retryAfter !== null)
        metadata.retry_after = retryAfter;
    return metadata;
}
function mergeResponseMetadata(outer, inner) {
    return { ...outer, ...inner };
}
function attachResponseMetadata(error, metadata) {
    const extrasProperty = safeDataProperty(error, "extras");
    if (!extrasProperty.found ||
        extrasProperty.value === null ||
        typeof extrasProperty.value !== "object") {
        return error;
    }
    const extras = extrasProperty.value;
    for (const [key, value] of Object.entries(metadata)) {
        try {
            if (Object.getOwnPropertyDescriptor(extras, key) !== undefined) {
                continue;
            }
            if (!Object.isExtensible(extras))
                return error;
            if (!Reflect.defineProperty(extras, key, {
                configurable: true,
                enumerable: true,
                value,
                writable: true,
            })) {
                return error;
            }
        }
        catch {
            return error;
        }
    }
    return error;
}
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
        { value, status: 0, metadata: {} },
    ];
    const seen = new Set();
    let visited = 0;
    while (layers.length > 0 && visited < EXTRACT_MAX_LAYERS) {
        const entry = layers.shift();
        const layer = parseJsonLayer(entry.value);
        if (layer === null ||
            (typeof layer !== "object" && typeof layer !== "function") ||
            seen.has(layer)) {
            continue;
        }
        seen.add(layer);
        visited++;
        if (isLiveCailError(layer)) {
            return attachResponseMetadata(layer, entry.metadata);
        }
        const status = wrapperStatus(layer) ?? entry.status;
        const metadata = mergeResponseMetadata(entry.metadata, responseMetadataFromWrapper(layer));
        const nestedError = safeDataValue(layer, "error");
        if (nestedError !== null &&
            (typeof nestedError === "object" ||
                typeof nestedError === "function")) {
            const fromEnvelope = cailErrorFromEnvelope(nestedError, status);
            if (fromEnvelope !== null) {
                return attachResponseMetadata(fromEnvelope, metadata);
            }
        }
        const fromBareShape = cailErrorFromBareShape(layer, status);
        if (fromBareShape !== null) {
            return attachResponseMetadata(fromBareShape, metadata);
        }
        for (const nested of [
            safeDataValue(layer, "responseBody"),
            safeDataValue(layer, "cause"),
            nestedError,
            safeDataValue(layer, "data"),
            safeDataValue(layer, "lastError"),
        ]) {
            if (nested !== undefined) {
                layers.push({ value: nested, status, metadata });
            }
        }
        for (const nested of safeArrayValues(safeDataValue(layer, "errors"))) {
            layers.push({ value: nested, status, metadata });
        }
    }
    return null;
}
function quotaBodyUnknownError(status, cause) {
    const message = `The CAIL backbone returned an unexpected quota response (status ${status}).`;
    if (arguments.length >= 2) {
        return new CailError("unknown_error", message, status, {}, "unknown_error", null, cause);
    }
    return new CailError("unknown_error", message, status);
}
function catalogBodyUnknownError(status, cause) {
    const message = `The CAIL backbone returned an unexpected model catalog (status ${status}).`;
    if (arguments.length >= 2) {
        return new CailError("unknown_error", message, status, {}, "unknown_error", null, cause);
    }
    return new CailError("unknown_error", message, status);
}
const CATALOG_TIERS = new Set(["recommended", "advanced"]);
const CATALOG_STATUSES = new Set([
    "active",
    "deprecated",
    "retiring",
]);
const CATALOG_MODALITIES = new Set(["text", "image"]);
const CATALOG_PROVIDERS = new Set([
    "workers-ai",
    "openrouter",
]);
const CATALOG_PRICING_STATES = new Set([
    "catalog",
    "verified-live",
]);
function catalogOptionalString(value, maxLength = 2_048) {
    return (value === undefined ||
        (typeof value === "string" &&
            value.length > 0 &&
            value.length <= maxLength &&
            !CREDENTIAL_CONTROL_CHAR_RE.test(value)));
}
function parseCatalogEntry(value, status) {
    if (!isRecord(value))
        throw catalogBodyUnknownError(status);
    const id = value["id"];
    const tier = value["tier"];
    const modelStatus = value["status"];
    const modality = value["modality"];
    const provider = value["provider"];
    const pricingKnown = value["pricing_known"];
    const capabilities = value["capabilities"];
    const contextLength = value["context_length"];
    const registryUrl = value["registry_url"];
    const sunset = value["sunset"];
    if (typeof id !== "string" ||
        id.length === 0 ||
        id.length > 128 ||
        CREDENTIAL_CONTROL_CHAR_RE.test(id) ||
        value["object"] !== "model" ||
        typeof value["recommended"] !== "boolean" ||
        typeof tier !== "string" ||
        !CATALOG_TIERS.has(tier) ||
        value["recommended"] !== (tier === "recommended") ||
        typeof value["order"] !== "number" ||
        !Number.isSafeInteger(value["order"]) ||
        value["order"] < 0 ||
        typeof modelStatus !== "string" ||
        !CATALOG_STATUSES.has(modelStatus) ||
        typeof modality !== "string" ||
        !CATALOG_MODALITIES.has(modality) ||
        typeof provider !== "string" ||
        !CATALOG_PROVIDERS.has(provider) ||
        typeof value["upstream_model"] !== "string" ||
        value["upstream_model"].length === 0 ||
        value["upstream_model"].length > 128 ||
        typeof pricingKnown !== "string" ||
        !CATALOG_PRICING_STATES.has(pricingKnown) ||
        typeof value["streaming"] !== "boolean" ||
        (sunset !== null &&
            (typeof sunset !== "string" ||
                !/^\d{4}-\d{2}-\d{2}$/.test(sunset))) ||
        !Array.isArray(capabilities) ||
        capabilities.length > 32 ||
        capabilities.some((capability) => typeof capability !== "string" ||
            capability.length === 0 ||
            capability.length > 64 ||
            CREDENTIAL_CONTROL_CHAR_RE.test(capability)) ||
        new Set(capabilities).size !== capabilities.length ||
        (contextLength !== null &&
            (typeof contextLength !== "number" ||
                !Number.isSafeInteger(contextLength) ||
                contextLength < 1)) ||
        (registryUrl !== null &&
            (typeof registryUrl !== "string" ||
                !registryUrl.startsWith("https://") ||
                registryUrl.length > 2_048)) ||
        !catalogOptionalString(value["name"], 256) ||
        !catalogOptionalString(value["description"]) ||
        !catalogOptionalString(value["task"], 256)) {
        throw catalogBodyUnknownError(status);
    }
    const entry = {
        id,
        object: "model",
        recommended: value["recommended"],
        tier: tier,
        order: value["order"],
        status: modelStatus,
        modality: modality,
        provider: provider,
        upstream_model: value["upstream_model"],
        pricing_known: pricingKnown,
        streaming: value["streaming"],
        sunset,
        capabilities: [...capabilities],
        context_length: contextLength,
        registry_url: registryUrl,
    };
    if (typeof value["name"] === "string")
        entry.name = value["name"];
    if (typeof value["description"] === "string") {
        entry.description = value["description"];
    }
    if (typeof value["task"] === "string")
        entry.task = value["task"];
    return entry;
}
/** Parse the CAIL-defined public model catalog independently of any SDK type. */
export function parseCailModelCatalog(body, status = 200) {
    if (!isRecord(body) ||
        body["object"] !== "list" ||
        !Array.isArray(body["data"]) ||
        body["data"].length > 2_000) {
        throw catalogBodyUnknownError(status);
    }
    const data = body["data"].map((entry) => parseCatalogEntry(entry, status));
    if (new Set(data.map((entry) => entry.id)).size !== data.length) {
        throw catalogBodyUnknownError(status);
    }
    return { object: "list", data };
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
        (typeof obj["subject"] !== "string" ||
            (!CAIL_SUBJECT_RE.test(obj["subject"]) &&
                !APP_SUBJECT_RE.test(obj["subject"]))) ||
        obj["unit"] !== "microdollar" ||
        obj["currency"] !== "USD" ||
        typeof obj["enforced"] !== "boolean" ||
        limit === null ||
        used === null ||
        remaining === null ||
        reset === null ||
        windowSeconds === null ||
        asOf === null ||
        !isQuotaState(state) ||
        limit === 0 ||
        windowSeconds === 0 ||
        remaining !== Math.max(0, limit - used)) {
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
        throw new CailError("invalid_config", "Invalid X-CAIL-App slug: it must match /^[a-z0-9][a-z0-9-]{0,63}$/ (low-cardinality, per-tool).", 0);
    }
    const app = opts.app;
    const normalizedPath = parsedBaseUrl.pathname.replace(/\/+$/, "");
    const baseUrl = `${parsedBaseUrl.origin}${normalizedPath}`;
    const callPathPrefix = normalizedPath;
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
    function resolveCallTarget(path) {
        if (typeof path !== "string" ||
            path.length === 0 ||
            path.trim() !== path ||
            /\s/.test(path) ||
            CREDENTIAL_CONTROL_CHAR_RE.test(path) ||
            path.includes("\\") ||
            path.includes("#") ||
            path.startsWith("//") ||
            /^[a-z][a-z0-9+.-]*:/i.test(path)) {
            throw new CailError("invalid_request", "call() requires a gateway-relative path without whitespace, a fragment, or an absolute URL.", 0);
        }
        let target;
        try {
            target = new URL(`${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
        }
        catch {
            throw new CailError("invalid_request", "call() requires a valid gateway-relative path.", 0);
        }
        if (target.origin !== parsedBaseUrl.origin ||
            (callPathPrefix !== "" &&
                target.pathname !== callPathPrefix &&
                !target.pathname.startsWith(`${callPathPrefix}/`))) {
            throw new CailError("invalid_request", "call() path must remain inside the configured gateway base path.", 0);
        }
        const relativePath = callPathPrefix === ""
            ? target.pathname
            : target.pathname.slice(callPathPrefix.length) || "/";
        return {
            url: target.href,
            routePath: relativePath.replace(/\/+$/, "") || "/",
        };
    }
    async function call(path, init, credential, options, internal) {
        if (typeof init !== "object" ||
            init === null ||
            Array.isArray(init)) {
            throw new CailError("invalid_request", "call() requires a RequestInit object.", 0);
        }
        if (options !== undefined &&
            (typeof options !== "object" ||
                options === null ||
                Array.isArray(options))) {
            throw new CailError("invalid_request", "call() options must be an object when present.", 0);
        }
        const target = resolveCallTarget(path);
        if ((target.routePath === "/v1/run" ||
            target.routePath === "/v1/chat/completions") &&
            internal?.modelRun !== true) {
            throw new CailError("invalid_request", "Use run() or chatCompletions() for model invocation.", 0);
        }
        const publicCatalog = internal?.publicCatalog === true;
        if (target.routePath === "/v1/catalog" &&
            publicCatalog !== true) {
            throw new CailError("invalid_request", "Use getCatalog() for the public model catalog.", 0);
        }
        if (publicCatalog && target.routePath !== "/v1/catalog") {
            throw new CailError("invalid_request", "The public transport is restricted to GET /v1/catalog.", 0);
        }
        if (!publicCatalog) {
            if (typeof credential !== "object" ||
                credential === null ||
                (credential.kind !== "jwt" && credential.kind !== "key") ||
                typeof credential.token !== "string") {
                throw new CailError("invalid_credential", 'call() requires a credential { kind: "jwt" | "key", token: string }.', 0);
            }
            if (credential.token.length === 0 ||
                credential.token.trim() !== credential.token ||
                CREDENTIAL_CONTROL_CHAR_RE.test(credential.token)) {
                throw new CailError("invalid_credential", "Credential token must be non-empty, contain no surrounding whitespace, and contain no control characters.", 0);
            }
            if (credential.kind === "key" &&
                (!credential.token.startsWith("sk-cail-") ||
                    credential.token.length === "sk-cail-".length)) {
                throw new CailError("invalid_credential", "Key credential must be a non-empty CAIL-issued key.", 0);
            }
        }
        if (options?.retryNonIdempotent !== undefined &&
            typeof options.retryNonIdempotent !== "boolean") {
            throw new CailError("invalid_request", "`retryNonIdempotent` must be a boolean when present.", 0);
        }
        const headers = toHeaderRecord(init.headers);
        if (!publicCatalog && !allowAmbientCredentials) {
            const hasCookie = Object.keys(headers).some((key) => key.toLowerCase() === "cookie");
            if (hasCookie ||
                (init.credentials !== undefined && init.credentials !== "omit")) {
                throw new CailError("invalid_request", "Ambient credentials are disabled. Remove Cookie/credential inclusion or construct the client with `allowAmbientCredentials: true` after reviewing the gateway boundary.", 0);
            }
        }
        // I1 — exactly one credential on authenticated calls. The public catalog
        // sends none and strips all client-owned/private headers defensively.
        if (publicCatalog) {
            for (const name of [
                "Authorization",
                "X-CAIL-Identity-JWT",
                "X-CAIL-App",
                "X-CAIL-Metadata",
                TRACEPARENT_HEADER,
                TRACESTATE_HEADER,
                CAIL_REQUEST_ID_HEADER,
                "Cookie",
            ]) {
                deleteHeaderCI(headers, name);
            }
        }
        else if (credential.kind === "jwt") {
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
        if (!publicCatalog)
            headers["X-CAIL-App"] = app;
        // I3 — X-CAIL-Metadata: merge per-call `options.metadata` over any header
        // already present, validate, serialize.
        const headerMeta = publicCatalog
            ? undefined
            : existingMetadataHeader(headers);
        let merged;
        if (!publicCatalog &&
            (headerMeta !== undefined || options?.metadata !== undefined)) {
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
                if (!isRecord(options.metadata)) {
                    throw new CailError("invalid_metadata", "X-CAIL-Metadata must be an object.", 0);
                }
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
        if (!publicCatalog && options?.correlation !== undefined) {
            let correlationHeaders;
            try {
                correlationHeaders = outboundCorrelationHeaders(options.correlation);
            }
            catch (err) {
                // cail-log throws TypeError on a malformed correlation (forwarding a
                // broken id would silently fork the trace); surface it in this
                // client's error vocabulary, client-side (status 0), nothing on the wire.
                throw new CailError("invalid_correlation", "Invalid correlation: expected a value produced by correlationFromHeaders().", 0);
            }
            deleteHeaderCI(headers, TRACEPARENT_HEADER);
            deleteHeaderCI(headers, TRACESTATE_HEADER);
            deleteHeaderCI(headers, CAIL_REQUEST_ID_HEADER);
            Object.assign(headers, correlationHeaders);
        }
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
        const retryLimit = internal?.maxRetries ?? maxRetries;
        // Retry safety for the generic path: a non-idempotent endpoint requires
        // BOTH a non-empty Idempotency-Key and an explicit assertion that the
        // endpoint implements durable claim/replay. A key cannot create server-side
        // semantics. run() supplies its stronger internal gateway contract.
        const method = (init.method ?? "GET").toUpperCase();
        if (publicCatalog && method !== "GET") {
            throw new CailError("invalid_request", "The public model catalog requires method GET.", 0);
        }
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
            credentials: publicCatalog || !allowAmbientCredentials
                ? "omit"
                : init.credentials,
        };
        let attempt = 0;
        // Total tries = 1 + maxRetries.
        for (;;) {
            let response;
            try {
                response = await fetchImpl(target.url, requestInit);
            }
            catch (err) {
                if (signal?.aborted)
                    throw abortReason(signal);
                // chatFetch never retries. Its default mode wraps an ambiguous network
                // failure in CailError so status-based SDK retry logic cannot replay it.
                // Explicit return mode leaves the platform error to an SDK whose retry
                // contract the caller has reviewed.
                if (internal?.rawMode === "return")
                    throw err;
                if (internal?.rawMode === "throw") {
                    throw networkError(err);
                }
                // Network/transport error (I5): retry up to maxRetries, else throw.
                if ((internal?.modelRun !== true ||
                    internal?.idempotentModelRun === true) &&
                    retrySafeMethod &&
                    !hasNonReplayableBody &&
                    isRetriableNetworkError(err) &&
                    attempt < retryLimit) {
                    await sleep(backoffDelayMs(attempt), signal);
                    attempt++;
                    continue;
                }
                throw networkError(err);
            }
            // A redirect from the proxy is never a valid model-proxy response. With
            // redirect:"manual" the platform surfaces it as an opaque redirect
            // (status 0); a mock/transport may surface the raw 3xx. Either way: do NOT
            // follow (would leak X-CAIL-Identity-JWT cross-origin) and do NOT treat as
            // success — throw immediately, no retry.
            if (response.type === "opaqueredirect" ||
                (response.status >= 300 && response.status < 400)) {
                discardResponseBody(response);
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
                        peek = await parseCailError(response.clone(), signal);
                    }
                    catch {
                        if (signal?.aborted)
                            throw abortReason(signal);
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
                    discardResponseBody(response);
                    throw peek;
                }
                if (shouldRetry === false && internal.rawMode === "throw") {
                    if (peek !== null) {
                        discardResponseBody(response);
                        throw peek;
                    }
                    throw await parseCailError(response, signal);
                }
                return response;
            }
            let parsedError = null;
            // A transport retry can reach the gateway while the original buffered
            // request is still completing. Only this explicit idempotency conflict is
            // retryable; ordinary 4xx responses remain final.
            if (response.status === 409 &&
                shouldRetryHeader(response) !== false &&
                internal?.idempotentModelRun === true &&
                !hasNonReplayableBody &&
                attempt < retryLimit) {
                parsedError = await parseCailError(response, signal);
                if (parsedError.code === "idempotency_in_progress") {
                    discardResponseBody(response);
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
                attempt < retryLimit) {
                // Start cancelling the failed body so cleanup cannot hold up the retry.
                discardResponseBody(response);
                await sleep(retryDelayMs(response, attempt), signal);
                attempt++;
                continue;
            }
            // I4 — non-2xx (and non-retriable, or retries exhausted) → typed error.
            const error = parsedError ?? (await parseCailError(response, signal));
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
    async function getQuota(credential, options) {
        if (options !== undefined &&
            (typeof options !== "object" ||
                options === null ||
                Array.isArray(options))) {
            throw new CailError("invalid_request", "getQuota() options must be an object when present.", 0);
        }
        const response = await call("/quota", { method: "GET" }, credential, options?.signal === undefined ? undefined : { signal: options.signal }, { maxRetries: Math.min(maxRetries, 1) });
        let bodyText;
        try {
            bodyText = await responseTextWithinLimit(response, MAX_ERROR_BODY_BYTES, options?.signal);
        }
        catch (cause) {
            if (options?.signal?.aborted)
                throw abortReason(options.signal);
            throw quotaBodyUnknownError(response.status, cause);
        }
        if (bodyText === null)
            throw quotaBodyUnknownError(response.status);
        let body;
        try {
            body = JSON.parse(bodyText);
        }
        catch {
            throw quotaBodyUnknownError(response.status);
        }
        return parseQuotaSnapshotBody(body, response.status);
    }
    async function getCatalog(options) {
        if (options !== undefined &&
            (typeof options !== "object" ||
                options === null ||
                Array.isArray(options))) {
            throw new CailError("invalid_request", "getCatalog() options must be an object when present.", 0);
        }
        const modality = options?.modality;
        if (modality !== undefined &&
            modality !== "text" &&
            modality !== "image" &&
            modality !== "all") {
            throw new CailError("invalid_request", 'getCatalog() modality must be "text", "image", or "all".', 0);
        }
        const path = modality === undefined
            ? "/v1/catalog"
            : `/v1/catalog?modality=${modality}`;
        return call(path, { method: "GET", headers: { accept: "application/json" } }, undefined, options?.signal === undefined ? undefined : { signal: options.signal }, { publicCatalog: true });
    }
    async function getCatalogSnapshot(options) {
        const response = await getCatalog(options);
        let bodyText;
        try {
            bodyText = await responseTextWithinLimit(response, MAX_ERROR_BODY_BYTES, options?.signal);
        }
        catch (cause) {
            if (options?.signal?.aborted)
                throw abortReason(options.signal);
            throw catalogBodyUnknownError(response.status, cause);
        }
        if (bodyText === null)
            throw catalogBodyUnknownError(response.status);
        let body;
        try {
            body = JSON.parse(bodyText);
        }
        catch {
            throw catalogBodyUnknownError(response.status);
        }
        return parseCailModelCatalog(body, response.status);
    }
    async function run(request, credential, options) {
        if (options !== undefined &&
            (typeof options !== "object" ||
                options === null ||
                Array.isArray(options))) {
            throw new CailError("invalid_request", "run() options must be an object when present.", 0);
        }
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
        if (body === undefined) {
            throw new CailError("invalid_request", "run() input must be JSON-serializable.", 0);
        }
        const serialized = JSON.parse(body);
        if (!Object.prototype.hasOwnProperty.call(serialized, "input")) {
            throw new CailError("invalid_request", "run() input must serialize to a JSON value.", 0);
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
        if (options !== undefined &&
            (typeof options !== "object" ||
                options === null ||
                Array.isArray(options))) {
            throw new CailError("invalid_request", "chatCompletions() options must be an object when present.", 0);
        }
        if (typeof request !== "object" ||
            request === null ||
            typeof request.model !== "string" ||
            request.model.length === 0 ||
            !Array.isArray(request.messages) ||
            (request.stream !== undefined && typeof request.stream !== "boolean")) {
            throw new CailError("invalid_request", "chatCompletions() requires { model: string, messages: unknown[] } with optional boolean stream.", 0);
        }
        if (typeof request["toJSON"] === "function") {
            throw new CailError("invalid_request", "chatCompletions() does not accept a toJSON hook that can replace the validated request.", 0);
        }
        let body;
        try {
            body = JSON.stringify(request);
        }
        catch {
            throw new CailError("invalid_request", "chatCompletions() request must be JSON-serializable.", 0);
        }
        if (body === undefined) {
            throw new CailError("invalid_request", "chatCompletions() request must be JSON-serializable.", 0);
        }
        return call("/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
        }, credential, options, { modelRun: true });
    }
    function chatFetch(credential, options) {
        if (options !== undefined &&
            (typeof options !== "object" ||
                options === null ||
                Array.isArray(options))) {
            throw new CailError("invalid_request", "chatFetch() options must be an object when present.", 0);
        }
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
    return {
        run,
        chatCompletions,
        chatFetch,
        call: call,
        getCatalog,
        getCatalogSnapshot,
        getQuota,
    };
}
