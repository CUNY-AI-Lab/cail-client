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

// ---------------------------------------------------------------------------
// The CAIL error envelope
// ---------------------------------------------------------------------------

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
export function cailErrorEnvelope(
  overrides: Partial<CailErrorEnvelopeError> = {},
): CailErrorEnvelope {
  const error: CailErrorEnvelopeError = {
    message: "The request was rejected by the CAIL backbone.",
    type: "invalid_request_error",
    param: null,
    code: "invalid_request",
  };
  if (overrides.message !== undefined) error.message = overrides.message;
  if (overrides.type !== undefined) error.type = overrides.type;
  if (overrides.param !== undefined) error.param = overrides.param;
  if (overrides.code !== undefined) error.code = overrides.code;
  if (overrides.cail !== undefined) error.cail = overrides.cail;
  return { error };
}

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
export function quotaExceededEnvelope(
  options: QuotaExceededEnvelopeOptions = {},
): CailErrorEnvelope {
  return cailErrorEnvelope({
    message:
      options.message ?? "The CAIL model budget is exhausted for this period.",
    type: "rate_limit_error",
    code: "quota_exceeded",
    cail: { retry_after_seconds: options.retryAfterSeconds ?? 3600 },
  });
}

/**
 * Wrap an envelope in a JSON `Response` the way the gateway sends it —
 * ready for `parseCailError(response)` or a mocked `fetch`. Extra headers are
 * merged over the `content-type: application/json` default.
 */
export function cailErrorResponse(
  status: number,
  envelope: CailErrorEnvelope = cailErrorEnvelope(),
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * The full canonical `429 quota_exceeded` response: the
 * {@link quotaExceededEnvelope} body plus the gateway's `Retry-After` and
 * `x-should-retry: false` headers (quota exhaustion is never auto-retried).
 */
export function quotaExceededResponse(
  options: QuotaExceededEnvelopeOptions = {},
): Response {
  const retryAfterSeconds = options.retryAfterSeconds ?? 3600;
  return cailErrorResponse(429, quotaExceededEnvelope(options), {
    "retry-after": String(retryAfterSeconds),
    "x-should-retry": "false",
  });
}

// ---------------------------------------------------------------------------
// The /quota snapshot and X-CAIL-Quota-* headers
// ---------------------------------------------------------------------------

/**
 * A canonical-shaped (`cail-` + 32 lowercase hex) test subject for quota
 * fixtures. For richer subject fixtures (seeded, distinct, JWT-minting) use
 * `@cuny-ai-lab/cail-identity/testing`.
 */
export const TEST_QUOTA_SUBJECT = "cail-0123456789abcdef0123456789abcdef";

/** The `GET /quota` snapshot body: {@link CailQuotaSnapshot} + `object: "quota"`. */
export type CailQuotaSnapshotBody = CailQuotaSnapshot & { object: "quota" };

/**
 * Build a valid `GET /quota` snapshot body — the exact shape `getQuota`
 * accepts (`object: "quota"`, string `subject`, boolean `enforced`, safe
 * non-negative integers, `state: "ok" | "stale"`). Defaults mirror the shared
 * quota wire vectors ($10.00 limit, $0.63 used, in microdollars).
 */
export function quotaSnapshotBody(
  overrides: Partial<CailQuotaSnapshot> = {},
): CailQuotaSnapshotBody {
  return {
    object: "quota",
    subject: TEST_QUOTA_SUBJECT,
    limit: 10_000_000,
    used: 630_000,
    remaining: 9_370_000,
    reset: 1_723_200_000,
    window_seconds: 2_592_000,
    state: "ok",
    enforced: true,
    as_of: 1_720_600_000,
    ...overrides,
  };
}

/** A 200 JSON `Response` carrying {@link quotaSnapshotBody} — mock `GET /quota` with it. */
export function quotaSnapshotResponse(
  overrides: Partial<CailQuotaSnapshot> = {},
): Response {
  return new Response(JSON.stringify(quotaSnapshotBody(overrides)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The six advisory `X-CAIL-Quota-*` headers as a header record — the
 * all-or-none set `parseQuotaHeaders` consumes. Defaults match
 * {@link quotaSnapshotBody}.
 */
export function quotaHeaders(
  overrides: Partial<CailQuota> = {},
): Record<string, string> {
  const quota: CailQuota = {
    limit: 10_000_000,
    used: 630_000,
    remaining: 9_370_000,
    reset: 1_723_200_000,
    window_seconds: 2_592_000,
    state: "ok",
    ...overrides,
  };
  return {
    "X-CAIL-Quota-Limit": String(quota.limit),
    "X-CAIL-Quota-Used": String(quota.used),
    "X-CAIL-Quota-Remaining": String(quota.remaining),
    "X-CAIL-Quota-Reset": String(quota.reset),
    "X-CAIL-Quota-Window": String(quota.window_seconds),
    "X-CAIL-Quota-State": quota.state,
  };
}
