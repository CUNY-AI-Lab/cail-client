import {
  bodyError,
  CailError,
  extractCailError,
  parseCailError,
  readText,
} from "./errors.js";
import { parseCailModelCatalog } from "./catalog.js";
import type { CailCatalogModality, CailModelCatalog } from "./catalog.js";
import { parseCailQuotaSnapshot } from "./quota.js";
import type { CailQuotaSnapshot } from "./quota.js";

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TRACE_ID = /^(?!0{32})[0-9a-f]{32}$/;
const SPAN_ID = /^(?!0{16})[0-9a-f]{16}$/;
const TRACESTATE_MAX_CHARS = 512;
const TRACESTATE_MAX_MEMBERS = 32;
const TRACESTATE_KEY = /^(?:[a-z][a-z0-9_*\/-]{0,255}|[a-z0-9][a-z0-9_*\/-]{0,240}@[a-z][a-z0-9_*\/-]{0,13})$/;
const TRACESTATE_VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

export interface CailCorrelation {
  trace_id: string;
  span_id: string;
  trace_flags: 0 | 1;
  request_id: string;
  tracestate?: string;
}

export type CailCredential =
  | { kind: "jwt"; token: string }
  | { kind: "key"; token: string };

/** A CAIL metadata object is intentionally flat and scalar. */
export type CailMetadata = Record<string, string | number>;

export interface CailClientOptions {
  baseUrl: string;
  app: string;
  fetchImpl?: typeof fetch;
  allowInsecureLoopback?: boolean;
  onAuthRequired?: (error: CailError) => void;
}

export interface CailCallOptions {
  metadata?: CailMetadata;
  correlation?: CailCorrelation;
  signal?: AbortSignal;
}

export interface CailChatFetchOptions extends CailCallOptions {
  nonRetryableErrorMode?: "throw" | "return";
}

export interface CailRunRequest {
  model: string;
  input: unknown;
}

export interface CailRunOptions extends CailCallOptions {}

export interface CailCatalogOptions {
  modality?: CailCatalogModality;
  signal?: AbortSignal;
}

export interface CailQuotaOptions {
  signal?: AbortSignal;
}

/** OpenAI-compatible requests are passed through without provider validation. */
export type CailChatRequest = Record<string, unknown>;

export type CailCredentialInput = CailCredential | string;

export interface CailClient {
  run(
    request: CailRunRequest,
    credential: CailCredentialInput,
    options?: CailRunOptions,
  ): Promise<Response>;
  chatCompletions(
    request: CailChatRequest,
    credential: CailCredentialInput,
    options?: CailCallOptions,
  ): Promise<Response>;
  chatFetch(
    credential: CailCredentialInput,
    options?: CailChatFetchOptions,
  ): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  call(
    path: string,
    init: RequestInit,
    credential: CailCredentialInput,
    options?: CailCallOptions,
  ): Promise<Response>;
  getCatalog(options?: CailCatalogOptions): Promise<Response>;
  getCatalogSnapshot(options?: CailCatalogOptions): Promise<CailModelCatalog>;
  getQuota(
    credential: CailCredentialInput,
    options?: CailQuotaOptions,
  ): Promise<CailQuotaSnapshot>;
}

