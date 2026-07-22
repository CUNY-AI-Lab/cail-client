import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CailError,
  createCailClient,
  parseCailModelCatalog,
  parseCailError,
  type CailCredential,
} from "../src/index.js";

const contract = JSON.parse(
  readFileSync(
    new URL("../contract/model-gateway-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  catalog: unknown;
  quotaExceeded: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  unsafeMetadataKeys: string[];
};

describe("model-gateway-v1 contract", () => {
  it("parses the plain-data model catalog fixture", () => {
    expect(parseCailModelCatalog(contract.catalog)).toEqual(contract.catalog);
  });

  it("fails closed on duplicate, unreviewed, and malformed entries", () => {
    const valid = parseCailModelCatalog(contract.catalog).data[0]!;
    for (const data of [
      [valid, valid],
      [{ ...valid, pricing_known: "unverified" }],
      [{ ...valid, recommended: false }],
      [{ ...valid, registry_url: "http://example.invalid/model" }],
    ]) {
      expect(() => parseCailModelCatalog({ object: "list", data })).toThrow(
        CailError,
      );
    }
  });

  it("normalizes the quota denial fixture without retrying it", async () => {
    const response = new Response(JSON.stringify(contract.quotaExceeded.body), {
      status: contract.quotaExceeded.status,
      headers: contract.quotaExceeded.headers,
    });
    await expect(parseCailError(response)).resolves.toMatchObject({
      code: "quota_exceeded",
      status: 429,
      extras: { should_retry: false, retry_after_seconds: 3600 },
    });
  });

  it("rejects authority-reserved metadata before fetch", async () => {
    const credential: CailCredential = { kind: "key", token: "sk-cail-test" };
    for (const key of contract.unsafeMetadataKeys) {
      let calls = 0;
      const client = createCailClient({
        baseUrl: "https://api.ailab.example",
        app: "fixture",
        fetchImpl: async () => {
          calls += 1;
          return new Response();
        },
      });
      const metadata = JSON.parse(`{"${key}":"forged"}`) as Record<
        string,
        string
      >;
      await expect(
        client.call("/quota", {}, credential, { metadata }),
      ).rejects.toMatchObject({ code: "invalid_metadata", status: 0 });
      expect(calls).toBe(0);
    }
  });
});
