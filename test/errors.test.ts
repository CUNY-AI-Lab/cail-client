import { describe, expect, it, vi } from "vitest";
import { CailError, extractCailError, parseCailError } from "../src/index.js";
import { cailErrorEnvelope, cailErrorResponse } from "../src/testing.js";

const REQUEST_ID = "019f8bdc-342a-76e1-ba71-005d69808f86";

interface CauseNode {
  cause?: CauseNode;
}

/** A Response whose body getter returns a caller-built body object. */
function responseWithBody<Body extends object>(body: Body, status = 500): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, "body", {
    configurable: true,
    get() {
      return body;
    },
  });
  return response;
}

describe("parseCailError", () => {
  it("preserves the typed envelope while copying safe extras", async () => {
    const cailExtras = { retry_after_seconds: 60 };
    Object.defineProperty(cailExtras, "hidden", { enumerable: false, value: "not copied" });
    const response = cailErrorResponse(429, cailErrorEnvelope({
      message: "Budget exhausted.",
      type: "rate_limit_error",
      code: "quota_exceeded",
      cail: cailExtras,
    }), {
      "x-request-id": REQUEST_ID,
      "x-should-retry": "false",
    });
    const error = await parseCailError(response);
    expect(error).toBeInstanceOf(CailError);
    expect(error).toMatchObject({ code: "quota_exceeded", status: 429, message: "Budget exhausted." });
    expect(error.extras).toMatchObject({ retry_after_seconds: 60, should_retry: false });
    expect(error.extras).not.toHaveProperty("hidden");
  });

  it("does not copy an uppercase x-request-id into error extras", async () => {
    const response = cailErrorResponse(429, cailErrorEnvelope({ code: "quota_exceeded" }), {
      "x-request-id": REQUEST_ID.toUpperCase(),
    });
    const parsed = await parseCailError(response);
    expect(parsed.extras.request_id).toBeUndefined();
  });

  it.each([
    ["a non-JSON body", "PRIVATE_BODY_SECRET is not json"],
    ["JSON without a valid envelope", JSON.stringify({ error: { message: "PRIVATE_BODY_SECRET" } })],
  ])("fails closed on %s without echoing it", async (_label, body) => {
    const error = await parseCailError(new Response(body, { status: 502 }));
    expect(error).toMatchObject({ code: "unknown_error", status: 502 });
    expect(error.message).not.toContain("PRIVATE_BODY_SECRET");
    expect(JSON.stringify(error)).not.toContain("PRIVATE_BODY_SECRET");
    expect(Object.hasOwn(error, "cause")).toBe(false);
  });

  it("falls back to unknown_error when CAIL extras nest a body", async () => {
    const envelope = cailErrorEnvelope({ cail: { detail: { raw: "PRIVATE_NESTED_BODY" } } });
    const error = await parseCailError(cailErrorResponse(400, envelope));
    expect(error).toMatchObject({ code: "unknown_error", status: 400 });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_NESTED_BODY");
  });

  it("cancels an in-flight response body with the caller's abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    let cancelReason: unknown;
    let markWaiting: () => void = () => {};
    let releasePull: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("partial"));
      },
      pull() {
        markWaiting();
        return new Promise<void>((resolve) => { releasePull = resolve; });
      },
      cancel(value) {
        cancelReason = value;
        releasePull();
      },
    });
    const pending = parseCailError(new Response(stream, { status: 503 }), controller.signal);
    await waiting;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancelReason).toBe(reason);
  });

  it("rejects with the abort reason when a custom reader never settles", async () => {
    const controller = new AbortController();
    const reason = new Error("never-settling read cancelled");
    let markReading: () => void = () => {};
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    const cancel = vi.fn(async () => {});
    const reader = {
      read: () => {
        markReading();
        return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
      },
      cancel,
      releaseLock: vi.fn(),
    };
    const pending = parseCailError(responseWithBody({ getReader: () => reader }), controller.signal);
    await reading;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reads the body once and cancels it when reader acquisition fails", async () => {
    let bodyReads = 0;
    let cancelCalls = 0;
    const body = {
      getReader() {
        throw new Error("private reader acquisition failure");
      },
      cancel() {
        cancelCalls += 1;
      },
    };
    const response = new Response(null, { status: 500 });
    Object.defineProperty(response, "body", {
      configurable: true,
      get() {
        bodyReads += 1;
        return body;
      },
    });

    const error = await parseCailError(response);
    expect(error).toMatchObject({ code: "unknown_error", status: 500 });
    expect(error.message).not.toContain("private reader acquisition failure");
    expect(bodyReads).toBe(1);
    expect(cancelCalls).toBe(1);
  });
});