function invalid(message: string, code = "invalid_request"): CailError {
  return new CailError(code, message, 0);
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function own(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

type OwnProperty = { present: boolean; readable: boolean; value?: unknown };

function ownProperty(value: object | undefined, key: string): OwnProperty {
  if (value === undefined) return { present: false, readable: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { present: false, readable: false };
    return "value" in descriptor
      ? { present: true, readable: true, value: descriptor.value }
      : { present: true, readable: false };
  } catch {
    // Treat an unreadable option as present so it cannot fall back to a less
    // authoritative value from the request init.
    return { present: true, readable: false };
  }
}

function normalizeCredential(credential: CailCredentialInput): CailCredential {
  if (typeof credential === "string") {
    if (
      credential.length === 0 ||
      credential.trim() !== credential ||
      CONTROL_CHARACTERS.test(credential)
    ) {
      throw invalid(
        "Credential tokens must be non-empty and contain no surrounding whitespace or control characters.",
        "invalid_credential",
      );
    }
    return { kind: "key", token: credential };
  }
  const kind = record(credential) ? own(credential, "kind") : undefined;
  const token = record(credential) ? own(credential, "token") : undefined;
  if ((kind !== "jwt" && kind !== "key") || typeof token !== "string") {
    throw invalid(
      'A credential must be a token string or { kind: "jwt" | "key", token: string }.',
      "invalid_credential",
    );
  }
  if (
    token.length === 0 ||
    token.trim() !== token ||
    CONTROL_CHARACTERS.test(token)
  ) {
    throw invalid(
      "Credential tokens must be non-empty and contain no surrounding whitespace or control characters.",
      "invalid_credential",
    );
  }
  return { kind, token };
}

function headersRecord(input: HeadersInit | undefined): Headers {
  try {
    return new Headers(input);
  } catch {
    throw new CailError(
      "invalid_request",
      "Request headers must be valid Web Headers.",
      0,
      {},
      "invalid_request",
      null,
    );
  }
}

function metadataObject(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function metadataEntries(value: unknown): Array<[string, unknown]> {
  if (!metadataObject(value)) throw invalid("X-CAIL-Metadata must be an object.", "invalid_metadata");
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Array<[string, unknown]> = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw invalid("X-CAIL-Metadata must contain data properties.", "invalid_metadata");
      result.push([key, descriptor.value]);
    }
    return result;
  } catch (error) {
    if (error instanceof CailError) throw error;
    throw invalid("X-CAIL-Metadata must be a readable object.", "invalid_metadata");
  }
}

function metadataHeader(value: unknown): string {
  try {
    for (const [key, item] of metadataEntries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype" || key === "user_id" || key === "app" || key === "via") {
        throw invalid(`X-CAIL-Metadata key "${key}" is not allowed.`, "invalid_metadata");
      }
      if (
        typeof item !== "string" &&
        (typeof item !== "number" || !Number.isFinite(item))
      ) {
        throw invalid(`X-CAIL-Metadata value for "${key}" must be a string or finite number.`, "invalid_metadata");
      }
    }
    const serialized = JSON.stringify(Object.fromEntries(metadataEntries(value)));
    if (typeof serialized !== "string") throw invalid("X-CAIL-Metadata must be JSON-serializable.", "invalid_metadata");
    return serialized;
  } catch (error) {
    if (error instanceof CailError) throw error;
    throw invalid("X-CAIL-Metadata must be JSON-serializable.", "invalid_metadata");
  }
}

function sanitizeTracestate(raw: string): string | undefined {
  if (raw.length > TRACESTATE_MAX_CHARS) return undefined;
  const rawMembers = raw.split(",");
  if (rawMembers.length > TRACESTATE_MAX_MEMBERS) return undefined;
  const members: string[] = [];
  const keys = new Set<string>();
  for (const rawMember of rawMembers) {
    const member = rawMember.replace(/^[ \t]+|[ \t]+$/g, "");
    if (member === "") continue;
    const equals = member.indexOf("=");
    if (equals <= 0 || equals === member.length - 1) return undefined;
    const key = member.slice(0, equals);
    const item = member.slice(equals + 1);
    if (!TRACESTATE_KEY.test(key) || !TRACESTATE_VALUE.test(item) || keys.has(key)) return undefined;
    keys.add(key);
    members.push(member);
  }
  return members.length === 0 ? undefined : members.join(",");
}

