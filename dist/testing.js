export function cailErrorEnvelope(overrides = {}) {
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
export function quotaExceededEnvelope(options = {}) {
    return cailErrorEnvelope({
        message: options.message ?? "The CAIL model budget is exhausted for this period.",
        type: "rate_limit_error",
        code: "quota_exceeded",
        cail: { retry_after_seconds: options.retryAfterSeconds ?? 3600 },
    });
}
export function cailErrorResponse(status, envelope = cailErrorEnvelope(), headers = {}) {
    return new Response(JSON.stringify(envelope), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}
export function quotaExceededResponse(options = {}) {
    const retryAfter = options.retryAfterSeconds ?? 3600;
    return cailErrorResponse(429, quotaExceededEnvelope(options), {
        "retry-after": String(retryAfter),
        "x-should-retry": "false",
    });
}
export const TEST_QUOTA_SUBJECT = "cail-0123456789abcdef0123456789abcdef";
export function quotaSnapshotBody(overrides = {}) {
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
export function quotaSnapshotResponse(overrides = {}) {
    return new Response(JSON.stringify(quotaSnapshotBody(overrides)), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}
