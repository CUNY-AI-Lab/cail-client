import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CailError,
  createCailClient,
  type CailCredential,
  type CailQuotaSnapshot,
} from "../src/index.js";
import { envelope, jsonOk, recordingFetch } from "./mock.js";

const BASE = "https://api.ailab.example";
const APP = "alt-text";
const KEY: CailCredential = { kind: "key", token: "sk-cail-xyz" };
const vectorsUrl = new URL("./quota-wire-vectors.json", import.meta.url);
const vectorsText = readFileSync(vectorsUrl, "utf8");

interface QuotaBodyCase {
  name: string;
  body: unknown;
  expect: CailQuotaSnapshot;
}

interface ErrorCase {
  name: string;
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  expect_error_code: string;
}

interface QuotaWireVectors {
  quota_body_cases: QuotaBodyCase[];
  error_cases: ErrorCase[];
}

const vectors = JSON.parse(vectorsText) as QuotaWireVectors;

function clientFor(
  response: Parameters<typeof recordingFetch>[0],
  maxRetries = 2,
) {
  const rec = recordingFetch(response);
  const client = createCailClient({
    baseUrl: BASE,
    app: APP,
    fetchImpl: rec.fn,
    maxRetries,
  });
  return { rec, client };
}

describe("quota wire vectors", () => {
  for (const c of vectors.quota_body_cases) {
    it(`getQuota: ${c.name}`, async () => {
      const { rec, client } = clientFor(jsonOk(c.body));

      await expect(client.getQuota(KEY)).resolves.toEqual(c.expect);
      expect(rec.one.url).toBe(`${BASE}/quota`);
      expect(rec.one.method).toBe("GET");
      expect(rec.one.headers["authorization"]).toBe(`Bearer ${KEY.token}`);
      expect(rec.one.headers["x-cail-app"]).toBe(APP);
    });
  }

  for (const c of vectors.error_cases) {
    it(`producer nested error: ${c.name}`, async () => {
      const response = new Response(JSON.stringify(c.body), {
        status: c.status,
        headers: c.headers,
      });
      const { client } = clientFor(response, 0);
      const err = await client.getQuota(KEY).catch((e) => e);

      expect(err).toBeInstanceOf(CailError);
      expect(err.code).toBe(c.expect_error_code);
      expect(err.status).toBe(c.status);
      expect(err.extras.request_id).toBe(c.headers["x-request-id"]);
      expect(err.extras.should_retry).toBe(
        c.headers["x-should-retry"] === "true",
      );
      expect(err.message).toBe(
        (c.body.error as Record<string, unknown>).message,
      );
    });
  }

  it("getQuota retries a persistent retryable 503 once, then surfaces it", async () => {
    const unavailable = () =>
      envelope(
        503,
        {
          error: "quota_unavailable",
          message: "The quota meter is unavailable.",
        },
        { "x-should-retry": "true" },
      );
    const { rec, client } = clientFor([unavailable(), unavailable()]);

    const err = await client.getQuota(KEY).catch((e) => e);

    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("quota_unavailable");
    expect(err.status).toBe(503);
    expect(rec.captured).toHaveLength(2);
  });

  it("getQuota honors maxRetries: 0 and a gateway non-retryable decision", async () => {
    {
      const { rec, client } = clientFor(
        envelope(
          503,
          {
            error: "quota_unavailable",
            message: "The quota meter is unavailable.",
          },
          { "x-should-retry": "true" },
        ),
        0,
      );
      await client.getQuota(KEY).catch(() => {});
      expect(rec.captured).toHaveLength(1);
    }
    {
      const { rec, client } = clientFor(
        envelope(
          503,
          {
            error: "quota_configuration_error",
            message: "The quota read boundary is unavailable.",
          },
          { "x-should-retry": "false" },
        ),
      );
      await client.getQuota(KEY).catch(() => {});
      expect(rec.captured).toHaveLength(1);
    }
  });

  it("getQuota forwards cancellation and preserves the abort reason", async () => {
    const reason = new DOMException("quota read cancelled", "AbortError");
    const controller = new AbortController();
    const { rec, client } = clientFor({ abortableHang: true });
    const pending = client.getQuota(KEY, { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(rec.captured).toHaveLength(1);
  });

  it("getQuota preserves cancellation while parsing its bounded body", async () => {
    const controller = new AbortController();
    const reason = new DOMException("quota body cancelled", "AbortError");
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          init?.signal?.addEventListener(
            "abort",
            () => streamController.error(new TypeError("transport wrapper")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const client = createCailClient({
      baseUrl: BASE,
      app: APP,
      fetchImpl,
    });

    const pending = client.getQuota(KEY, { signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("keeps a quota body-read failure as the private cause", async () => {
    const cause = new Error("PRIVATE_QUOTA_READ_SENTINEL");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(cause);
        },
      }),
      { status: 200 },
    );
    const { client } = clientFor(response, 0);

    const err = await client.getQuota(KEY).catch((error) => error);

    expect(err).toMatchObject({
      code: "unknown_error",
      status: 200,
      message:
        "The CAIL backbone returned an unexpected quota response (status 200).",
      extras: {},
    });
    expect(err.cause).toBe(cause);
    expect(err.message).not.toContain(cause.message);
    expect(JSON.stringify(err.extras)).not.toContain(cause.message);
  });

  it("does not fabricate a quota cause for malformed JSON", async () => {
    const { client } = clientFor(new Response("{", { status: 200 }), 0);
    const err = await client.getQuota(KEY).catch((error) => error);

    expect(err).toMatchObject({ code: "unknown_error", status: 200 });
    expect(Object.hasOwn(err, "cause")).toBe(false);
  });

  it("rejects malformed read-through identity and unit fields", async () => {
    const valid = {
      object: "quota",
      subject: "cail-11111111111111111111111111111111",
      unit: "microdollar",
      currency: "USD",
      window_seconds: 2_592_000,
      limit: 10_000_000,
      used: 630_000,
      remaining: 9_370_000,
      reset: 1_723_200_000,
      window_technique: "sliding",
      as_of: 1_720_600_000,
      state: "ok",
      enforced: true,
    };
    for (const body of [
      { ...valid, subject: "legacy-or-untrusted-subject" },
      { ...valid, unit: "dollar" },
      { ...valid, currency: "EUR" },
      { ...valid, remaining: 123 },
      { ...valid, window_seconds: 0 },
      { ...valid, window_technique: "rolling" },
      { ...valid, window_technique: undefined },
      { ...valid, reset: "unknown" },
    ]) {
      const { client } = clientFor(jsonOk(body), 0);
      await expect(client.getQuota(KEY)).rejects.toMatchObject({
        code: "unknown_error",
      });
    }
  });

  it("accepts an honest unavailable reset and preserves window technique", async () => {
    for (const windowTechnique of ["fixed", "sliding"] as const) {
      const { client } = clientFor(
        jsonOk({
          object: "quota",
          subject: "app-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          unit: "microdollar",
          currency: "USD",
          window_seconds: 2_592_000,
          window_technique: windowTechnique,
          limit: 25_000_000,
          used: 1_000_000,
          remaining: 24_000_000,
          reset: null,
          as_of: 1_720_600_000,
          state: "ok",
          enforced: true,
        }),
        0,
      );
      await expect(client.getQuota(KEY)).resolves.toMatchObject({
        reset: null,
        window_technique: windowTechnique,
      });
    }
  });
});