function correlationHeaders(value: CailCorrelation): Record<string, string> {
  const traceIdProperty = record(value) ? ownProperty(value, "trace_id") : { present: false, readable: false };
  const spanIdProperty = record(value) ? ownProperty(value, "span_id") : { present: false, readable: false };
  const traceFlagsProperty = record(value) ? ownProperty(value, "trace_flags") : { present: false, readable: false };
  const requestIdProperty = record(value) ? ownProperty(value, "request_id") : { present: false, readable: false };
  const tracestateProperty = record(value) ? ownProperty(value, "tracestate") : { present: false, readable: false };
  const traceId = traceIdProperty.value;
  const spanId = spanIdProperty.value;
  const traceFlags = traceFlagsProperty.value;
  const requestId = requestIdProperty.value;
  const tracestate = tracestateProperty.value;
  const validTracestate = !tracestateProperty.present || (
    tracestateProperty.readable &&
    (tracestate === undefined || (
      typeof tracestate === "string" &&
      sanitizeTracestate(tracestate) === tracestate
    ))
  );
  if (
    !traceIdProperty.present || !traceIdProperty.readable || typeof traceId !== "string" || !TRACE_ID.test(traceId) ||
    !spanIdProperty.present || !spanIdProperty.readable || typeof spanId !== "string" || !SPAN_ID.test(spanId) ||
    !traceFlagsProperty.present || !traceFlagsProperty.readable || (traceFlags !== 0 && traceFlags !== 1) ||
    !requestIdProperty.present || !requestIdProperty.readable || typeof requestId !== "string" || !UUID.test(requestId) ||
    !validTracestate
  ) {
    throw invalid(
      "Invalid correlation: expected a value produced by correlationFromHeaders().",
      "invalid_correlation",
    );
  }
  return {
    traceparent: `00-${traceId}-${spanId}-0${traceFlags}`,
    "x-cail-request-id": requestId,
    ...(typeof tracestate === "string" ? { tracestate } : {}),
  };
}

function isAbortSignal(value: unknown): value is AbortSignal {
  try {
    if (value === null || typeof value !== "object") return false;
    const candidate = value as {
      aborted?: unknown;
      addEventListener?: unknown;
      removeEventListener?: unknown;
      dispatchEvent?: unknown;
    };
    return typeof candidate.aborted === "boolean" &&
      typeof candidate.addEventListener === "function" &&
      typeof candidate.removeEventListener === "function" &&
      typeof candidate.dispatchEvent === "function";
  } catch {
    return false;
  }
}

function optionValue(options: object | undefined, key: string): unknown {
  const property = ownProperty(options, key);
  if (!property.present) return undefined;
  if (!property.readable) throw invalid(`Option "${key}" must be a readable data property.`);
  return property.value;
}

function optionSignal(options: object | undefined): AbortSignal | undefined {
  const property = ownProperty(options, "signal");
  if (!property.present) return undefined;
  if (!property.readable) throw invalid("`signal` must be an AbortSignal when present.");
  const value = property.value;
  if (value === undefined) return undefined;
  if (!isAbortSignal(value)) throw invalid("`signal` must be an AbortSignal when present.");
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function networkError(): CailError {
  return new CailError(
    "network_error",
    "The network request to the CAIL backbone failed.",
    0,
    {},
    "unknown_error",
    null,
  );
}

function bodyCleanup(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Best-effort cleanup does not mask the response error.
  }
}

function baseUrlFrom(options: CailClientOptions): {
  baseUrl: string;
  origin: string;
  basePath: string;
  app: string;
  fetchImpl: typeof fetch;
  onAuthRequired?: (error: CailError) => void;
} {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalid("createCailClient requires an options object.", "invalid_config");
  }
  if (
    typeof options.baseUrl !== "string" ||
    options.baseUrl.length === 0 ||
    options.baseUrl.trim() !== options.baseUrl ||
    CONTROL_CHARACTERS.test(options.baseUrl)
  ) {
    throw invalid("`baseUrl` must be a non-empty URL without whitespace or control characters.", "invalid_config");
  }
  let parsed: URL;
  try {
    parsed = new URL(options.baseUrl);
  } catch {
    throw invalid("`baseUrl` must be an absolute HTTPS URL.", "invalid_config");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    options.baseUrl.includes("?") ||
    options.baseUrl.includes("#")
  ) {
    throw invalid("`baseUrl` must not contain credentials, a query, or a fragment.", "invalid_config");
  }
  const loopback =
    parsed.protocol === "http:" &&
    options.allowInsecureLoopback === true &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !loopback) {
    throw invalid("`baseUrl` must use HTTPS; HTTP is allowed only for an exact loopback host when enabled.", "invalid_config");
  }
  if (typeof options.app !== "string" || !APP_SLUG.test(options.app)) {
    throw invalid("`app` must be a lowercase CAIL application slug.", "invalid_config");
  }
  if (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== "boolean") {
    throw invalid("`allowInsecureLoopback` must be a boolean when present.", "invalid_config");
  }
  if (options.onAuthRequired !== undefined && typeof options.onAuthRequired !== "function") {
    throw invalid("`onAuthRequired` must be a function when present.", "invalid_config");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw invalid("No fetch implementation is available.", "invalid_config");
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return {
    baseUrl: `${parsed.origin}${basePath}`,
    origin: parsed.origin,
    basePath,
    app: options.app,
    fetchImpl,
    onAuthRequired: options.onAuthRequired,
  };
}

