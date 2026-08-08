import type { CailCatalogModality, CailModelCatalog } from "./catalog.js";
import type { CailQuotaSnapshot } from "./quota.js";
export interface CailClientOptions {
    baseUrl: string;
    app: string;
    fetchImpl?: typeof fetch;
    allowInsecureLoopback?: boolean;
}
export interface CailRequestOptions {
    signal?: AbortSignal;
}
export interface CailRunRequest {
    model: string;
    input: Record<string, unknown>;
}
export interface CailRunOptions extends CailRequestOptions {
}
export interface CailCatalogOptions extends CailRequestOptions {
    modality?: CailCatalogModality;
}
export interface CailQuotaOptions extends CailRequestOptions {
}
export interface CailClient {
    run(request: CailRunRequest, token: string, options?: CailRunOptions): Promise<Response>;
    getCatalog(options?: CailCatalogOptions): Promise<Response>;
    getCatalogSnapshot(options?: CailCatalogOptions): Promise<CailModelCatalog>;
    getQuota(token: string, options?: CailQuotaOptions): Promise<CailQuotaSnapshot>;
}
export declare function createCailClient(options: CailClientOptions): CailClient;
//# sourceMappingURL=client.d.ts.map