export declare class CailError extends Error {
    readonly code: string;
    readonly type: string;
    readonly param: string | null;
    readonly status: number;
    readonly extras: Record<string, unknown>;
    constructor(code: string, message: string, status: number, extras?: Record<string, unknown>, type?: string, param?: string | null, cause?: unknown);
}
export declare function boundedBodyError(status: number, kind: "catalog" | "quota", cause?: unknown): CailError;
export declare function readBoundedText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string | null>;
export declare function parseCailError(response: Response, signal?: AbortSignal): Promise<CailError>;
export declare function extractCailError(value: unknown): CailError | null;
//# sourceMappingURL=errors.d.ts.map