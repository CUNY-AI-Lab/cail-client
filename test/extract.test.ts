/**
 * extractCailError — digging the typed CAIL envelope out of an
 * ALREADY-CONSUMED, SDK-wrapped error object (AI_RetryError →
 * AI_APICallError.responseBody as a JSON string, nested
 * cause/error/data/lastError, errors[] arrays). Cases ported from the
 * studios' previously-duplicated extraction logic.
 */
import { describe, it, expect } from "vitest";
import { extractCailError, CailError } from "../src/index.js";
import {
  extractCailError as extractDistCailError,
  CailError as DistCailError,
} from "../dist/index.js";

const QUOTA_ENVELOPE = {
  error: {
    message: "Hourly quota exhausted",
    type: "rate_limit_error",
    param: null,
    code: "quota_exceeded",
    cail: { retry_after_seconds: 3600 },
  },
};

const implementations = [
  ["source", extractCailError, CailError],
  ["dist", extractDistCailError, DistCailError],
] as const;

describe("extractCailError", () => {
  it("finds the envelope buried in an AI_RetryError's responseBody JSON string", () => {
    const apiCallError = {
      name: "AI_APICallError",
      message: "Too Many Requests",
      statusCode: 429,
      responseBody: JSON.stringify(QUOTA_ENVELOPE),
      responseHeaders: {
        "retry-after": "3600",
        "x-should-retry": "false",
      },
    };
    const retryError = {
      name: "AI_RetryError",
      message: "Failed after 3 attempts. Last error: Too Many Requests",
      errors: [apiCallError, apiCallError, apiCallError],
      lastError: apiCallError,
    };

    const extracted = extractCailError(retryError);

    expect(extracted).toBeInstanceOf(CailError);
    expect(extracted?.code).toBe("quota_exceeded");
    expect(extracted?.type).toBe("rate_limit_error");
    expect(extracted?.message).toBe("Hourly quota exhausted");
    expect(extracted?.status).toBe(429); // adopted from the wrapper's statusCode
    expect(extracted?.extras["retry_after_seconds"]).toBe(3600);
    expect(extracted?.extras["retry_after"]).toBe("3600");
    expect(extracted?.extras["should_retry"]).toBe(false);
  });

  it("descends mixed errors[] arrays and string-JSON data layers together", () => {
    const wrapped = {
      name: "AI_RetryError",
      message: "Failed after 2 attempts.",
      errors: [
        { name: "AI_APICallError", message: "boom", statusCode: 500 },
        {
          name: "AI_APICallError",
          message: "Too Many Requests",
          status: 429,
          data: JSON.stringify({
            error: {
              message: "Hourly quota exhausted. It resets on the hour.",
              type: "rate_limit_error",
              param: null,
              code: "quota_exceeded",
            },
          }),
        },
      ],
    };

    const extracted = extractCailError(wrapped);

    expect(extracted?.code).toBe("quota_exceeded");
    expect(extracted?.message).toBe(
      "Hourly quota exhausted. It resets on the hour.",
    );
    expect(extracted?.status).toBe(429);
    expect(extracted?.extras).toEqual({});
  });

  it("unwraps an envelope handed over as a bare JSON string", () => {
    const extracted = extractCailError(JSON.stringify(QUOTA_ENVELOPE));

    expect(extracted?.code).toBe("quota_exceeded");
    expect(extracted?.message).toBe("Hourly quota exhausted");
    expect(extracted?.status).toBe(0); // no wrapper carried a status
    expect(extracted?.extras["retry_after_seconds"]).toBe(3600);
  });

  it("extracts an envelope whose message is empty (retry hint still survives)", () => {
    const retryError = {
      name: "AI_RetryError",
      errors: [
        {
          name: "AI_APICallError",
          statusCode: 429,
          responseBody: JSON.stringify({
            error: {
              message: "",
              type: "rate_limit_error",
              param: null,
              code: "quota_exceeded",
              cail: { retry_after_seconds: 3600 },
            },
          }),
        },
      ],
    };

    const extracted = extractCailError(retryError);

    expect(extracted?.code).toBe("quota_exceeded");
    expect(extracted?.message).toBe("");
    expect(extracted?.extras["retry_after_seconds"]).toBe(3600);
  });

  it("returns a live CailError instance by reference, even wrapped", () => {
    const original = new CailError(
      "quota_exceeded",
      "Quota message verbatim.",
      429,
      { retry_after_seconds: 1800 },
    );

    expect(extractCailError(original)).toBe(original);
    expect(
      extractCailError({
        name: "AI_RetryError",
        message: "Failed after 1 attempt.",
        errors: [original],
      }),
    ).toBe(original);
    expect(extractCailError(new Error("outer", { cause: original }))).toBe(
      original,
    );
  });

  it("recognizes a bare CailError-shaped copy that crossed a bundle boundary", () => {
    const duck = Object.assign(new Error("Quota exhausted for this window."), {
      code: "quota_exceeded",
      status: 429,
      extras: { retry_after: "3600" },
    });

    const extracted = extractCailError(duck);

    expect(extracted).toBeInstanceOf(CailError);
    expect(extracted?.code).toBe("quota_exceeded");
    expect(extracted?.message).toBe("Quota exhausted for this window.");
    expect(extracted?.status).toBe(429);
    expect(extracted?.extras["retry_after"]).toBe("3600");
  });

  it("extracts non-quota codes too — callers branch on code", () => {
    const extracted = extractCailError({
      name: "AI_APICallError",
      statusCode: 401,
      responseBody: JSON.stringify({
        error: {
          message: "Sign in to continue.",
          type: "authentication_error",
          param: null,
          code: "authentication_required",
          cail: { login_url: "/login" },
        },
      }),
    });

    expect(extracted?.code).toBe("authentication_required");
    expect(extracted?.status).toBe(401);
    expect(extracted?.extras["login_url"]).toBe("/login");
  });

  it("returns null for non-CAIL errors — no status or message-text sniffing", () => {
    expect(extractCailError(null)).toBeNull();
    expect(extractCailError(undefined)).toBeNull();
    expect(extractCailError("plain text")).toBeNull();
    expect(extractCailError({ statusCode: 429 })).toBeNull();
    expect(
      extractCailError({
        name: "AI_RetryError",
        reason: "maxRetriesExceeded",
        lastError: { statusCode: 429 },
        errors: [{ statusCode: 429 }],
      }),
    ).toBeNull();
    expect(
      extractCailError(new Error("upstream returned quota_exceeded")),
    ).toBeNull();
    // Node platform errors carry code+message but no CAIL marker.
    expect(
      extractCailError(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      ),
    ).toBeNull();
    // A shape-invalid envelope is not swallowed into a false positive.
    expect(
      extractCailError({ error: { message: "nope", code: 42, type: "x" } }),
    ).toBeNull();
  });

  it.each(implementations)("%s is cycle-safe", (_build, extract) => {
    const a: Record<string, unknown> = { name: "AI_RetryError" };
    const b: Record<string, unknown> = { cause: a };
    a["cause"] = b;
    a["errors"] = [b, a];

    expect(extract(a)).toBeNull();
  });

  it("preserves only validated response metadata from the nearest SDK wrapper", () => {
    const extracted = extractCailError({
      statusCode: 503,
      responseHeaders: {
        "x-request-id": "11111111-1111-4111-8111-111111111111",
        "x-should-retry": "true",
        "retry-after": "7",
        authorization: "Bearer must-not-be-copied",
      },
      responseBody: JSON.stringify({
        error: {
          message: "Try again later.",
          type: "server_error",
          param: null,
          code: "models_unavailable",
        },
      }),
    });

    expect(extracted?.extras).toEqual({
      request_id: "11111111-1111-4111-8111-111111111111",
      should_retry: true,
      retry_after: "7",
    });
  });

  it("adds validated wrapper retry metadata to a nested live CailError", () => {
    const live = new CailError(
      "upstream_service_error",
      "The outcome is uncertain.",
      502,
    );
    const extracted = extractCailError({
      responseHeaders: {
        "x-request-id": "55555555-5555-4555-8555-555555555555",
        "x-should-retry": "false",
      },
      lastError: live,
    });

    expect(extracted).toBe(live);
    expect(extracted?.extras).toEqual({
      request_id: "55555555-5555-4555-8555-555555555555",
      should_retry: false,
    });
  });

  it.each(implementations)(
    "%s ignores throwing accessors and hostile reflection without losing a safe sibling",
    (_build, extract, ErrorClass) => {
      const sentinel = new Error("PRIVATE_EXTRACT_SENTINEL");
      let getterCalls = 0;
      let prototypeCalls = 0;
      const target = {
        statusCode: 429,
        data: JSON.stringify(QUOTA_ENVELOPE),
        responseHeaders: new Proxy(
          {},
          {
            ownKeys() {
              throw sentinel;
            },
          },
        ),
      };
      Object.defineProperty(target, "responseBody", {
        enumerable: true,
        get() {
          getterCalls++;
          throw sentinel;
        },
      });
      const wrapper = new Proxy(target, {
        getOwnPropertyDescriptor(value, key) {
          if (key === "status") throw sentinel;
          return Reflect.getOwnPropertyDescriptor(value, key);
        },
        getPrototypeOf() {
          prototypeCalls++;
          throw sentinel;
        },
      });

      const extracted = extract(wrapper);

      expect(extracted).toBeInstanceOf(ErrorClass);
      expect(extracted).toMatchObject({
        code: "quota_exceeded",
        status: 429,
        message: "Hourly quota exhausted",
      });
      expect(getterCalls).toBe(0);
      expect(prototypeCalls).toBe(0);
      expect(extracted?.message).not.toContain(sentinel.message);
      expect(JSON.stringify(extracted?.extras)).not.toContain(
        sentinel.message,
      );
    },
  );

  it.each(implementations)(
    "%s returns null without invoking a hostile status accessor",
    (_build, extract) => {
      const sentinel = new Error("PRIVATE_STATUS_SENTINEL");
      let getterCalls = 0;
      const hostile = {};
      Object.defineProperty(hostile, "status", {
        get() {
          getterCalls++;
          throw sentinel;
        },
      });

      expect(extract(hostile)).toBeNull();
      expect(getterCalls).toBe(0);
    },
  );

  it.each(implementations)(
    "%s keeps metadata advisory for frozen and hostile live-error extras",
    (_build, extract, ErrorClass) => {
      const metadata = {
        "x-request-id": "66666666-6666-4666-8666-666666666666",
        "x-should-retry": "false",
      };
      const frozenExtras = Object.freeze({ existing: "preserved" });
      const frozen = new ErrorClass(
        "upstream_service_error",
        "The outcome is uncertain.",
        502,
        frozenExtras,
      );

      const frozenExtracted = extract({
        responseHeaders: metadata,
        cause: frozen,
      });

      expect(frozenExtracted).toBe(frozen);
      expect(frozenExtracted?.extras).toBe(frozenExtras);
      expect(frozenExtracted?.extras).toEqual({ existing: "preserved" });

      const sentinel = new Error("PRIVATE_EXTRAS_SENTINEL");
      let hostileCalls = 0;
      const hostileExtras = new Proxy(
        { existing: "preserved" },
        {
          getOwnPropertyDescriptor(target, key) {
            if (key === "request_id") {
              hostileCalls++;
              throw sentinel;
            }
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      const hostile = new ErrorClass(
        "upstream_service_error",
        "The outcome is uncertain.",
        502,
        hostileExtras,
      );

      const hostileExtracted = extract({
        responseHeaders: metadata,
        cause: hostile,
      });

      expect(hostileExtracted).toBe(hostile);
      expect(hostileExtracted?.extras).toBe(hostileExtras);
      expect(hostileExtracted?.extras["existing"]).toBe("preserved");
      expect(hostileCalls).toBe(1);
      expect(hostileExtracted?.message).not.toContain(sentinel.message);
    },
  );

  it.each(implementations)(
    "%s contains hostile metadata mutation traps without replacing the live error",
    (_build, extract, ErrorClass) => {
      const sentinel = new Error("PRIVATE_METADATA_MUTATION_SENTINEL");
      let hasCalls = 0;
      let setCalls = 0;
      let defineCalls = 0;
      const extras = new Proxy(
        { existing: "preserved" },
        {
          has() {
            hasCalls++;
            throw sentinel;
          },
          set() {
            setCalls++;
            throw sentinel;
          },
          defineProperty() {
            defineCalls++;
            throw sentinel;
          },
        },
      );
      const live = new ErrorClass(
        "upstream_service_error",
        "The outcome is uncertain.",
        502,
        extras,
      );

      const extracted = extract({
        responseHeaders: {
          "x-request-id": "99999999-9999-4999-8999-999999999999",
        },
        lastError: live,
      });

      expect(extracted).toBe(live);
      expect(extracted?.extras).toBe(extras);
      expect(extracted?.extras["existing"]).toBe("preserved");
      expect(hasCalls).toBe(0);
      expect(setCalls).toBe(0);
      expect(defineCalls).toBe(1);
      expect(extracted?.message).not.toContain(sentinel.message);
    },
  );

  it.each(implementations)(
    "%s bounds hostile errors-array traversal while retaining a safe branch",
    (_build, extract, ErrorClass) => {
      const errors = new Array<unknown>(1_000_000);
      errors[255] = QUOTA_ENVELOPE;
      let numericDescriptorReads = 0;
      const boundedErrors = new Proxy(errors, {
        getOwnPropertyDescriptor(target, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) {
            numericDescriptorReads++;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });

      const extracted = extract({ statusCode: 429, errors: boundedErrors });

      expect(extracted).toBeInstanceOf(ErrorClass);
      expect(extracted?.code).toBe("quota_exceeded");
      expect(numericDescriptorReads).toBe(256);
    },
  );

  it.each(implementations)(
    "%s still enriches safely mutable live-error extras without overwriting them",
    (_build, extract, ErrorClass) => {
      const extras = {
        existing: "preserved",
        request_id: "77777777-7777-4777-8777-777777777777",
      };
      const live = new ErrorClass(
        "upstream_service_error",
        "The outcome is uncertain.",
        502,
        extras,
      );

      const extracted = extract({
        responseHeaders: {
          "x-request-id": "88888888-8888-4888-8888-888888888888",
          "x-should-retry": "false",
        },
        lastError: live,
      });

      expect(extracted).toBe(live);
      expect(extracted?.extras).toBe(extras);
      expect(extracted?.extras).toEqual({
        existing: "preserved",
        request_id: "77777777-7777-4777-8777-777777777777",
        should_retry: false,
      });
    },
  );

  it("does not JSON-parse oversized SDK wrapper strings", () => {
    const oversized = JSON.stringify({
      ...QUOTA_ENVELOPE,
      padding: "x".repeat(300_000),
    });
    expect(extractCailError(oversized)).toBeNull();
  });
});
