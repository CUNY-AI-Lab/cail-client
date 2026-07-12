import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CailError,
  createCailClient,
  parseQuotaHeaders,
  type CailCredential,
  type CailQuota,
  type CailQuotaSnapshot,
} from "../src/index.js";
import { envelope, jsonOk, recordingFetch } from "./mock.js";

const BASE = "https://api.ailab.example";
const APP = "alt-text";
const KEY: CailCredential = { kind: "key", token: "sk-cail-xyz" };
const VECTORS_SHA256 =
  "c521fc0744efcac9fbc68d89cf0f7600a9a7a1099bbe9bd99cdb4b84cd50ffce";

const vectorsUrl = new URL("./quota-wire-vectors.json", import.meta.url);
const vectorsBytes = readFileSync(vectorsUrl);
const vectorsText = vectorsBytes.toString("utf8");

interface HeaderCase {
  name: string;
  headers: Record<string, string>;
  expect: CailQuota | null;
}

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
  header_cases: HeaderCase[];
  quota_body_cases: QuotaBodyCase[];
  error_cases: ErrorCase[];
}

const vectors = JSON.parse(vectorsText) as QuotaWireVectors;

function clientFor(response: Response, maxRetries = 2) {
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
  it("pins the vendored quota wire vectors SHA-256", () => {
    expect(createHash("sha256").update(vectorsBytes).digest("hex")).toBe(
      VECTORS_SHA256,
    );
  });

  for (const c of vectors.header_cases) {
    it(`parseQuotaHeaders: ${c.name}`, () => {
      expect(parseQuotaHeaders(new Headers(c.headers))).toEqual(c.expect);
    });
  }

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

  it("getQuota surfaces a persistent 503 without retrying", async () => {
    const { rec, client } = clientFor(
      envelope(503, {
        error: "quota_unavailable",
        message: "The quota meter is unavailable.",
      }),
    );

    const err = await client.getQuota(KEY).catch((e) => e);

    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("quota_unavailable");
    expect(err.status).toBe(503);
    expect(rec.captured).toHaveLength(1);
  });

  it("parseQuotaHeaders returns null when no quota headers are present", () => {
    const response = new Response(null, {
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-123",
      },
    });

    expect(parseQuotaHeaders(response.headers)).toBeNull();
  });
});
