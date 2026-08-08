export type CailModelTier = "recommended" | "advanced";
export type CailModelStatus = "active" | "deprecated" | "retiring";
export type CailModelModality = "text" | "image";
export type CailModelProvider = "workers-ai" | "openrouter";
export type CailPricingState = "catalog" | "verified-live";
export interface CailModelCatalogEntry {
    id: string;
    object: "model";
    recommended: boolean;
    tier: CailModelTier;
    order: number;
    status: CailModelStatus;
    modality: CailModelModality;
    provider: CailModelProvider;
    upstream_model: string;
    pricing_known: CailPricingState;
    streaming: boolean;
    sunset: string | null;
    capabilities: string[];
    context_length: number | null;
    registry_url: string | null;
    name?: string;
    description?: string;
    task?: string;
}
export interface CailModelCatalog {
    object: "list";
    data: CailModelCatalogEntry[];
}
export type CailCatalogModality = "text" | "image" | "all";
export declare function parseCailModelCatalog(value: unknown, status?: number): CailModelCatalog;
//# sourceMappingURL=catalog.d.ts.map