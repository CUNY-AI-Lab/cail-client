export type CailQuotaWindowTechnique = "fixed" | "sliding";
export type CailQuotaState = "ok" | "stale";
export interface CailQuota {
    limit: number;
    used: number;
    remaining: number;
    reset: number | null;
    window_technique: CailQuotaWindowTechnique;
    window_seconds: number;
    state: CailQuotaState;
}
export interface CailQuotaSnapshot extends CailQuota {
    subject: string;
    enforced: boolean;
    as_of: number;
}
export declare function parseCailQuotaSnapshot(value: unknown, status?: number): CailQuotaSnapshot;
//# sourceMappingURL=quota.d.ts.map