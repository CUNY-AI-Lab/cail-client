import { describe, expect, it } from "vitest";
import { CailError, extractCailError, parseCailError } from "../src/index.js";
import { cailErrorEnvelope, cailErrorResponse } from "../src/testing.js";

describe("bounded CAIL errors", () => {
  it("preserves the typed envelope while copying safe extras", async () => {
    const response = cailErrorResponse(429, cailErrorEnvelope({
      message: "Budget exhausted.",
      type: "rate_limit_error",
      code: "quota_exceeded",
      cail: { retry_after_seconds: 60 },
    }), {
      "x-request-id": "019f8bdc-342a-76e1-ba71-005d69808f86",
      "x-should-retry": "false",
    });
    const error = await parseCailError(response);
    expect(error).toBeInstanceOf(CailError);
    expect(error).toMatchObject({ code: "quota_exceeded", status: 429, message: "Budget exhausted." });
    expect(error.extras).toMatchObject({ retry_after_seconds: 60, should_retry: false });
  });

  it("fails closed for oversized or malformed bodies without echoing them", async () => {
    const secret = "PRIVATE_BODY_SECRET";
    const oversized = new Response(secret + "x".repeat(70_000), { status: 502 });
    const error = await parseCailError(oversized);
    expect(error.code).toBe("unknown_error");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    await expect(parseCailError(new Response("not json", { status: 500 }))).resolves.toMatchObject({ code: "unknown_error", status: 500 });
  });

  it("extracts nested envelopes without invoking getters or mutating prototypes", () => {
    const envelope = cailErrorEnvelope({ code: "quota_exceeded" });
    const wrapped = {
      statusCode: 429,
      responseBody: JSON.stringify(envelope),
      errors: [new Error("irrelevant")],
    };
    expect(extractCailError(wrapped)).toMatchObject({ code: "quota_exceeded", status: 429 });

    let getterCalled = false;
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "error", {
      enumerable: true,
      get() {
        getterCalled = true;
        return envelope.error;
      },
    });
    expect(extractCailError(hostile)).toBeNull();
    expect(getterCalled).toBe(false);

    const pollutedExtras = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(pollutedExtras, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const polluted = cailErrorEnvelope({ cail: pollutedExtras });
    const extracted = extractCailError(polluted);
    expect(extracted).toBeNull();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("returns live errors when metadata cannot be attached", () => {
    const requestId = "019f8bdc-342a-76e1-ba71-005d69808f86";
    const cases = [
      new CailError("live", "frozen", 500, Object.freeze({})),
      new CailError("live", "sealed", 500, Object.preventExtensions({})),
    ];
    const accessorExtras: Record<string, unknown> = {};
    Object.defineProperty(accessorExtras, "request_id", {
      configurable: false,
      enumerable: true,
      get() {
        throw new Error("extras accessor");
      },
    });
    cases.push(new CailError("live", "accessor", 500, accessorExtras));

    const hasAndDefineTrap = new Proxy({}, {
      has() {
        throw new Error("has trap");
      },
      defineProperty() {
        throw new Error("define trap");
      },
    });
    cases.push(new CailError("live", "proxy", 500, hasAndDefineTrap));

    const descriptorTrap = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
    });
    cases.push(new CailError("live", "descriptor proxy", 500, descriptorTrap));

    for (const live of cases) {
      const wrapped = {
        cause: live,
        responseHeaders: new Headers({ "x-request-id": requestId }),
      };
      expect(() => extractCailError(wrapped)).not.toThrow();
      expect(extractCailError(wrapped)).toBe(live);
    }
  });

  it("bounds hostile wrapper graphs and copies only safe response headers", () => {
    const cycle: Record<string, unknown> = {};
    cycle.cause = cycle;
    expect(() => extractCailError(cycle)).not.toThrow();
    expect(extractCailError(cycle)).toBeNull();

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 300; index += 1) {
      const child: Record<string, unknown> = {};
      deep.cause = child;
      deep = child;
    }
    expect(extractCailError(root)).toBeNull();

    const sparseErrors: unknown[] = [];
    sparseErrors.length = 1_024;
    expect(extractCailError({ errors: sparseErrors })).toBeNull();
    let getterCalled = false;
    const getterErrors: unknown[] = [];
    Object.defineProperty(getterErrors, "0", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("wrapper error getter");
      },
    });
    getterErrors.length = 1;
    expect(() => extractCailError({ errors: getterErrors })).not.toThrow();
    expect(getterCalled).toBe(false);

    const malformed = { statusCode: 502, responseBody: "not-json" };
    expect(extractCailError(malformed)).toBeNull();

    const envelope = cailErrorEnvelope({ code: "quota_exceeded" });
    const extracted = extractCailError({
      statusCode: 429,
      responseBody: JSON.stringify(envelope),
      responseHeaders: {
        "x-request-id": "019f8bdc-342a-76e1-ba71-005d69808f86",
        "x-should-retry": "false",
        "retry-after": "30",
      },
    });
    expect(extracted).toMatchObject({ code: "quota_exceeded", status: 429 });
    expect(extracted?.extras).toMatchObject({
      request_id: "019f8bdc-342a-76e1-ba71-005d69808f86",
      should_retry: false,
      retry_after: "30",
    });

    const hostileHeaders = new Proxy({ "x-request-id": "bad" }, {
      ownKeys() {
        throw new Error("header ownKeys");
      },
    });
    expect(() => extractCailError({ cause: new Error("nope"), responseHeaders: hostileHeaders })).not.toThrow();
  });
});
