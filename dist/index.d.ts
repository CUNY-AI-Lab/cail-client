/**
 * A small, Web-standard client for the CAIL OpenAI-compatible endpoint.
 *
 * Applications supply either a signed CAIL identity JWT or a native LiteLLM
 * virtual key. Identity JWTs are exchanged for short-lived virtual keys before
 * model calls. `X-CAIL-App` selects the JWT audience and provides attribution;
 * it is never user identity.
 */
export declare const CAIL_APP_HEADER = "X-CAIL-App";
export interface CailClientOptions {
    /** Exact OpenAI-compatible API base, including its final `/v1` segment. */
    baseUrl: string;
    /** Stable low-cardinality application slug, such as `agent-studio`. */
    app: string;
    /** Injectable Web-standard fetch implementation. */
    fetchImpl?: typeof fetch;
    /** Permit HTTP for localhost, 127.0.0.1, or ::1. Default false. */
    allowInsecureLoopback?: boolean;
}
export interface CailRequestOptions {
    signal?: AbortSignal;
}
export type CailCredential = string | {
    kind: "virtual-key";
    token: string;
} | {
    kind: "identity-jwt";
    token: string;
};
export declare class CailCredentialError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(message: string, status: number, code: string);
}
export interface CailChatRequest {
    model: string;
    messages: unknown[];
    stream?: boolean;
    [key: string]: unknown;
}
export type CailOpenAIFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface CailClient {
    /**
     * Call any path beneath the configured OpenAI `/v1` base.
     *
     * The response is returned untouched, including non-2xx responses and live
     * streaming bodies. Callers or their OpenAI SDK own response parsing.
     */
    request(path: string, init: RequestInit | undefined, credential: CailCredential): Promise<Response>;
    /** `GET /v1/models`, returned as a raw OpenAI-compatible response. */
    models(credential: CailCredential, options?: CailRequestOptions): Promise<Response>;
    /** `POST /v1/chat/completions`, including unbuffered SSE responses. */
    chatCompletions(request: CailChatRequest, credential: CailCredential, options?: CailRequestOptions): Promise<Response>;
    /**
     * A fetch adapter for OpenAI-compatible SDKs.
     *
     * Only URLs at or below the configured `/v1` base are accepted. Any
     * `Authorization`, legacy CAIL identity, or application header supplied by
     * the SDK is replaced with the configured CAIL values.
     */
    openAIFetch(credential: CailCredential): CailOpenAIFetch;
    /** Create a native LiteLLM personal key. Plaintext is returned once. */
    createPersonalKey(identityJwt: string, name: string, options?: CailRequestOptions): Promise<Response>;
    /** List this identity's personal keys without plaintext credentials. */
    listPersonalKeys(identityJwt: string, options?: CailRequestOptions): Promise<Response>;
    /** Revoke one personal key owned by this identity. */
    revokePersonalKey(identityJwt: string, keyId: string, options?: CailRequestOptions): Promise<Response>;
}
export declare function createCailClient(options: CailClientOptions): CailClient;
//# sourceMappingURL=index.d.ts.map