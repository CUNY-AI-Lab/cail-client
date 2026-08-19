import {
  arrayItemsFrom,
  booleanFrom,
  callableFrom,
  hasControlCharacters,
  numberFrom,
  plainRecordFrom,
  propertyFrom,
  referenceFrom,
  stringFrom,
} from "./validation.js";
import type { RuntimeProperty } from "./validation.js";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const liveErrors = new WeakMap<object, CailError>();

export type CailErrorExtraValue = string | number | boolean | null | undefined;

export interface CailErrorExtras {
  [key: string]: CailErrorExtraValue;
  request_id?: string;
  should_retry?: boolean;
  retry_after?: string;
  retry_after_seconds?: number;
}

/** A safe, typed error returned by the CAIL Gateway or transport boundary. */
export class CailError extends Error {
  readonly code: string;
  readonly type: string;
  readonly param: string | null;
  readonly status: number;
  readonly extras: CailErrorExtras;

  constructor(
    code: string,
    message: string,
    status: number,
    extras: CailErrorExtras = {},
    type = "unknown_error",
    param: string | null = null,
  ) {
    super(message);
    this.name = "CailError";
    this.code = code;
    this.type = type;
    this.param = param;
    this.status = status;
    this.extras = extras;
    Object.setPrototypeOf(this, CailError.prototype);
    liveErrors.set(this, this);
  }
}

function own<Value>(value: Value, key: string): RuntimeProperty {
  const property = propertyFrom(value, key);
  return property.readable ? property.value : undefined;
}

function entries<Value>(value: Value): Array<[string, RuntimeProperty]> | null {
  const fields = plainRecordFrom(value);
  if (fields === undefined) return null;
  try {
    const result: Array<[string, RuntimeProperty]> = [];
    for (const key of fields.names()) {
      const descriptor = fields.property(key);
      if (descriptor.readable && descriptor.enumerable) result.push([key, descriptor.value]);
    }
    return result;
  } catch {
    return null;
  }
}

