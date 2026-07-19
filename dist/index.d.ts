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
import { type CailCorrelation } from "@cuny-ai-lab/cail-log";
/**
 * The fleet correlation contract, re-exported VERBATIM from
 * `@cuny-ai-lab/cail-log` so consumers have one source of truth where their
 * fleet requests originate: adopt inbound ids with
 * {@link correlationFromHeaders}, forward them with
 * {@link outboundCorrelationHeaders} (or by passing `correlation` in
 * {@link CailCallOptions} and letting the client attach the headers).
 */
export { correlationFromHeaders, outboundCorrelationHeaders, TRACEPARENT_HEADER, TRACESTATE_HEADER, CAIL_REQUEST_ID_HEADER, } from "@cuny-ai-lab/cail-log";
export type { CailCorrelation, CailCorrelationOptions, CailHeadersLike, } from "@cuny-ai-lab/cail-log";
/** Credential forwarded on a call. Exactly one kind reaches the wire (I1). */
export type CailCredential = {
    kind: "jwt";
    token: string;
} | {
    kind: "key";
    token: string;
};
/** Optional per-call metadata (I3). Merged with any `X-CAIL-Metadata` in `init`. */
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
export declare class CailError extends Error {
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
    constructor(code: string, message: string, status: number, extras?: Record<string, unknown>, type?: string, param?: string | null);
}
export interface CailClientOptions {
    /** Trusted CAIL_API_BASE. HTTPS is required and trailing slashes are normalized. */
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
     * Allow plaintext HTTP only for the exact loopback hosts `localhost`,
     * `127.0.0.1`, and `[::1]`. Default false.
     */
    allowInsecureLoopback?: boolean;
    /**
     * Permit caller-supplied Cookie headers and fetch credential modes other
     * than `omit`. Default false; use only for an explicitly reviewed gateway.
     */
    allowAmbientCredentials?: boolean;
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
    /** Per-call metadata (I3), merged over any `X-CAIL-Metadata` already in `init.headers`. */
    metadata?: CailMetadata;
    /**
     * Optional correlation to forward downstream (the cail-log contract). When
     * present, the client attaches `traceparent` (including `trace_flags`) plus
     * `X-CAIL-Request-Id` and optional `tracestate` via
     * `outboundCorrelationHeaders(correlation)` so the gateway/Workers can adopt
     * the trace. Typically obtained from `correlationFromHeaders(request)` at
     * the consuming app's own request boundary. Request IDs are lowercase UUID
     * v4 values. Absent → no correlation headers are added. A malformed value
     * throws a `CailError` (code `"invalid_correlation"`, status 0) before
     * anything hits the wire.
     */
    correlation?: CailCorrelation;
    /** Abort the transport. This option takes precedence over `init.signal`. */
    signal?: AbortSignal;
    /**
     * Opt a generic non-idempotent endpoint into network/5xx retries. A
     * non-empty `Idempotency-Key` header is also required. The endpoint must
     * document durable claim/replay semantics; a key alone is insufficient.
     */
    retryNonIdempotent?: boolean;
}
export interface CailChatFetchOptions extends CailCallOptions {
    /**
     * `"throw"` (default) converts gateway-declared non-retryable responses to
     * `CailError`, suitable for SDKs that otherwise retry by status. `"return"`
     * preserves those responses for SDKs that honor `x-should-retry: false`.
     */
    nonRetryableErrorMode?: "throw" | "return";
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
    run(request: CailRunRequest, credential: CailCredential, options?: CailRunOptions): Promise<Response>;
    /**
     * Run an OpenAI-compatible chat call through `POST /v1/chat/completions`.
     * With `stream: true` the returned 2xx `Response` body is the live SSE
     * stream (I7 — by reference, never buffered): read `chat.completion.chunk`
     * events until `data: [DONE]`. Non-2xx throws the usual {@link CailError}.
     */
    chatCompletions(request: CailChatRequest, credential: CailCredential, options?: CailCallOptions): Promise<Response>;
    /**
     * Build a `fetch`-shaped adapter for OpenAI-style SDKs (e.g. the Vercel AI
     * SDK's `createOpenAICompatible({ fetch })`): it enforces the credential /
     * app / metadata discipline (I1–I3) and redirect protection. It never
     * retries. Non-2xx responses remain raw unless the gateway declares them
     * non-retryable (or they are quota exhaustion), in which case the default
     * adapter throws a CailError. It serves ONLY
     * `POST {baseUrl}/v1/chat/completions`; any other URL throws, catching SDK
     * base-URL misconfiguration loudly. The 401 `onAuthRequired` hook still
     * fires (on a cloned body) before the response is returned.
     */
    chatFetch(credential: CailCredential, options?: CailChatFetchOptions): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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
    call(path: string, init: RequestInit, credential: CailCredential, options?: CailCallOptions): Promise<Response>;
    /**
     * Read the authenticated subject's quota snapshot from `GET /quota`.
     * Non-2xx responses throw the same {@link CailError} envelope as `call()`;
     * malformed 2xx quota bodies throw `code:"unknown_error"`.
     */
    getQuota(credential: CailCredential): Promise<CailQuotaSnapshot>;
}
/**
 * Parse advisory quota headers from any model-proxy response (I9). The six
 * `X-CAIL-Quota-*` headers are all-or-none: if any member is absent,
 * malformed, negative, unsafe, or has an unknown state, the meter is
 * unavailable and this returns `null`. Header problems are NEVER errors.
 */
export declare function parseQuotaHeaders(headers: Headers): CailQuota | null;
/**
 * Browser default `onAuthRequired` (I6): redirect to the proxy-supplied
 * `login_url` (SAME-ORIGIN ONLY — open-redirect guard) or, failing that, to
 * `/login?rt=<current-path>`. A no-op off the browser (no `window`/`location`).
 */
export declare function browserAuthRedirect(err: CailError): void;
/**
 * Parse a non-2xx `Response` into a `CailError` (I4). The envelope
 * `{error:{message,type,param,code,cail?}}` is honored verbatim; a non-JSON or
 * shape-invalid body yields `code:"unknown_error"` with a generic message —
 * never swallowed as success.
 *
 * Exported for tools that want the same parsing without the full client (e.g.
 * to classify an error from a raw `Response`).
 */
export declare function parseCailError(response: Response): Promise<CailError>;
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
export declare function extractCailError(value: unknown): CailError | null;
/**
 * Build a CAIL model-proxy client. Validates the `app` slug at construction
 * (I2) — an invalid slug throws immediately (fail fast) rather than at call time.
 */
export declare function createCailClient(opts: CailClientOptions): CailClient;
//# sourceMappingURL=index.d.ts.map