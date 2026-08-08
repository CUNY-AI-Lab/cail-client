const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_EXTRACT_TEXT = 256 * 1024;
const MAX_EXTRACT_LAYERS = 256;
const MAX_EXTRA_KEYS = 32;
const MAX_EXTRA_KEY_LENGTH = 128;
const MAX_RESPONSE_HEADER_VALUE = 128;

const liveErrors = new WeakSet<object>();

export class CailError extends Error {
  readonly code: string;
  readonly type: string;
  readonly param: string | null;
  readonly status: number;
  readonly extras: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    extras: Record<string, unknown> = {},
    type = "unknown_error",
    param: string | null = null,
    cause?: unknown,
  ) {
    super(message);
    this.name = "CailError";
    this.code = code;
    this.type = type;
    this.param = param;
    this.status = status;
    this.extras = extras;
    if (arguments.length >= 7) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: true,
      });
    }
    Object.setPrototypeOf(this, CailError.prototype);
    liveErrors.add(this);
  }
}

function isLiveError(value: object): value is CailError {
  return liveErrors.has(value);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  try {
    return ownValue(value, "name") === "AbortError";
  } catch {
    return false;
  }
}

function ownValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function ownProperty(value: object, key: string): { found: boolean; value?: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor
      ? { found: true, value: descriptor.value }
      : { found: false };
  } catch {
    return { found: false };
  }
}

function ownEntries(value: object): Array<[string, unknown]> | null {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: Array<[string, unknown]> = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.enumerable && "value" in descriptor) {
        entries.push([key, descriptor.value]);
      }
    }
    return entries;
  } catch {
    return null;
  }
}

function copyExtras(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (Array.isArray(value)) return null;
  } catch {
    return null;
  }
  const entries = ownEntries(value);
  if (entries === null || entries.length > MAX_EXTRA_KEYS) return null;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (
      key.length === 0 ||
      key.length > MAX_EXTRA_KEY_LENGTH ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      (item !== null &&
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean")
    ) {
      return null;
    }
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return copy;
}

function responseHeaderValue(response: Response, name: string): string | null {
  const value = response.headers.get(name);
  if (
    value === null ||
    value.length === 0 ||
    value.length > MAX_RESPONSE_HEADER_VALUE ||
    CONTROL_CHARACTERS.test(value)
  ) {
    return null;
  }
  return value;
}

function addResponseMetadata(response: Response, extras: Record<string, unknown>): void {
  const requestId = responseHeaderValue(response, "x-request-id");
  if (requestId !== null && REQUEST_ID.test(requestId)) extras.request_id = requestId;
  const shouldRetry = response.headers.get("x-should-retry")?.trim().toLowerCase();
  if (shouldRetry === "true" || shouldRetry === "false") {
    extras.should_retry = shouldRetry === "true";
  }
  const retryAfter = responseHeaderValue(response, "retry-after");
  if (retryAfter !== null) extras.retry_after = retryAfter;
}

function unknownResponse(status: number, cause?: unknown): CailError {
  const message = `The CAIL backbone returned an unexpected response (status ${status}).`;
  return cause === undefined
    ? new CailError("unknown_error", message, status)
    : new CailError("unknown_error", message, status, {}, "unknown_error", null, cause);
}

export function boundedBodyError(status: number, kind: "catalog" | "quota", cause?: unknown): CailError {
  const label = kind === "catalog" ? "model catalog" : "quota";
  const message = `The CAIL backbone returned an unexpected ${label} response (status ${status}).`;
  return cause === undefined
    ? new CailError("unknown_error", message, status)
    : new CailError("unknown_error", message, status, {}, "unknown_error", null, cause);
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Body cleanup is best effort and never masks the primary error.
  }
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read();
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        void reader.cancel(abortReason(signal)).catch(() => {});
      } catch {
        // The abort reason is the result that matters.
      }
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<ReadableStreamReadResult<Uint8Array>>;
    try {
      pending = reader.read();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }
    void pending.then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) throw abortReason(signal);
  const contentLength = response.headers.get("content-length");
  if (/^\d+$/.test(contentLength ?? "") && Number(contentLength) > maxBytes) {
    cancelBody(response);
    return null;
  }
  if (response.body === null) {
    const text = await response.text();
    if (signal?.aborted) throw abortReason(signal);
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await readWithSignal(reader, signal);
      if (chunk.done) {
        if (signal?.aborted) throw abortReason(signal);
        return text + decoder.decode();
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        try {
          void reader.cancel().catch(() => {});
        } catch {
          // Cancellation is advisory.
        }
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing a reader is advisory.
    }
  }
}

function envelopeError(value: unknown, status: number): CailError | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const message = ownValue(value, "message");
  const type = ownValue(value, "type");
  const code = ownValue(value, "code");
  const param = ownValue(value, "param");
  const cail = ownProperty(value, "cail");
  const extras = cail.found ? copyExtras(cail.value) : {};
  if (
    typeof message !== "string" ||
    typeof type !== "string" ||
    typeof code !== "string" ||
    (param !== null && typeof param !== "string") ||
    extras === null
  ) {
    return null;
  }
  return new CailError(code, message, status, extras, type, typeof param === "string" ? param : null);
}