describe("extractCailError", () => {
  const envelope = cailErrorEnvelope({ code: "quota_exceeded" });

  it("extracts a buffered SDK wrapper's envelope with the wrapper status", () => {
    const wrapped = {
      statusCode: 429,
      responseBody: JSON.stringify(envelope),
      errors: [new Error("irrelevant")],
    };
    expect(extractCailError(wrapped)).toMatchObject({ code: "quota_exceeded", status: 429 });
  });

  it("does not copy an uppercase x-request-id from wrapper headers", () => {
    const extracted = extractCailError({
      responseBody: JSON.stringify(envelope),
      responseHeaders: { "x-request-id": REQUEST_ID.toUpperCase() },
    });
    expect(extracted?.extras.request_id).toBeUndefined();
  });

  it("does not invoke an accessor that holds the envelope", () => {
    let getterCalled = false;
    const hostile = Object.create(null);
    Object.defineProperty(hostile, "error", {
      enumerable: true,
      get() {
        getterCalled = true;
        return envelope.error;
      },
    });
    expect(extractCailError(hostile)).toBeNull();
    expect(getterCalled).toBe(false);
  });

  it("returns null for a wrapper whose descriptors throw", () => {
    const descriptorTrapped = new Proxy({ error: envelope.error }, {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_EXTRACT_DESCRIPTOR");
      },
    });
    expect(extractCailError(descriptorTrapped)).toBeNull();
  });

  it("extracts an envelope attached to a function wrapper", () => {
    function functionWrapper(): void {}
    Object.defineProperty(functionWrapper, "error", { enumerable: true, value: envelope.error });
    expect(extractCailError(functionWrapper)).toMatchObject({ code: "quota_exceeded", status: 0 });
  });

  it("rejects an envelope whose extras define __proto__", () => {
    const pollutedExtras = Object.create(null);
    // A scalar value, so only the __proto__ key rule can reject it.
    Object.defineProperty(pollutedExtras, "__proto__", {
      enumerable: true,
      value: "polluted",
    });
    expect(extractCailError(cailErrorEnvelope({ cail: pollutedExtras }))).toBeNull();
  });

  it.each([
    { label: "frozen", extras: () => Object.freeze({}) },
    { label: "non-extensible", extras: () => Object.preventExtensions({}) },
    {
      label: "accessor-guarded",
      extras: () => {
        const extras = {};
        Object.defineProperty(extras, "request_id", {
          configurable: false,
          enumerable: true,
          get() {
            throw new Error("extras accessor");
          },
        });
        return extras;
      },
    },
    {
      label: "has/define-trapped",
      extras: () => new Proxy({}, {
        has() {
          throw new Error("has trap");
        },
        defineProperty() {
          throw new Error("define trap");
        },
      }),
    },
    {
      label: "descriptor-trapped",
      extras: () => new Proxy({}, {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        },
      }),
    },
  ])("returns a live error whose extras are $label unchanged", ({ extras }) => {
    const live = new CailError("live", "live error", 500, extras());
    const wrapped = {
      cause: live,
      responseHeaders: new Headers({ "x-request-id": REQUEST_ID }),
    };
    expect(extractCailError(wrapped)).toBe(live);
  });

  it.each([
    {
      label: "a cause cycle",
      wrapper: () => {
        const cycle: CauseNode = {};
        cycle.cause = cycle;
        return cycle;
      },
    },
    {
      label: "a 300-level cause chain",
      wrapper: () => {
        let deep: CauseNode = {};
        for (let index = 0; index < 300; index += 1) deep = { cause: deep };
        return deep;
      },
    },
    {
      label: "a sparse errors array",
      wrapper: () => {
        const sparseErrors: object[] = [];
        sparseErrors.length = 1_024;
        return { errors: sparseErrors };
      },
    },
    { label: "a non-JSON response body", wrapper: () => ({ statusCode: 502, responseBody: "not-json" }) },
    {
      label: "response headers whose keys cannot be listed",
      wrapper: () => ({
        cause: new Error("nope"),
        responseHeaders: new Proxy({ "x-request-id": "bad" }, {
          ownKeys() {
            throw new Error("header ownKeys");
          },
        }),
      }),
    },
  ])("returns null for $label", ({ wrapper }) => {
    expect(extractCailError(wrapper())).toBeNull();
  });

  it("does not invoke a getter in a wrapper errors array", () => {
    let getterCalled = false;
    const getterErrors: object[] = [];
    Object.defineProperty(getterErrors, "0", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("wrapper error getter");
      },
    });
    getterErrors.length = 1;
    expect(extractCailError({ errors: getterErrors })).toBeNull();
    expect(getterCalled).toBe(false);
  });

  it("copies the safe response headers of a wrapper into extras", () => {
    const extracted = extractCailError({
      statusCode: 429,
      responseBody: JSON.stringify(envelope),
      responseHeaders: {
        "x-request-id": REQUEST_ID,
        "x-should-retry": "false",
        "retry-after": "30",
      },
    });
    expect(extracted).toMatchObject({ code: "quota_exceeded", status: 429 });
    expect(extracted?.extras).toMatchObject({
      request_id: REQUEST_ID,
      should_retry: false,
      retry_after: "30",
    });
  });
});
