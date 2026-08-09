const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const liveErrors = new WeakSet<object>();

/** A safe, typed error returned by the CAIL Gateway or transport boundary. */
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
    if (cause !== undefined) {
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

function own(value: object, key: string): unknown {
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

function entries(value: object): Array<[string, unknown]> | null {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Array<[string, unknown]> = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.enumerable && "value" in descriptor) {
        result.push([key, descriptor.value]);
      }
    }
    return result;
  } catch {
    return null;
  }
}

/** Copy only scalar CAIL extras, never nested bodies or prototype keys. */
function scalarExtras(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (Array.isArray(value)) return null;
  } catch {
    return null;
  }
  const pairs = entries(value);
  if (pairs === null) return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of pairs) {
    if (
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
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true,
    });
  }
  return result;
}

function responseMetadata(response: Response, extras: Record<string, unknown>): void {
  const requestId = response.headers.get("x-request-id");
  if (requestId !== null && REQUEST_ID.test(requestId)) extras.request_id = requestId;
  const shouldRetry = response.headers.get("x-should-retry")?.trim().toLowerCase();
  if (shouldRetry === "true" || shouldRetry === "false") {
    extras.should_retry = shouldRetry === "true";
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && !CONTROL_CHARACTERS.test(retryAfter)) {
    extras.retry_after = retryAfter;
  }
}

function unknownResponse(status: number, cause?: unknown): CailError {
  const message = `The CAIL backbone returned an unexpected response (status ${status}).`;
  return new CailError(
    "unknown_error",
    message,
    status,
    {},
    "unknown_error",
    null,
    cause,
  );
}

export function bodyError(
  status: number,
  kind: "catalog" | "quota",
  cause?: unknown,
): CailError {
  const label = kind === "catalog" ? "model catalog" : "quota";
  return new CailError(
    "unknown_error",
    `The CAIL backbone returned an unexpected ${label} response (status ${status}).`,
    status,
    {},
    "unknown_error",
    null,
    cause,
  );
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
  return value !== null && typeof value === "object" && own(value, "name") === "AbortError";
}

/** Read a response body while preserving a caller-provided abort reason. */
export async function readText(response: Response, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortReason(signal);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  }
  if (signal?.aborted) throw abortReason(signal);
  return text;
}

function envelopeError(value: unknown, status: number): CailError | null {
  if (value === null || typeof value !== "object") return null;
  try {
    if (Array.isArray(value)) return null;
  } catch {
    return null;
  }
  const message = own(value, "message");
  const type = own(value, "type");
  const code = own(value, "code");
  const param = own(value, "param");
  const cail = ownProperty(value, "cail");
  const extras = cail.found ? scalarExtras(cail.value) : {};
  if (
    typeof message !== "string" ||
    typeof type !== "string" ||
    typeof code !== "string" ||
    (param !== null && typeof param !== "string") ||
    extras === null
  ) {
    return null;
  }
  return new CailError(
    code,
    message,
    status,
    extras,
    type,
    typeof param === "string" ? param : null,
  );
}

/** Parse a non-success Gateway response without copying its raw body. */
export async function parseCailError(
  response: Response,
  signal?: AbortSignal,
): Promise<CailError> {
  let parsed: unknown;
  let cause: unknown;
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
    cause = error;
  }

  if (parsed !== null && typeof parsed === "object") {
    const nested = own(parsed, "error");
    const error = nested !== undefined ? envelopeError(nested, response.status) : null;
    if (error !== null) {
      responseMetadata(response, error.extras);
      return error;
    }
  }
  const error = unknownResponse(response.status, cause);
  responseMetadata(response, error.extras);
  return error;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function wrapperStatus(value: object, fallback: number): number {
  for (const key of ["statusCode", "status"]) {
    const status = own(value, key);
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      return status;
    }
  }
  return fallback;
}

function wrapperHeaders(value: object): Record<string, unknown> {
  const raw = own(value, "responseHeaders");
  if (raw === null || typeof raw !== "object") return {};
  const get = (name: string): string | null => {
    try {
      if (typeof Headers !== "undefined" && raw instanceof Headers) return raw.get(name);
    } catch {
      return null;
    }
    const pairs = entries(raw);
    const pair = pairs?.find(([key]) => key.toLowerCase() === name);
    return typeof pair?.[1] === "string" ? pair[1] : null;
  };
  const result: Record<string, unknown> = {};
  const requestId = get("x-request-id");
  if (requestId !== null && REQUEST_ID.test(requestId)) result.request_id = requestId;
  const shouldRetry = get("x-should-retry")?.trim().toLowerCase();
  if (shouldRetry === "true" || shouldRetry === "false") result.should_retry = shouldRetry === "true";
  const retryAfter = get("retry-after");
  if (retryAfter !== null && !CONTROL_CHARACTERS.test(retryAfter)) result.retry_after = retryAfter;
  return result;
}

function attachMetadata(error: CailError, metadata: Record<string, unknown>): CailError {
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

function bareError(value: object, status: number): CailError | null {
  const code = own(value, "code");
  const message = own(value, "message");
  const name = own(value, "name");
  const cail = scalarExtras(own(value, "cail"));
  const extras = scalarExtras(own(value, "extras"));
  const type = own(value, "type");
  const ownStatus = own(value, "status");
  const marked = name === "CailError" || cail !== null || extras !== null ||
    (typeof ownStatus === "number" && typeof type === "string");
  if (!marked || typeof code !== "string" || typeof message !== "string") return null;
  return new CailError(
    code,
    message,
    typeof ownStatus === "number" && Number.isInteger(ownStatus) && ownStatus >= 0
      ? ownStatus
      : status,
    { ...(cail ?? {}), ...(extras ?? {}) },
    typeof type === "string" ? type : "unknown_error",
    typeof own(value, "param") === "string" ? (own(value, "param") as string) : null,
  );
}

/** Extract a CAIL envelope from already-buffered SDK wrapper layers. */
export function extractCailError(value: unknown): CailError | null {
  const queue: Array<{ value: unknown; status: number; metadata: Record<string, unknown> }> = [
    { value, status: 0, metadata: {} },
  ];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const entry = queue.shift()!;
    const layer = parseJson(entry.value);
    if ((typeof layer !== "object" && typeof layer !== "function") || layer === null || seen.has(layer)) {
      continue;
    }
    seen.add(layer);
    if (typeof layer === "object" && layer !== null && liveErrors.has(layer)) {
      return attachMetadata(layer as CailError, entry.metadata);
    }
    const status = wrapperStatus(layer, entry.status);
    const metadata = { ...entry.metadata, ...wrapperHeaders(layer) };
    const nested = own(layer, "error");
    const parsed = nested !== undefined ? envelopeError(nested, status) : null;
    if (parsed !== null) return attachMetadata(parsed, metadata);
    const bare = bareError(layer, status);
    if (bare !== null) return attachMetadata(bare, metadata);
    for (const key of ["responseBody", "cause", "error", "data", "lastError"]) {
      const child = own(layer, key);
      if (child !== undefined) queue.push({ value: child, status, metadata });
    }
    const errors = own(layer, "errors");
    if (errors !== null && typeof errors === "object") {
      let length = 0;
      try {
        if (Array.isArray(errors) && typeof own(errors, "length") === "number") {
          length = Math.max(0, Math.floor(own(errors, "length") as number));
        }
      } catch {
        length = 0;
      }
      for (let index = 0; index < length; index += 1) {
        const child = ownProperty(errors, String(index));
        if (child.found) queue.push({ value: child.value, status, metadata });
      }
    }
  }
  return null;
}
