import {
  boundedBodyError,
  CailError,
  parseCailError,
  readBoundedText,
} from "./errors.js";
import { parseCailModelCatalog } from "./catalog.js";
import type { CailCatalogModality, CailModelCatalog } from "./catalog.js";
import { parseCailQuotaSnapshot } from "./quota.js";
import type { CailQuotaSnapshot } from "./quota.js";

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_RUN_BODY_BYTES = 1024 * 1024;
const MAX_INPUT_NODES = 10_000;
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_ARRAY_LENGTH = 10_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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

export interface CailRunOptions extends CailRequestOptions {}

export interface CailCatalogOptions extends CailRequestOptions {
  modality?: CailCatalogModality;
}

export interface CailQuotaOptions extends CailRequestOptions {}

export interface CailClient {
  run(request: CailRunRequest, token: string, options?: CailRunOptions): Promise<Response>;
  getCatalog(options?: CailCatalogOptions): Promise<Response>;
  getCatalogSnapshot(options?: CailCatalogOptions): Promise<CailModelCatalog>;
  getQuota(token: string, options?: CailQuotaOptions): Promise<CailQuotaSnapshot>;
}

function invalid(message: string, code = "invalid_request"): CailError {
  return new CailError(code, message, 0);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

function ownData(value: object, key: string): unknown {
  const descriptor = ownDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function inertObject(): { [key: string]: JsonValue } {
  return Object.create(null) as { [key: string]: JsonValue };
}

function inertArray(): JsonValue[] {
  const output: JsonValue[] = [];
  Object.setPrototypeOf(output, null);
  return output;
}

function serializeInput(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  nodes = { count: 0 },
): JsonValue | undefined {
  if (depth > MAX_INPUT_DEPTH) return undefined;
  nodes.count += 1;
  if (nodes.count > MAX_INPUT_NODES) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || seen.has(value)) return undefined;

  seen.add(value);
  try {
    let array = false;
    try {
      array = Array.isArray(value);
    } catch {
      return undefined;
    }
    const descriptors = (() => {
      try {
        return Object.getOwnPropertyDescriptors(value);
      } catch {
        return null;
      }
    })();
    if (descriptors === null) return undefined;

    if (array) {
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        lengthDescriptor.enumerable ||
        !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_INPUT_ARRAY_LENGTH
      ) {
        return undefined;
      }
      const length = lengthDescriptor.value;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length") continue;
        if (key === "toJSON") return undefined;
        if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length) return undefined;
        if (!descriptor.enumerable || !("value" in descriptor)) return undefined;
      }
      const output = inertArray();
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor)) return undefined;
        const child = serializeInput(descriptor.value, seen, depth + 1, nodes);
        if (child === undefined) return undefined;
        Object.defineProperty(output, String(index), {
          configurable: true,
          enumerable: true,
          value: child,
          writable: true,
        });
      }
      return output;
    }

    if (!isPlainRecord(value)) return undefined;
    const output = inertObject();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype" ||
        key === "toJSON"
      ) {
        return undefined;
      }
      const child = serializeInput(descriptor.value, seen, depth + 1, nodes);
      if (child === undefined) return undefined;
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function validateToken(token: string): void {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) {
    throw invalid("A CAIL bearer token must be a non-empty control-free string.", "invalid_credential");
  }
}

function validateOptions(value: object | undefined, name: string): void {
  if (value !== undefined && (!isPlainRecord(value) || Array.isArray(value))) {
    throw invalid(`${name} options must be an object when present.`);
  }
}

function abortFailure(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return signal.reason ?? error;
  if (error instanceof CailError) return error;
  return new CailError(
    "network_error",
    "The network request to the CAIL backbone failed.",
    0,
    {},
    "unknown_error",
    null,
    error,
  );
}

function redirectError(response: Response): CailError {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Body cleanup is advisory.
  }
  return new CailError(
    "unexpected_redirect",
    "The CAIL backbone returned a redirect, which is not a valid response.",
    response.status,
  );
}

