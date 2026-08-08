export type CailQuotaWindowTechnique = "fixed" | "sliding";
export type CailQuotaState = "estimated";
export interface CailQuota {
    object: "quota";
    managed_by: "cloudflare";
    state: CailQuotaState;
    unit: "microdollar";
    currency: "USD";
    limit: number;
    estimated_used: number;
    estimated_remaining: number;
    used_percent: number;
    remaining_percent: number;
    window_seconds: number;
    window_technique: CailQuotaWindowTechnique;
    calculated_at: number;
}
export interface CailQuotaSnapshot extends CailQuota {
}
export declare function parseCailQuotaSnapshot(value: unknown, status?: number): CailQuotaSnapshot;
//# sourceMappingURL=quota.d.ts.map