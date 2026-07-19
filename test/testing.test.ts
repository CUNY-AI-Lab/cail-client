/**
 * The blessed wire-shape fixtures (`@cuny-ai-lab/cail-client/testing`).
 *
 * Every builder must round-trip through the REAL consumer in this package —
 * `parseCailError`, `extractCailError`, `getQuota`, `parseQuotaHeaders` — so
 * the fixture surface can never drift from what the client actually accepts.
 */
import { describe, expect, it } from "vitest";

import {
  CailError,
  createCailClient,
  extractCailError,
  parseCailError,
  parseQuotaHeaders,
  type CailCredential,
} from "../src/index.js";
import {
  TEST_QUOTA_SUBJECT,
  cailErrorEnvelope,
  cailErrorResponse,
  quotaExceededEnvelope,
  quotaExceededResponse,
  quotaHeaders,
  quotaSnapshotBody,
  quotaSnapshotResponse,
} from "../src/testing.js";
import { recordingFetch } from "./mock.js";

const CRED: CailCredential = { kind: "jwt", token: "header.payload.sig" };

describe("cailErrorEnvelope", () => {
  it("round-trips through parseCailError with message/type/param/code verbatim", async () => {
    const err = await parseCailError(cailErrorResponse(400));
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("invalid_request");
    expect(err.type).toBe("invalid_request_error");
    expect(err.param).toBeNull();
    expect(err.status).toBe(400);
    expect(err.message).toBe("The request was rejected by the CAIL backbone.");
  });

  it("honors overrides, including param and cail extras", async () => {
    const envelope = cailErrorEnvelope({
      message: "Unknown model.",
      type: "invalid_request_error",
      param: "model",
      code: "model_not_found",
      cail: { requested_model: "gpt-nonexistent" },
    });
    const err = await parseCailError(cailErrorResponse(404, envelope));
    expect(err.code).toBe("model_not_found");
    expect(err.param).toBe("model");
    expect(err.extras["requested_model"]).toBe("gpt-nonexistent");
  });

  it("is found by extractCailError as a plain object and as a JSON string", () => {
    const envelope = cailErrorEnvelope({ code: "missing_entitlement" });
    expect(extractCailError(envelope)?.code).toBe("missing_entitlement");
    expect(extractCailError(JSON.stringify(envelope))?.code).toBe(
      "missing_entitlement",
    );
  });
});

describe("quotaExceededEnvelope / quotaExceededResponse", () => {
  it("parses as the canonical quota_exceeded 429 with retry_after_seconds in extras", async () => {
    const err = await parseCailError(quotaExceededResponse());
    expect(err.status).toBe(429);
    expect(err.code).toBe("quota_exceeded");
    expect(err.type).toBe("rate_limit_error");
    expect(err.extras["retry_after_seconds"]).toBe(3600);
    // Response-level advisory metadata is preserved alongside cail extras.
    expect(err.extras["retry_after"]).toBe("3600");
    expect(err.extras["should_retry"]).toBe(false);
  });

  it("honors a retryAfterSeconds override in body and header", async () => {
    const response = quotaExceededResponse({ retryAfterSeconds: 90 });
    expect(response.headers.get("retry-after")).toBe("90");
    const err = await parseCailError(response);
    expect(err.extras["retry_after_seconds"]).toBe(90);
  });

  it("survives SDK wrapping — extractCailError digs it out of a RetryError shape", () => {
    // The AI SDK shape that broke the studios: AI_RetryError → lastError
    // (AI_APICallError) whose responseBody is the envelope as a JSON STRING.
    const sdkWrapped = {
      name: "AI_RetryError",
      errors: [
        {
          name: "AI_APICallError",
          statusCode: 429,
          responseBody: JSON.stringify(quotaExceededEnvelope()),
        },
      ],
      lastError: {
        name: "AI_APICallError",
        statusCode: 429,
        responseBody: JSON.stringify(quotaExceededEnvelope()),
      },
    };
    const extracted = extractCailError(sdkWrapped);
    expect(extracted?.code).toBe("quota_exceeded");
    expect(extracted?.status).toBe(429);
    expect(extracted?.extras["retry_after_seconds"]).toBe(3600);
  });

  it("throws from the real client call path as the same typed error", async () => {
    const fetch = recordingFetch(quotaExceededResponse());
    const client = createCailClient({
      baseUrl: "https://proxy.example",
      app: "testing-fixture",
      fetchImpl: fetch.fn,
    });
    const thrown = await client
      .call("/v1/models", { method: "GET" }, CRED)
      .then(() => null)
      .catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(CailError);
    expect((thrown as CailError).code).toBe("quota_exceeded");
    expect((thrown as CailError).extras["retry_after_seconds"]).toBe(3600);
    // 429 is never retried: exactly one wire call.
    expect(fetch.captured.length).toBe(1);
  });
});