function baseUrlFrom(options: CailClientOptions): { baseUrl: string; app: string; fetchImpl: typeof fetch } {
  if (!isPlainRecord(options)) throw invalid("createCailClient requires an options object.", "invalid_config");
  if (options.allowInsecureLoopback !== undefined && typeof options.allowInsecureLoopback !== "boolean") {
    throw invalid("`allowInsecureLoopback` must be boolean when present.", "invalid_config");
  }
  if (typeof options.baseUrl !== "string" || options.baseUrl.length === 0 || options.baseUrl.trim() !== options.baseUrl || CONTROL_CHARACTERS.test(options.baseUrl)) {
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
  const loopback = parsed.protocol === "http:" && options.allowInsecureLoopback === true &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !loopback) {
    throw invalid("`baseUrl` must use HTTPS; HTTP is allowed only for an exact loopback host when enabled.", "invalid_config");
  }
  if (typeof options.app !== "string" || !APP_SLUG.test(options.app)) {
    throw invalid("`app` must be a lowercase CAIL application slug.", "invalid_config");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw invalid("No fetch implementation is available.", "invalid_config");
  const path = parsed.pathname.replace(/\/+$/, "");
  return { baseUrl: `${parsed.origin}${path}`, app: options.app, fetchImpl };
}

function authHeaders(token: string, app: string, extra: Record<string, string> = {}): Headers {
  validateToken(token);
  try {
    return new Headers({
      authorization: `Bearer ${token}`,
      "x-cail-app": app,
      ...extra,
    });
  } catch (error) {
    throw new CailError("invalid_credential", "The CAIL bearer token is not valid for HTTP headers.", 0, {}, "invalid_credential", null, error);
  }
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (init.signal?.aborted) {
    if (init.signal.reason !== undefined) throw init.signal.reason;
    if (typeof DOMException !== "undefined") throw new DOMException("The operation was aborted.", "AbortError");
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      credentials: "omit",
      redirect: "error",
    });
  } catch (error) {
    throw abortFailure(error, init.signal ?? undefined);
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw redirectError(response);
  }
  if (!response.ok) throw await parseCailError(response, init.signal ?? undefined);
  return response;
}

export function createCailClient(options: CailClientOptions): CailClient {
  const { baseUrl, app, fetchImpl } = baseUrlFrom(options);
  const endpoint = (path: string): string => `${baseUrl}${path}`;

  async function getCatalog(options?: CailCatalogOptions): Promise<Response> {
    validateOptions(options, "getCatalog()");
    const modality = options?.modality;
    if (modality !== undefined && modality !== "text" && modality !== "image" && modality !== "all") {
      throw invalid('getCatalog() modality must be "text", "image", or "all".');
    }
    const url = endpoint("/v1/catalog") + (modality === undefined ? "" : `?modality=${encodeURIComponent(modality)}`);
    return request(fetchImpl, url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: options?.signal,
    });
  }

  async function getCatalogSnapshot(options?: CailCatalogOptions): Promise<CailModelCatalog> {
    const response = await getCatalog(options);
    let text: string | null;
    try {
      text = await readBoundedText(response, 8 * 1024 * 1024, options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason ?? error;
      throw boundedBodyError(response.status, "catalog", error);
    }
    if (text === null) throw boundedBodyError(response.status, "catalog");
    try {
      return parseCailModelCatalog(JSON.parse(text), response.status);
    } catch (error) {
      if (error instanceof CailError) throw error;
      throw boundedBodyError(response.status, "catalog", error);
    }
  }

  async function getQuota(token: string, options?: CailQuotaOptions): Promise<CailQuotaSnapshot> {
    validateOptions(options, "getQuota()");
    const response = await request(fetchImpl, endpoint("/quota"), {
      method: "GET",
      headers: authHeaders(token, app, { accept: "application/json" }),
      signal: options?.signal,
    });
    let text: string | null;
    try {
      text = await readBoundedText(response, 64 * 1024, options?.signal);
    } catch (error) {
      if (options?.signal?.aborted) throw options.signal.reason ?? error;
      throw boundedBodyError(response.status, "quota", error);
    }
    if (text === null) throw boundedBodyError(response.status, "quota");
    try {
      return parseCailQuotaSnapshot(JSON.parse(text), response.status);
    } catch (error) {
      if (error instanceof CailError) throw error;
      throw boundedBodyError(response.status, "quota", error);
    }
  }

  async function run(requestBody: CailRunRequest, token: string, options?: CailRunOptions): Promise<Response> {
    validateOptions(options, "run()");
    if (!isPlainRecord(requestBody)) throw invalid("run() requires { model: string, input: object }.");
    const model = ownData(requestBody, "model");
    const input = ownData(requestBody, "input");
    if (typeof model !== "string" || model.length === 0 || model.length > 256 || CONTROL_CHARACTERS.test(model) || !isPlainRecord(input)) {
      throw invalid("run() requires a safe model string and JSON object input.");
    }
    const serializedInput = serializeInput(input);
    if (serializedInput === undefined || serializedInput === null || Array.isArray(serializedInput)) {
      throw invalid("run() requires a safe model string and JSON object input.");
    }
    let body: string;
    try {
      const wire = inertObject();
      Object.defineProperty(wire, "model", {
        configurable: true,
        enumerable: true,
        value: model,
        writable: true,
      });
      Object.defineProperty(wire, "input", {
        configurable: true,
        enumerable: true,
        value: serializedInput,
        writable: true,
      });
      body = JSON.stringify(wire);
    } catch (error) {
      throw new CailError("invalid_request", "run() input must be JSON-serializable.", 0, {}, "invalid_request", null, error);
    }
    if (new TextEncoder().encode(body).byteLength > MAX_RUN_BODY_BYTES) {
      throw invalid("run() input exceeds the Gateway request body limit.");
    }
    return request(fetchImpl, endpoint("/v1/run"), {
      method: "POST",
      headers: authHeaders(token, app, { "content-type": "application/json" }),
      body,
      signal: options?.signal,
    });
  }

  return { run, getCatalog, getCatalogSnapshot, getQuota };
}
