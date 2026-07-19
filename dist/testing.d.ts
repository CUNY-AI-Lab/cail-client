/**
 * @cuny-ai-lab/cail-client/testing — blessed wire-shape fixtures.
 *
 * Import path: `@cuny-ai-lab/cail-client/testing`. TEST SUPPORT ONLY — this
 * subpath never changes client behavior and the runtime entry (`.`) never
 * imports it, so bundles that don't import it pay nothing for it.
 *
 * Why this exists: consumer tests kept hand-rolling the CAIL wire shapes —
 * the error envelope, the `quota_exceeded` 429, the `/quota` snapshot body,
 * the `X-CAIL-Quota-*` headers — and drifting from the contract the client
 * actually consumes (`parseCailError` / `extractCailError` / `getQuota` /
 * `parseQuotaHeaders`). These builders emit the canonical shapes (per
 * cail-gateway `docs/ERROR_CONTRACT.md` and the shared quota wire vectors) so
 * fixtures are built FROM the primitive instead of re-invented beside it.
 *
 * No test-framework imports; pure Web-standard code (`Response`, `Headers`).
 */
import type { CailQuota, CailQuotaSnapshot } from "./index.js";
/** The inner `error` member of the CAIL wire envelope. */
export interface CailErrorEnvelopeError {
    /** Human-readable, safe to show verbatim. */
    message: string;
    /** Broad OpenAI-compatible category, e.g. `"rate_limit_error"`. */
    type: string;
    /** Invalid request field when known, else `null`. */
    param: string | null;
    /** Precise CAIL code, e.g. `"quota_exceeded"`. */
    code: string;
    /** CAIL extension fields, e.g. `{ retry_after_seconds: 3600 }`. */
    cail?: Record<string, unknown>;
}
/**
 * The CAIL wire error envelope: `{ error: { message, type, param, code,
 * cail? } }` — exactly what `parseCailError` and `extractCailError` consume
 * (docs/ERROR_CONTRACT.md).
 */
export interface CailErrorEnvelope {
    error: CailErrorEnvelopeError;
}
/**
 * Build a valid CAIL error envelope. Defaults to a generic
 * `400 invalid_request`-style body; override any member. The result is always
 * shape-valid for `parseCailError` / `extractCailError`.
 */
export declare function cailErrorEnvelope(overrides?: Partial<CailErrorEnvelopeError>): CailErrorEnvelope;
export interface QuotaExceededEnvelopeOptions {
    /** `error.cail.retry_after_seconds`. Default 3600. */
    retryAfterSeconds?: number;
    /** Override the human-readable message. */
    message?: string;
}
/**
 * The canonical `quota_exceeded` envelope carried on the gateway's 429 —
 * `type: "rate_limit_error"`, `code: "quota_exceeded"`, and
 * `cail.retry_after_seconds` (which the client surfaces as
 * `CailError.extras.retry_after_seconds`). Matches the shared quota wire
 * vectors' `native-quota-exceeded-429` case.
 */
export declare function quotaExceededEnvelope(options?: QuotaExceededEnvelopeOptions): CailErrorEnvelope;
/**
 * Wrap an envelope in a JSON `Response` the way the gateway sends it —
 * ready for `parseCailError(response)` or a mocked `fetch`. Extra headers are
 * merged over the `content-type: application/json` default.
 */
export declare function cailErrorResponse(status: number, envelope?: CailErrorEnvelope, headers?: Record<string, string>): Response;
/**
 * The full canonical `429 quota_exceeded` response: the
 * {@link quotaExceededEnvelope} body plus the gateway's `Retry-After` and
 * `x-should-retry: false` headers (quota exhaustion is never auto-retried).
 */
export declare function quotaExceededResponse(options?: QuotaExceededEnvelopeOptions): Response;
/**
 * A canonical-shaped (`cail-` + 32 lowercase hex) test subject for quota
 * fixtures. For richer subject fixtures (seeded, distinct, JWT-minting) use
 * `@cuny-ai-lab/cail-identity/testing`.
 */
export declare const TEST_QUOTA_SUBJECT = "cail-0123456789abcdef0123456789abcdef";
/** The `GET /quota` snapshot body: {@link CailQuotaSnapshot} + `object: "quota"`. */
export type CailQuotaSnapshotBody = CailQuotaSnapshot & {
    object: "quota";
};
/**
 * Build a valid `GET /quota` snapshot body — the exact shape `getQuota`
 * accepts (`object: "quota"`, string `subject`, boolean `enforced`, safe
 * non-negative integers, `state: "ok" | "stale"`). Defaults mirror the shared
 * quota wire vectors ($10.00 limit, $0.63 used, in microdollars).
 */
export declare function quotaSnapshotBody(overrides?: Partial<CailQuotaSnapshot>): CailQuotaSnapshotBody;
/** A 200 JSON `Response` carrying {@link quotaSnapshotBody} — mock `GET /quota` with it. */
export declare function quotaSnapshotResponse(overrides?: Partial<CailQuotaSnapshot>): Response;
/**
 * The six advisory `X-CAIL-Quota-*` headers as a header record — the
 * all-or-none set `parseQuotaHeaders` consumes. Defaults match
 * {@link quotaSnapshotBody}.
 */
export declare function quotaHeaders(overrides?: Partial<CailQuota>): Record<string, string>;
//# sourceMappingURL=testing.d.ts.map