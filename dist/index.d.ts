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
 *   - Never retry 4xx. Non-model calls retry 5xx + network up to `maxRetries`
 *     with backoff; billed model POSTs make one attempt until the gateway
 *     provides execution idempotency (I5).
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
/** Credential forwarded on a call. Exactly one kind reaches the wire (I1). */
export type CailCredential = {
    kind: "jwt";
    token: string;
} | {
    kind: "key";
    token: string;
};
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
export declare class CailError extends Error {
    /** The envelope `error` code, e.g. `"quota_exceeded"`; `"unknown_error"` / `"network_error"` for non-envelope failures. */
    readonly code: string;
    /** HTTP status; `0` for a network/transport failure with no response. */
    readonly status: number;
    /** Any extra envelope fields beyond `error`/`message` (e.g. `login_url`, `retry_after_seconds`). */
    readonly extras: Record<string, unknown>;
    constructor(code: string, message: string, status: number, extras?: Record<string, unknown>);
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
     * Max retries for eligible non-model 5xx + network errors (I5). Default 2
     * (when absent). Never applies to 4xx or billed model POSTs. A PRESENT value
     * must be a finite integer >= 0 — anything else throws `invalid_config` at
     * construction (fail loud, matching `baseUrl`/`app`/`fetchImpl`; invalid
     * config is never silently coerced).
     */
    maxRetries?: number;
}
export interface CailCallOptions {
    /** Per-call spend metadata (I3), merged over any `X-CAIL-Metadata` already in `init.headers`. */
    metadata?: CailMetadata;
}
/** The canonical model request accepted by `POST /v1/run`. */
export interface CailRunRequest {
    model: string;
    input: unknown;
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
    run(request: CailRunRequest, credential: CailCredential, options?: CailCallOptions): Promise<Response>;
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
     * app / metadata discipline (I1–I3) and the redirect protection, but keeps
     * RAW FETCH SEMANTICS — non-2xx responses are returned (not thrown) and the
     * client never retries (the SDK owns retry policy). It serves ONLY
     * `POST {baseUrl}/v1/chat/completions`; any other URL throws, catching SDK
     * base-URL misconfiguration loudly. The 401 `onAuthRequired` hook still
     * fires (on a cloned body) before the response is returned.
     */
    chatFetch(credential: CailCredential, options?: CailCallOptions): (input: string | URL, init?: RequestInit) => Promise<Response>;
    /**
     * Call a non-model gateway endpoint such as `/models`, `/quota`, or key
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
 * `{error, message, ...extras}` is honored verbatim; a non-JSON or
 * shape-invalid body yields `code:"unknown_error"` with a generic message —
 * never swallowed as success.
 *
 * Exported for tools that want the same parsing without the full client (e.g.
 * to classify an error from a raw `Response`).
 */
export declare function parseCailError(response: Response): Promise<CailError>;
/**
 * Build a CAIL model-proxy client. Validates the `app` slug at construction
 * (I2) — an invalid slug throws immediately (fail fast) rather than at call time.
 */
export declare function createCailClient(opts: CailClientOptions): CailClient;
//# sourceMappingURL=index.d.ts.map