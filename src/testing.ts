import type { CailQuotaSnapshot } from "./quota.js";

export interface CailErrorEnvelopeError {
  message: string;
  type: string;
  param: string | null;
  code: string;
  cail?: Record<string, unknown>;
}

export interface CailErrorEnvelope {
  error: CailErrorEnvelopeError;
}

export function cailErrorEnvelope(overrides: Partial<CailErrorEnvelopeError> = {}): CailErrorEnvelope {
  return {
    error: {
      message: overrides.message ?? "The request was rejected by the CAIL backbone.",
      type: overrides.type ?? "invalid_request_error",
      param: overrides.param ?? null,
      code: overrides.code ?? "invalid_request",
      ...(overrides.cail === undefined ? {} : { cail: overrides.cail }),
    },
  };
}

export interface QuotaExceededEnvelopeOptions {
  retryAfterSeconds?: number;
  message?: string;
}

export function quotaExceededEnvelope(options: QuotaExceededEnvelopeOptions = {}): CailErrorEnvelope {
  return cailErrorEnvelope({
    message: options.message ?? "The CAIL model budget is exhausted for this period.",
    type: "rate_limit_error",
    code: "quota_exceeded",
    cail: { retry_after_seconds: options.retryAfterSeconds ?? 3600 },
  });
}

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

export function quotaExceededResponse(options: QuotaExceededEnvelopeOptions = {}): Response {
  const retryAfter = options.retryAfterSeconds ?? 3600;
  return cailErrorResponse(429, quotaExceededEnvelope(options), {
    "retry-after": String(retryAfter),
    "x-should-retry": "false",
  });
}

export const TEST_QUOTA_SUBJECT = "cail-0123456789abcdef0123456789abcdef";

export type CailQuotaSnapshotBody = CailQuotaSnapshot & {
  object: "quota";
  unit: "microdollar";
  currency: "USD";
};

export function quotaSnapshotBody(overrides: Partial<CailQuotaSnapshot> = {}): CailQuotaSnapshotBody {
  return {
    object: "quota",
    subject: TEST_QUOTA_SUBJECT,
    unit: "microdollar",
    currency: "USD",
    limit: 10_000_000,
    used: 630_000,
    remaining: 9_370_000,
    reset: 1_723_200_000,
    window_technique: "sliding",
    window_seconds: 2_592_000,
    state: "ok",
    enforced: true,
    as_of: 1_720_600_000,
    ...overrides,
  };
}

export function quotaSnapshotResponse(overrides: Partial<CailQuotaSnapshot> = {}): Response {
  return new Response(JSON.stringify(quotaSnapshotBody(overrides)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
