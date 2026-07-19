/**
 * A small, Web-standard client for the CAIL OpenAI-compatible endpoint.
 *
 * Applications supply either a signed CAIL identity JWT or a native LiteLLM
 * virtual key. Identity JWTs are exchanged for short-lived virtual keys before
 * model calls. `X-CAIL-App` selects the JWT audience and provides attribution;
 * it is never user identity.
 */
export const CAIL_APP_HEADER = "X-CAIL-App";
export class CailCredentialError extends Error {
    status;
    code;
    constructor(message, status, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = "CailCredentialError";
    }
}
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_FORBIDDEN = /[\u0000-\u0020\u007f]/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SESSION_CACHE_MAX_ENTRIES = 256;
const sessionCache = new Map();
function cacheSession(key, credential) {
    sessionCache.delete(key);
    sessionCache.set(key, credential);
    while (sessionCache.size > SESSION_CACHE_MAX_ENTRIES) {
        const oldest = sessionCache.keys().next().value;
        if (typeof oldest !== "string")
            break;
        sessionCache.delete(oldest);
    }
}
function normalizeBaseUrl(value, allowInsecureLoopback) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new TypeError("baseUrl must be a valid absolute URL.");
    }
    if (url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "") {
        throw new TypeError("baseUrl must not contain credentials, a query, or a fragment.");
    }
    const secure = url.protocol === "https:";
    const allowedLoopback = allowInsecureLoopback &&
        url.protocol === "http:" &&
        LOOPBACK_HOSTS.has(url.hostname);
    if (!secure && !allowedLoopback) {
        throw new TypeError("baseUrl must use HTTPS; explicitly allow HTTP only for a loopback host.");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/v1")) {
        throw new TypeError("baseUrl must end with the OpenAI `/v1` path segment.");
    }
    return url;
}
function assertAccessToken(token) {
    if (typeof token !== "string" ||
        token.length === 0 ||
        TOKEN_FORBIDDEN.test(token)) {
        throw new TypeError("accessToken must be a non-empty bearer token without whitespace or control characters.");
    }
}
function credentialToken(credential) {
    const token = typeof credential === "string" ? credential : credential?.token;
    assertAccessToken(token);
    return token;
}
function isIdentityCredential(credential) {
    if (typeof credential === "string") {
        const parts = credential.split(".");
        if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
            return false;
        }
        try {
            const normalized = parts[0].replace(/-/g, "+").replace(/_/g, "/");
            const header = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
            return (typeof header === "object" &&
                header !== null &&
                !Array.isArray(header) &&
                header.alg === "RS256");
        }
        catch {
            return false;
        }
    }
    return credential !== null && credential.kind === "identity-jwt";
}
function assertSignal(signal) {
    if (signal !== undefined &&
        signal !== null &&
        (typeof signal !== "object" ||
            typeof signal.aborted !== "boolean" ||
            typeof signal.addEventListener !== "function")) {
        throw new TypeError("signal must be an AbortSignal.");
    }
}
function isWithinBase(url, base) {
    return (url.origin === base.origin &&
        (url.pathname === base.pathname ||
            url.pathname.startsWith(`${base.pathname}/`)));
}
function resolvePath(path, base) {
    if (typeof path !== "string" ||
        path === "" ||
        path.includes("\\") ||
        /^[a-z][a-z0-9+.-]*:/i.test(path)) {
        throw new TypeError("path must be a non-empty relative API path.");
    }
    const relative = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(relative, `${base.href}/`);
    if (!isWithinBase(url, base) || url.hash !== "") {
        throw new TypeError("path must remain beneath the configured `/v1` base.");
    }
    return url;
}
function authorizedHeaders(input, accessToken, app) {
    const headers = new Headers(input);
    headers.delete("authorization");
    headers.delete("x-cail-identity-jwt");
    headers.delete(CAIL_APP_HEADER);
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.set(CAIL_APP_HEADER, app);
    return headers;
}
function requestInitFromRequest(request) {
    const init = {
        method: request.method,
        headers: request.headers,
        body: request.body,
        cache: request.cache,
        credentials: request.credentials === "same-origin" ? undefined : request.credentials,
        integrity: request.integrity,
        keepalive: request.keepalive,
        mode: request.mode,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        signal: request.signal,
    };
    if (request.body !== null) {
        init.duplex = "half";
    }
    return init;
}
export function createCailClient(options) {
    if (typeof options !== "object" ||
        options === null ||
        !APP_SLUG.test(options.app)) {
        throw new TypeError("app must match /^[a-z0-9][a-z0-9-]{0,63}$/.");
    }
    const base = normalizeBaseUrl(options.baseUrl, options.allowInsecureLoopback === true);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
        throw new TypeError("fetchImpl must be a function.");
    }
    const credentialBase = new URL(base.href.replace(/\/v1$/, "/cail/"));
    async function exchangeIdentity(identityJwt) {
        assertAccessToken(identityJwt);
        const cacheKey = `${credentialBase.href}\u0000${options.app}\u0000${identityJwt}`;
        const cached = sessionCache.get(cacheKey);
        if (cached instanceof Promise) {
            return (await cached).accessToken;
        }
        if (cached && cached.expiresAt > Date.now() + 30_000) {
            sessionCache.delete(cacheKey);
            sessionCache.set(cacheKey, cached);
            return cached.accessToken;
        }
        sessionCache.delete(cacheKey);
        const pending = (async () => {
            const response = await fetchImpl(new URL("auth/exchange", credentialBase), {
                method: "POST",
                headers: authorizedHeaders(undefined, identityJwt, options.app),
                credentials: "omit",
                redirect: "manual",
            });
            if (!response.ok) {
                let message = "CAIL identity exchange failed.";
                let code = "credential_exchange_failed";
                try {
                    const body = (await response.json());
                    if (typeof body.error?.message === "string" &&
                        body.error.message.trim() !== "") {
                        message = body.error.message;
                    }
                    if (typeof body.error?.code === "string" &&
                        body.error.code.trim() !== "") {
                        code = body.error.code;
                    }
                }
                catch {
                    // Keep the stable local error.
                }
                throw new CailCredentialError(message, response.status, code);
            }
            let body;
            try {
                body = await response.json();
            }
            catch {
                throw new CailCredentialError("CAIL identity exchange returned an invalid response.", 502, "credential_exchange_invalid");
            }
            if (typeof body !== "object" ||
                body === null ||
                Array.isArray(body)) {
                throw new CailCredentialError("CAIL identity exchange returned an invalid response.", 502, "credential_exchange_invalid");
            }
            const record = body;
            const accessToken = record.access_token;
            const expiresAtValue = record.expires_at;
            const expiresAt = typeof expiresAtValue === "string"
                ? Date.parse(expiresAtValue)
                : Number.NaN;
            if (typeof accessToken !== "string" ||
                !accessToken.startsWith("sk-") ||
                TOKEN_FORBIDDEN.test(accessToken) ||
                !Number.isFinite(expiresAt) ||
                expiresAt <= Date.now()) {
                throw new CailCredentialError("CAIL identity exchange returned an invalid response.", 502, "credential_exchange_invalid");
            }
            return { accessToken, expiresAt };
        })();
        sessionCache.set(cacheKey, pending);
        try {
            const credential = await pending;
            cacheSession(cacheKey, credential);
            return credential.accessToken;
        }
        catch (error) {
            if (sessionCache.get(cacheKey) === pending) {
                sessionCache.delete(cacheKey);
            }
            throw error;
        }
    }
    function resolveVirtualKey(credential) {
        const token = credentialToken(credential);
        if (typeof credential === "object" &&
            credential !== null &&
            credential.kind !== "virtual-key" &&
            credential.kind !== "identity-jwt") {
            throw new TypeError("credential kind is not supported.");
        }
        return token;
    }
    async function send(url, init, credential) {
        assertSignal(init.signal);
        const accessToken = isIdentityCredential(credential)
            ? await exchangeIdentity(credentialToken(credential))
            : resolveVirtualKey(credential);
        if (init.signal?.aborted) {
            throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        return fetchImpl(url, {
            ...init,
            headers: authorizedHeaders(init.headers, accessToken, options.app),
            credentials: "omit",
            redirect: "manual",
        });
    }
    async function request(path, init, credential) {
        return send(resolvePath(path, base), init ?? {}, credential);
    }
    async function models(credential, callOptions) {
        return request("models", { method: "GET", signal: callOptions?.signal }, credential);
    }
    async function chatCompletions(chatRequest, credential, callOptions) {
        if (typeof chatRequest !== "object" ||
            chatRequest === null ||
            typeof chatRequest.model !== "string" ||
            chatRequest.model === "" ||
            !Array.isArray(chatRequest.messages) ||
            (chatRequest.stream !== undefined &&
                typeof chatRequest.stream !== "boolean")) {
            throw new TypeError("chatCompletions requires a model, a messages array, and an optional boolean stream.");
        }
        return request("chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(chatRequest),
            signal: callOptions?.signal,
        }, credential);
    }
    function openAIFetch(credential) {
        credentialToken(credential);
        return async (input, init) => {
            let url;
            let requestInit;
            if (typeof Request !== "undefined" && input instanceof Request) {
                let request;
                try {
                    request = new Request(input, init);
                }
                catch {
                    throw new TypeError("The OpenAI SDK supplied an invalid or consumed Request.");
                }
                url = new URL(request.url);
                requestInit = requestInitFromRequest(request);
            }
            else {
                try {
                    url = new URL(String(input), `${base.href}/`);
                }
                catch {
                    throw new TypeError("The OpenAI SDK supplied an invalid URL.");
                }
                requestInit = init ?? {};
            }
            if (!isWithinBase(url, base) || url.hash !== "") {
                throw new TypeError("The OpenAI SDK may call only the configured `/v1` API base.");
            }
            return send(url, requestInit, credential);
        };
    }
    async function managementRequest(path, identityJwt, init) {
        assertAccessToken(identityJwt);
        assertSignal(init.signal);
        return fetchImpl(new URL(path, credentialBase), {
            ...init,
            headers: authorizedHeaders(init.headers, identityJwt, options.app),
            credentials: "omit",
            redirect: "manual",
        });
    }
    async function createPersonalKey(identityJwt, name, callOptions) {
        if (typeof name !== "string" ||
            name.trim() === "" ||
            name.length > 100) {
            throw new TypeError("name must contain 1 to 100 characters.");
        }
        return managementRequest("keys", identityJwt, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name.trim() }),
            signal: callOptions?.signal,
        });
    }
    async function listPersonalKeys(identityJwt, callOptions) {
        return managementRequest("keys", identityJwt, {
            method: "GET",
            signal: callOptions?.signal,
        });
    }
    async function revokePersonalKey(identityJwt, keyId, callOptions) {
        if (typeof keyId !== "string" ||
            keyId === "" ||
            TOKEN_FORBIDDEN.test(keyId)) {
            throw new TypeError("keyId must be a non-empty opaque key identifier.");
        }
        return managementRequest(`keys/${encodeURIComponent(keyId)}`, identityJwt, {
            method: "DELETE",
            signal: callOptions?.signal,
        });
    }
    return {
        request,
        models,
        chatCompletions,
        openAIFetch,
        createPersonalKey,
        listPersonalKeys,
        revokePersonalKey,
    };
}