/** Copy only scalar CAIL extras, never nested bodies or prototype keys. */
function scalarExtras<Value>(value: Value): CailErrorExtras | null {
  const pairs = entries(value);
  if (pairs === null) return null;
  const result: CailErrorExtras = {};
  for (const [key, item] of pairs) {
    const scalar =
      item === null ||
      stringFrom(item) !== undefined ||
      numberFrom(item) !== undefined ||
      booleanFrom(item) !== undefined;
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      !scalar
    ) {
      return null;
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return result;
}

function responseMetadata(response: Response, extras: CailErrorExtras): void {
  const requestId = response.headers.get("x-request-id");
  if (requestId !== null && REQUEST_ID.test(requestId)) extras.request_id = requestId;
  const shouldRetry = response.headers.get("x-should-retry")?.trim().toLowerCase();
  if (shouldRetry === "true" || shouldRetry === "false") {
    extras.should_retry = shouldRetry === "true";
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && !hasControlCharacters(retryAfter)) {
    extras.retry_after = retryAfter;
  }
}

function unknownResponse(status: number): CailError {
  const message = `The CAIL backbone returned an unexpected response (status ${status}).`;
  return new CailError("unknown_error", message, status, {}, "unknown_error", null);
}

export function bodyError(status: number, kind: "catalog" | "quota"): CailError {
  const label = kind === "catalog" ? "model catalog" : "quota";
  return new CailError(
    "unknown_error",
    `The CAIL backbone returned an unexpected ${label} response (status ${status}).`,
    status,
    {},
    "unknown_error",
    null,
  );
}

function abortReason(signal: AbortSignal): RuntimeProperty {
  if (signal.reason !== undefined) return signal.reason;
  try {
    return new DOMException("The operation was aborted.", "AbortError");
  } catch {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    return error;
  }
}

type AbortSignalMembers = {
  aborted?: RuntimeProperty;
  addEventListener?: RuntimeProperty;
  removeEventListener?: RuntimeProperty;
  dispatchEvent?: RuntimeProperty;
};

function isAbortError<Value>(value: Value): boolean {
  return stringFrom(plainRecordFrom(value)?.read("name")) === "AbortError";
}

function isAbortSignal<Value>(value: Value): value is Value & AbortSignal {
  try {
    const reference = referenceFrom(value);
    if (reference === undefined) return false;
    // SAFETY: referenceFrom established a non-primitive identity; each
    // structural member is validated before it is used as an AbortSignal.
    const candidate = reference as AbortSignalMembers;
    return (
      booleanFrom(candidate.aborted) !== undefined &&
      callableFrom(candidate.addEventListener) !== undefined &&
      callableFrom(candidate.removeEventListener) !== undefined &&
      callableFrom(candidate.dispatchEvent) !== undefined
    );
  } catch {
    return false;
  }
}

/** Read a response body while preserving a caller-provided abort reason. */
export async function readText(response: Response, signal?: AbortSignal): Promise<string> {
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new CailError("invalid_request", "`signal` must be an AbortSignal when present.", 0);
  }
  if (signal?.aborted) throw abortReason(signal);
  const body = response.body;
  if (body === null) return "";

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      void Promise.resolve(body.cancel()).catch(() => {});
    } catch {
      // A failed body acquisition is already the primary error.
    }
    throw error;
  }

  let cancelIssued = false;
  const cancelReader = () => {
    if (cancelIssued || signal === undefined) return;
    cancelIssued = true;
    try {
      void reader.cancel(abortReason(signal)).catch(() => {});
    } catch {
      // Cancellation is best-effort after the caller has already aborted.
    }
  };

  const readChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (signal === undefined) return reader.read();
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        cancelReader();
        reject(abortReason(signal));
      };
      const onResolve = (result: ReadableStreamReadResult<Uint8Array>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onReject = <Value>(error: Value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      try {
        void reader.read().then(onResolve, onReject);
      } catch (error) {
        onReject(error);
      }
    });
  };

  try {
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const result = await readChunk();
      if (signal?.aborted) throw abortReason(signal);
      if (result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    if (signal?.aborted) throw abortReason(signal);
    return text;
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (isAbortError(error)) throw error;
    throw error;
  } finally {
    if (signal?.aborted) cancelReader();
    try {
      reader.releaseLock();
    } catch {
      // Releasing a hostile reader must not mask the response error.
    }
  }
}

function envelopeError<Value>(value: Value, status: number): CailError | null {
  const fields = plainRecordFrom(value);
  if (fields === undefined) return null;
  const message = stringFrom(fields.read("message"));
  const type = stringFrom(fields.read("type"));
  const code = stringFrom(fields.read("code"));
  const paramValue = fields.read("param");
  const param = paramValue === null ? null : stringFrom(paramValue);
  const cail = fields.property("cail");
  const extras = !cail.present || !cail.readable ? {} : scalarExtras(cail.value);
  if (
    message === undefined ||
    type === undefined ||
    code === undefined ||
    param === undefined ||
    extras === null
  ) {
    return null;
  }
  return new CailError(code, message, status, extras, type, param);
}

/** Parse a non-success Gateway response without copying its raw body. */
export async function parseCailError(
  response: Response,
  signal?: AbortSignal,
): Promise<CailError> {
  let parsed: RuntimeProperty | undefined;
  try {
    const text = await readText(response, signal);
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (isAbortError(error)) throw error;
    if (error instanceof CailError) throw error;
  }

  const fields = plainRecordFrom(parsed);
  if (fields !== undefined) {
    const nested = fields.read("error");
    const error = envelopeError(nested, response.status);
    if (error !== null) {
      responseMetadata(response, error.extras);
      return error;
    }
  }
  const error = unknownResponse(response.status);
  responseMetadata(response, error.extras);
  return error;
}