describe("quotaSnapshotBody / quotaSnapshotResponse", () => {
  it("is accepted verbatim by getQuota", async () => {
    const fetch = recordingFetch(quotaSnapshotResponse());
    const client = createCailClient({
      baseUrl: "https://proxy.example",
      app: "testing-fixture",
      fetchImpl: fetch.fn,
    });
    const snapshot = await client.getQuota(CRED);
    expect(snapshot).toEqual({
      subject: TEST_QUOTA_SUBJECT,
      limit: 10_000_000,
      used: 630_000,
      remaining: 9_370_000,
      reset: 1_723_200_000,
      window_seconds: 2_592_000,
      state: "ok",
      enforced: true,
      as_of: 1_720_600_000,
    });
    expect(fetch.one.url).toBe("https://proxy.example/quota");
  });

  it("honors overrides while staying getQuota-valid", async () => {
    const fetch = recordingFetch(
      quotaSnapshotResponse({
        subject: "cail-ffffffffffffffffffffffffffffffff",
        used: 10_250_000,
        remaining: 0,
        state: "stale",
        enforced: false,
      }),
    );
    const client = createCailClient({
      baseUrl: "https://proxy.example",
      app: "testing-fixture",
      fetchImpl: fetch.fn,
    });
    const snapshot = await client.getQuota(CRED);
    expect(snapshot.subject).toBe("cail-ffffffffffffffffffffffffffffffff");
    expect(snapshot.remaining).toBe(0);
    expect(snapshot.state).toBe("stale");
    expect(snapshot.enforced).toBe(false);
  });

  it("ships a canonical-shaped test subject", () => {
    expect(TEST_QUOTA_SUBJECT).toMatch(/^cail-[0-9a-f]{32}$/);
    expect(quotaSnapshotBody().object).toBe("quota");
  });
});

describe("quotaHeaders", () => {
  it("is the exact all-or-none set parseQuotaHeaders accepts", () => {
    expect(parseQuotaHeaders(new Headers(quotaHeaders()))).toEqual({
      limit: 10_000_000,
      used: 630_000,
      remaining: 9_370_000,
      reset: 1_723_200_000,
      window_seconds: 2_592_000,
      state: "ok",
    });
  });

  it("honors overrides", () => {
    const parsed = parseQuotaHeaders(
      new Headers(quotaHeaders({ remaining: 0, used: 10_000_000, state: "stale" })),
    );
    expect(parsed?.remaining).toBe(0);
    expect(parsed?.state).toBe("stale");
  });
});

describe("published testing subpath", () => {
  it("resolves @cuny-ai-lab/cail-client/testing via the exports map", async () => {
    const viaPackage = await import("@cuny-ai-lab/cail-client/testing");
    expect(viaPackage.quotaExceededEnvelope).toBeTypeOf("function");
    expect(viaPackage.quotaSnapshotBody).toBeTypeOf("function");
    expect(viaPackage.cailErrorEnvelope).toBeTypeOf("function");
    expect(viaPackage.TEST_QUOTA_SUBJECT).toBe(TEST_QUOTA_SUBJECT);
  });
});