export async function parseCailError(response: Response, signal?: AbortSignal): Promise<CailError> {
  let text: string | null = null;
  let cause: unknown;
  try {
    text = await readBoundedText(response, MAX_ERROR_BYTES, signal);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (isAbortError(error)) throw error;
    cause = error;
  }
  let parsed: unknown;
  if (text !== null) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const nested = ownValue(parsed, "error");
    if (nested !== null && typeof nested === "object") {
      const error = envelopeError(nested, response.status);
      if (error !== null) {
        addResponseMetadata(response, error.extras);
        return error;
      }
    }
  }
  const error = cause === undefined
    ? unknownResponse(response.status)
    : unknownResponse(response.status, cause);
  addResponseMetadata(response, error.extras);
  return error;
}

function parseJsonLayer(value: unknown): unknown {
  if (typeof value !== "string" || value.length > MAX_EXTRACT_TEXT) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function wrapperStatus(value: object, fallback: number): number {
  for (const key of ["statusCode", "status"]) {
    const status = ownValue(value, key);
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return fallback;
}

function wrapperHeaders(value: object): Record<string, unknown> {
  const headers = ownValue(value, "responseHeaders");
  if (headers === null || typeof headers !== "object") return {};
  const result: Record<string, unknown> = {};
  const get = (name: string): string | null => {
    try {
      if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name);
    } catch {
      return null;
    }
    const entries = ownEntries(headers);
    const item = entries?.find(([key, itemValue]) => key.toLowerCase() === name);
    return typeof item?.[1] === "string" ? item[1] : null;
  };
  const requestId = get("x-request-id");
  if (requestId !== null && REQUEST_ID.test(requestId) && requestId.length <= MAX_RESPONSE_HEADER_VALUE) {
    result.request_id = requestId;
  }
  const shouldRetry = get("x-should-retry")?.trim().toLowerCase();
  if (shouldRetry === "true" || shouldRetry === "false") result.should_retry = shouldRetry === "true";
  const retryAfter = get("retry-after");
  if (retryAfter !== null && retryAfter.length <= MAX_RESPONSE_HEADER_VALUE && !CONTROL_CHARACTERS.test(retryAfter)) {
    result.retry_after = retryAfter;
  }
  return result;
}

function attachMetadata(error: CailError, metadata: Record<string, unknown>): CailError {
  let extras: Record<string, unknown>;
  let entries: Array<[string, unknown]>;
  try {
    extras = error.extras;
    entries = Object.entries(metadata);
  } catch {
    return error;
  }
  if (extras === null || typeof extras !== "object") return error;
  for (const [key, value] of entries) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    try {
      if (Object.getOwnPropertyDescriptor(extras, key) !== undefined) continue;
      if (!Object.isExtensible(extras)) continue;
      Reflect.defineProperty(extras, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    } catch {
      // Metadata is advisory and must never mask the live error.
    }
  }
  return error;
}

function bareError(value: object, status: number): CailError | null {
  const code = ownValue(value, "code");
  const message = ownValue(value, "message");
  const name = ownValue(value, "name");
  const cail = copyExtras(ownValue(value, "cail"));
  const extras = copyExtras(ownValue(value, "extras"));
  const type = ownValue(value, "type");
  const ownStatus = ownValue(value, "status");
  const marker = name === "CailError" || cail !== null || extras !== null || (typeof ownStatus === "number" && typeof type === "string");
  if (!marker || typeof code !== "string" || typeof message !== "string") return null;
  return new CailError(
    code,
    message,
    typeof ownStatus === "number" && Number.isInteger(ownStatus) && ownStatus >= 0 ? ownStatus : status,
    { ...(cail ?? {}), ...(extras ?? {}) },
    typeof type === "string" ? type : "unknown_error",
    typeof ownValue(value, "param") === "string" ? (ownValue(value, "param") as string) : null,
  );
}

function ownArrayValues(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") return [];
  try {
    if (!Array.isArray(value)) return [];
  } catch {
    return [];
  }
  const length = ownValue(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return [];
  const values: unknown[] = [];
  for (let index = 0; index < Math.min(length, MAX_EXTRACT_LAYERS); index += 1) {
    const item = ownProperty(value, String(index));
    if (item.found) values.push(item.value);
  }
  return values;
}

export function extractCailError(value: unknown): CailError | null {
  const queue: Array<{ value: unknown; status: number; metadata: Record<string, unknown> }> = [
    { value, status: 0, metadata: {} },
  ];
  const seen = new Set<object>();
  let visited = 0;
  while (queue.length > 0 && visited < MAX_EXTRACT_LAYERS) {
    const entry = queue.shift()!;
    const layer = parseJsonLayer(entry.value);
    if ((typeof layer !== "object" && typeof layer !== "function") || layer === null || seen.has(layer)) continue;
    seen.add(layer);
    visited += 1;
    if (isLiveError(layer)) return attachMetadata(layer, entry.metadata);
    const status = wrapperStatus(layer, entry.status);
    const metadata = { ...entry.metadata, ...wrapperHeaders(layer) };
    const nested = ownValue(layer, "error");
    if (nested !== null && typeof nested === "object") {
      const parsed = envelopeError(nested, status);
      if (parsed !== null) return attachMetadata(parsed, metadata);
    }
    const bare = bareError(layer, status);
    if (bare !== null) return attachMetadata(bare, metadata);
    for (const key of ["responseBody", "cause", "error", "data", "lastError"]) {
      const child = ownValue(layer, key);
      if (child !== undefined) queue.push({ value: child, status, metadata });
    }
    for (const child of ownArrayValues(ownValue(layer, "errors"))) {
      queue.push({ value: child, status, metadata });
    }
  }
  return null;
}
