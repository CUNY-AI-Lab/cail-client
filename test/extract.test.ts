/**
 * extractCailError — digging the typed CAIL envelope out of an
 * ALREADY-CONSUMED, SDK-wrapped error object (AI_RetryError →
 * AI_APICallError.responseBody as a JSON string, nested
 * cause/error/data/lastError, errors[] arrays). Cases ported from the
 * studios' previously-duplicated extraction logic.
 */
import { describe, it, expect } from "vitest";
import { extractCailError, CailError } from "../src/index.js";

const QUOTA_ENVELOPE = {
  error: {
    message: "Hourly quota exhausted",
    type: "rate_limit_error",
    param: null,
    code: "quota_exceeded",
    cail: { retry_after_seconds: 3600 },
  },
};

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

  it("is cycle-safe", () => {
    const a: Record<string, unknown> = { name: "AI_RetryError" };
    const b: Record<string, unknown> = { cause: a };
    a["cause"] = b;
    a["errors"] = [b, a];

    expect(extractCailError(a)).toBeNull();
  });
});