function resolvePath(baseUrl: string, origin: string, basePath: string, path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.trim() !== path ||
    /\s/.test(path) ||
    CONTROL_CHARACTERS.test(path) ||
    path.includes("\\") ||
    path.includes("#") ||
    path.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  ) {
    throw invalid("Gateway paths must be relative and contain no whitespace, fragment, or absolute URL.");
  }
  let target: URL;
  try {
    target = new URL(`${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
  } catch {
    throw invalid("Gateway path is not a valid URL.");
  }
  if (
    target.origin !== origin ||
    (basePath !== "" && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))
  ) {
    throw invalid("Gateway paths must remain inside the configured base URL.");
  }
  return target.href;
}

function requestUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

export function createCailClient(options: CailClientOptions): CailClient {
  const { baseUrl, origin, basePath, app, fetchImpl, onAuthRequired } = baseUrlFrom(options);

  async function transport(
    url: string,
    init: RequestInit,
    credential: CailCredentialInput | undefined,
    callOptions: CailCallOptions | undefined,
    mode: "throw" | "raw" | "chat" = "throw",
    publicRequest = false,
  ): Promise<Response> {
    if (init === null || typeof init !== "object" || Array.isArray(init)) {
      throw invalid("Request init must be an object.");
    }
    const headers = headersRecord(own(init, "headers") as HeadersInit | undefined);
    const optionSignal = ownProperty(callOptions, "signal");
    if (optionSignal.present && !optionSignal.readable) {
      throw invalid("`signal` must be an AbortSignal when present.");
    }
    const signalValue = optionSignal.present ? optionSignal.value : own(init, "signal");
    if (signalValue !== undefined && !isAbortSignal(signalValue)) {
      throw invalid("`signal` must be an AbortSignal when present.");
    }
    const signal = signalValue as AbortSignal | undefined;
    const metadata = optionValue(callOptions, "metadata");
    const correlation = optionValue(callOptions, "correlation");
    const existingMetadata = headers.get("x-cail-metadata");

    for (const name of ["authorization", "proxy-authorization", "x-cail-identity-jwt", "x-cail-app", "x-cail-metadata", "traceparent", "tracestate", "x-cail-request-id", "cookie"]) {
      headers.delete(name);
    }
    if (!publicRequest) {
      const normalized = normalizeCredential(credential as CailCredentialInput);
      if (normalized.kind === "jwt") headers.set("x-cail-identity-jwt", normalized.token);
      else headers.set("authorization", `Bearer ${normalized.token}`);
      headers.set("x-cail-app", app);

      if (existingMetadata !== null && existingMetadata !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(existingMetadata);
        } catch {
          throw invalid("Existing X-CAIL-Metadata header is not valid JSON.", "invalid_metadata");
        }
        if (!metadataObject(parsed)) throw invalid("X-CAIL-Metadata must be an object.", "invalid_metadata");
        const merged = Object.fromEntries([
          ...metadataEntries(parsed),
          ...(metadata === undefined ? [] : metadataEntries(metadata)),
        ]);
        headers.set("x-cail-metadata", metadataHeader(merged));
      } else if (metadata !== undefined) {
        headers.set("x-cail-metadata", metadataHeader(metadata));
      }
      if (correlation !== undefined) {
        for (const [name, value] of Object.entries(correlationHeaders(correlation as CailCorrelation))) headers.set(name, value);
      }
    }

    let requestInit: RequestInit;
    try {
      requestInit = {
        ...init,
        headers,
        credentials: "omit",
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      };
    } catch {
      throw invalid("Request init must be a readable object.");
    }
    if (signal?.aborted) throw abortReason(signal);

    let response: Response;
    try {
      response = await fetchImpl(url, requestInit);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (mode === "raw") throw error;
      throw networkError();
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      bodyCleanup(response);
      throw new CailError(
        "unexpected_redirect",
        "The CAIL backbone returned a redirect, which is not a valid response.",
        response.status,
      );
    }
    if (response.ok) return response;

    if (mode === "raw") {
      if (response.status === 401 && onAuthRequired !== undefined) {
        try {
          const parsed = await parseCailError(response.clone(), signal);
          if (parsed.code === "authentication_required") onAuthRequired(parsed);
        } catch (error) {
          if (signal?.aborted) {
            bodyCleanup(response);
            throw error;
          }
          // A raw SDK response remains available even when the advisory hook
          // cannot inspect a malformed body.
        }
      }
      return response;
    }

    if (mode === "chat") {
      const shouldRetry = response.headers.get("x-should-retry")?.trim().toLowerCase();
      if (shouldRetry !== "false" && response.status !== 429 && response.status !== 401) return response;
      let parsed: CailError | null = null;
      try {
        parsed = await parseCailError(response.clone(), signal);
      } catch (error) {
        if (signal?.aborted) {
          bodyCleanup(response);
          throw error;
        }
      }
      if (parsed?.status === 401 && parsed.code === "authentication_required") {
        try {
          onAuthRequired?.(parsed);
        } catch {
          // Authentication hooks are advisory and must not mask the Gateway error.
        }
      }
      if (shouldRetry === "false" && parsed !== null) {
        bodyCleanup(response);
        throw parsed;
      }
      if (parsed?.code === "quota_exceeded" && shouldRetry !== "false") {
        bodyCleanup(response);
        throw parsed;
      }
      return response;
    }

    const error = await parseCailError(response, signal);
    if (error.status === 401 && error.code === "authentication_required") {
      try {
        onAuthRequired?.(error);
      } catch {
        // Authentication hooks are advisory and must not mask the Gateway error.
      }
    }
    throw error;
  }

  function optionsOnly(options: unknown, name: string): void {
    if (options !== undefined && !record(options)) throw invalid(`${name} options must be an object when present.`);
  }

  async function call(
    path: string,
    init: RequestInit,
    credential: CailCredentialInput,
    options?: CailCallOptions,
  ): Promise<Response> {
    optionsOnly(options, "call()");
    const url = resolvePath(baseUrl, origin, basePath, path);
    return transport(url, init, credential, options);
  }

  async function getCatalog(options?: CailCatalogOptions): Promise<Response> {
    optionsOnly(options, "getCatalog()");
    const modality = optionValue(options, "modality");
    if (modality !== undefined && modality !== "text" && modality !== "image" && modality !== "all") {
      throw invalid('getCatalog() modality must be "text", "image", or "all".');
    }
    const signal = optionSignal(options);
    const path = modality === undefined ? "/v1/catalog" : `/v1/catalog?modality=${encodeURIComponent(modality)}`;
    return transport(requestUrl(baseUrl, path), { method: "GET", headers: { accept: "application/json" } }, undefined, signal === undefined ? undefined : { signal }, "throw", true);
  }

  async function getCatalogSnapshot(options?: CailCatalogOptions): Promise<CailModelCatalog> {
    const signal = optionSignal(options);
    const response = await getCatalog(options);
    try {
      return parseCailModelCatalog(JSON.parse(await readText(response, signal)), response.status);
    } catch (error) {
      if (error instanceof CailError) throw error;
      if (signal?.aborted) throw abortReason(signal);
      throw bodyError(response.status, "catalog");
    }
  }

  async function getQuota(credential: CailCredentialInput, options?: CailQuotaOptions): Promise<CailQuotaSnapshot> {
    optionsOnly(options, "getQuota()");
    const signal = optionSignal(options);
    const response = await transport(requestUrl(baseUrl, "/quota"), { method: "GET", headers: { accept: "application/json" } }, credential, signal === undefined ? undefined : { signal });
    try {
      return parseCailQuotaSnapshot(JSON.parse(await readText(response, signal)), response.status);
    } catch (error) {
      if (error instanceof CailError) throw error;
      if (signal?.aborted) throw abortReason(signal);
      throw bodyError(response.status, "quota");
    }
  }

  async function run(request: CailRunRequest, credential: CailCredentialInput, options?: CailRunOptions): Promise<Response> {
    optionsOnly(options, "run()");
    const candidate: unknown = request;
    const model = record(candidate) ? own(candidate, "model") : undefined;
    const input = record(candidate) ? own(candidate, "input") : undefined;
    if (!record(candidate) || typeof model !== "string" || model.length === 0 || input === undefined) {
      throw invalid("run() requires { model: string, input }.");
    }
    let body: string;
    try {
      body = JSON.stringify({ model, input });
    } catch {
      throw new CailError("invalid_request", "run() input must be JSON-serializable.", 0, {}, "invalid_request");
    }
    if (body === undefined) throw invalid("run() input must be JSON-serializable.");
    try {
      const serialized = JSON.parse(body) as unknown;
      if (!record(serialized) || !Object.prototype.hasOwnProperty.call(serialized, "input")) {
        throw invalid("run() input must be JSON-serializable.");
      }
    } catch (error) {
      if (error instanceof CailError) throw error;
      throw invalid("run() input must be JSON-serializable.");
    }
    return transport(requestUrl(baseUrl, "/v1/run"), { method: "POST", headers: { "content-type": "application/json" }, body }, credential, options);
  }

  async function chatCompletions(request: CailChatRequest, credential: CailCredentialInput, options?: CailCallOptions): Promise<Response> {
    optionsOnly(options, "chatCompletions()");
    if (!record(request as unknown)) throw invalid("chatCompletions() requires a JSON object request.");
    let body: string;
    try {
      body = JSON.stringify(request);
    } catch {
      throw new CailError("invalid_request", "chatCompletions() request must be JSON-serializable.", 0, {}, "invalid_request");
    }
    if (body === undefined) throw invalid("chatCompletions() request must be JSON-serializable.");
    return transport(requestUrl(baseUrl, "/v1/chat/completions"), { method: "POST", headers: { "content-type": "application/json" }, body }, credential, options);
  }

  function chatFetch(credential: CailCredentialInput, options?: CailChatFetchOptions): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    optionsOnly(options, "chatFetch()");
    const modeValue = optionValue(options, "nonRetryableErrorMode");
    const mode = modeValue ?? "throw";
    if (mode !== "throw" && mode !== "return") throw invalid('`chatFetch()` nonRetryableErrorMode must be "throw" or "return".');
    const target = new URL(requestUrl(baseUrl, "/v1/chat/completions")).href;
    return async (input, init) => {
      let request: Request;
      try {
        if (typeof Request !== "function") throw new Error("Request is unavailable in this runtime.");
        const requestInit: RequestInit & { duplex?: "half" } = { ...init };
        const body = requestInit.body ?? (input instanceof Request ? input.body : undefined);
        if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
          requestInit.duplex = "half";
        }
        request = new Request(input, requestInit);
      } catch {
        throw new CailError("invalid_request", "chatFetch() received an invalid Request.", 0, {}, "invalid_request");
      }
      if (new URL(request.url).href !== target) throw invalid("chatFetch() serves only the configured POST /v1/chat/completions endpoint.");
      if (request.method.toUpperCase() !== "POST") throw invalid("chatFetch() requires method POST.");
      const requestInit: RequestInit & { duplex?: "half" } = {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
      };
      if (request.body !== null) requestInit.duplex = "half";
      return transport(target, requestInit, credential, options, mode === "return" ? "raw" : "chat");
    };
  }

  return { run, chatCompletions, chatFetch, call, getCatalog, getCatalogSnapshot, getQuota };
}

export { extractCailError };