function parseJson<Value>(value: Value): Value | RuntimeProperty {
  const text = stringFrom(value);
  if (text === undefined) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function wrapperStatus<Value>(value: Value, fallback: number): number {
  const fields = plainRecordFrom(value);
  if (fields === undefined) return fallback;
  for (const key of ["statusCode", "status"]) {
    const status = numberFrom(fields.read(key));
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return fallback;
}

function wrapperHeaders<Value>(value: Value): CailErrorExtras {
  const fields = plainRecordFrom(value);
  if (fields === undefined) return {};
  const raw = fields.read("responseHeaders");
  if (raw === null || referenceFrom(raw) === undefined) return {};
  const get = (name: string): string | null => {
    try {
      if (raw instanceof Headers) return raw.get(name);
    } catch {
      return null;
    }
    const pairs = entries(raw);
    const pair = pairs?.find(([key]) => key.toLowerCase() === name);
    return stringFrom(pair?.[1]) ?? null;
  };
  const result: CailErrorExtras = {};
  const requestId = get("x-request-id");
  if (requestId !== null && REQUEST_ID.test(requestId)) result.request_id = requestId;
  const shouldRetry = get("x-should-retry")?.trim().toLowerCase();
  if (shouldRetry === "true" || shouldRetry === "false") result.should_retry = shouldRetry === "true";
  const retryAfter = get("retry-after");
  if (retryAfter !== null && !hasControlCharacters(retryAfter)) result.retry_after = retryAfter;
  return result;
}

function attachMetadata(error: CailError, metadata: CailErrorExtras): CailError {
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    try {
      if (Object.getOwnPropertyDescriptor(error.extras, key) !== undefined) continue;
      Object.defineProperty(error.extras, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    } catch {
      // Metadata is advisory; a hostile extras object must not mask the error.
    }
  }
  return error;
}

function mergeExtras(first: CailErrorExtras, second: CailErrorExtras): CailErrorExtras {
  const result: CailErrorExtras = {};
  for (const source of [first, second]) {
    for (const [key, value] of Object.entries(source)) {
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }
  return result;
}

function bareError<Value>(value: Value, status: number): CailError | null {
  const fields = plainRecordFrom(value);
  if (fields === undefined) return null;
  const code = stringFrom(fields.read("code"));
  const message = stringFrom(fields.read("message"));
  const name = stringFrom(fields.read("name"));
  const cail = scalarExtras(fields.read("cail"));
  const extras = scalarExtras(fields.read("extras"));
  const type = stringFrom(fields.read("type"));
  const ownStatus = numberFrom(fields.read("status"));
  const marked =
    name === "CailError" ||
    cail !== null ||
    extras !== null ||
    (ownStatus !== undefined && type !== undefined);
  if (!marked || code === undefined || message === undefined) return null;
  const param = stringFrom(fields.read("param"));
  const errorStatus =
    ownStatus !== undefined && Number.isInteger(ownStatus) && ownStatus >= 0
      ? ownStatus
      : status;
  return new CailError(
    code,
    message,
    errorStatus,
    mergeExtras(cail ?? {}, extras ?? {}),
    type ?? "unknown_error",
    param ?? null,
  );
}

type WrapperEntry<Value> = {
  value: Value | RuntimeProperty;
  status: number;
  metadata: CailErrorExtras;
};

/** Extract a CAIL envelope from already-buffered SDK wrapper layers. */
export function extractCailError<Value>(value: Value): CailError | null {
  const queue: Array<WrapperEntry<Value>> = [{ value, status: 0, metadata: {} }];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined) break;
    const layer = parseJson(entry.value);
    const reference = referenceFrom(layer);
    if (reference === undefined || seen.has(reference)) continue;
    seen.add(reference);
    const live = liveErrors.get(reference);
    if (live !== undefined) return attachMetadata(live, entry.metadata);
    const status = wrapperStatus(layer, entry.status);
    const metadata = mergeExtras(entry.metadata, wrapperHeaders(layer));
    const nested = own(layer, "error");
    const parsed = envelopeError(nested, status);
    if (parsed !== null) return attachMetadata(parsed, metadata);
    const bare = bareError(layer, status);
    if (bare !== null) return attachMetadata(bare, metadata);
    for (const key of ["responseBody", "cause", "error", "data", "lastError"]) {
      const child = own(layer, key);
      if (child !== undefined) queue.push({ value: child, status, metadata });
    }
    const errors = arrayItemsFrom(own(layer, "errors"));
    if (errors !== undefined) {
      for (const child of errors) queue.push({ value: child, status, metadata });
    }
  }
  return null;
}
