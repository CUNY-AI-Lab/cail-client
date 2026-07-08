/**
 * Recording mock `fetch` — the SHADOW proxy.
 *
 * It captures the OUTGOING request (URL + headers + body) exactly as it hits the
 * wire and returns a caller-supplied canned `Response`. The 26 vectors assert
 * invariants on the CAPTURED WIRE, never on the client's internals — so the
 * suite validates the contract independently of the implementation (no circular
 * self-validation).
 */

export interface CapturedRequest {
  url: string;
  method: string;
  /** Lower-cased header name → value, as they reached the wire. */
  headers: Record<string, string>;
  /** The request body, read to text (empty string if none). */
  body: string;
}

/** A canned response, or a sentinel that makes the mock throw a network error. */
export type CannedResponse = Response | { networkError: true };

export interface RecordingFetch {
  /** The injectable `fetchImpl`. */
  readonly fn: typeof fetch;
  /** Every request captured, in order. */
  readonly captured: CapturedRequest[];
  /** Convenience: the single captured request (throws if not exactly one). */
  readonly one: CapturedRequest;
}

/**
 * Build a recording fetch that returns the given canned responses in order
 * (the last is reused if there are more calls than responses).
 */
export function recordingFetch(
  responses: CannedResponse | CannedResponse[],
): RecordingFetch {
  const queue = Array.isArray(responses) ? responses : [responses];
  const captured: CapturedRequest[] = [];
  let call = 0;

  const fn = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String(input);

    const method = (init?.method ?? "GET").toUpperCase();

    // Normalize headers into a lower-cased record — this is the WIRE view.
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      if (typeof Headers !== "undefined" && h instanceof Headers) {
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      }
    }

    // Read the body to text without perturbing what the client sent.
    let body = "";
    const b = init?.body;
    if (typeof b === "string") body = b;
    else if (b != null) body = String(b);

    captured.push({ url, method, headers, body });

    const canned = queue[Math.min(call, queue.length - 1)]!;
    call++;

    if ("networkError" in canned) {
      throw new TypeError("network error: failed to fetch (simulated)");
    }
    return canned;
  }) as typeof fetch;

  return {
    fn,
    captured,
    get one(): CapturedRequest {
      if (captured.length !== 1) {
        throw new Error(
          `expected exactly one captured request, got ${captured.length}`,
        );
      }
      return captured[0]!;
    },
  };
}

/** A 2xx JSON response. */
export function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A CAIL error-envelope response. */
export function envelope(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** A non-JSON error response (e.g. a raw 500 HTML page). */
export function nonJson(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/html" },
  });
}

/**
 * A streaming (SSE) 2xx response whose body emits chunks with a delay between
 * them, so a test can prove the first chunk is readable BEFORE the stream
 * closes (i.e. the client did not buffer it).
 */
export function sseStream(chunks: string[], gapMs = 20): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        controller.enqueue(encoder.encode(chunks[i]!));
        if (i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, gapMs));
        }
      }
      closed = true;
      controller.close();
    },
  });
  const resp = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  // Expose the closed flag for the test via a symbol-free side channel.
  (resp as unknown as { __closed: () => boolean }).__closed = () => closed;
  return resp;
}
