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
export declare function cailErrorEnvelope(overrides?: Partial<CailErrorEnvelopeError>): CailErrorEnvelope;
export interface QuotaExceededEnvelopeOptions {
    retryAfterSeconds?: number;
    message?: string;
}
export declare function quotaExceededEnvelope(options?: QuotaExceededEnvelopeOptions): CailErrorEnvelope;
export declare function cailErrorResponse(status: number, envelope?: CailErrorEnvelope, headers?: Record<string, string>): Response;
export declare function quotaExceededResponse(options?: QuotaExceededEnvelopeOptions): Response;
export declare const TEST_QUOTA_SUBJECT = "cail-0123456789abcdef0123456789abcdef";
export type CailQuotaSnapshotBody = CailQuotaSnapshot & {
    object: "quota";
    unit: "microdollar";
    currency: "USD";
};
export declare function quotaSnapshotBody(overrides?: Partial<CailQuotaSnapshot>): CailQuotaSnapshotBody;
export declare function quotaSnapshotResponse(overrides?: Partial<CailQuotaSnapshot>): Response;
//# sourceMappingURL=testing.d.ts.map