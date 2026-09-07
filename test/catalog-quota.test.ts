import { describe, expect, it } from "vitest";
import { CailError, parseCailModelCatalog, parseCailQuotaSnapshot } from "../src/index.js";

const model = {
  id: "@cf/example/model",
  object: "model",
  recommended: true,
  tier: "recommended",
  order: 0,
  status: "active",
  modality: "text",
  provider: "workers-ai",
  upstream_model: "@cf/example/model",
  pricing_known: "catalog",
  streaming: false,
  sunset: null,
  capabilities: ["text-generation"],
  context_length: 4096,
  registry_url: null,
  name: "Example",
  description: "A bounded public catalog entry.",
  task: "text",
};

describe("public catalog and quota parsers", () => {
  it("accepts enriched catalog entries and rejects duplicates or pollution", () => {
    const entries = [
      model,
      { ...model, id: "example/chat", upstream_model: "example/chat", provider: "openrouter" },
      { ...model, id: "openai.gpt-oss-20b", upstream_model: "openai.gpt-oss-20b", provider: "bedrock-mantle" },
    ];
    expect(parseCailModelCatalog({ object: "list", data: entries }).data).toEqual(entries);
    expect(() => parseCailModelCatalog({ object: "list", data: [model, model] })).toThrow(CailError);
    expect(() => parseCailModelCatalog({ object: "list", data: [{ ...model, provider: "private" }] })).toThrow(CailError);
  });

  it.each(["First paragraph.\nSecond paragraph.", "First line.\rSecond line.", "First line.\r\nSecond line."])(
    "preserves Gateway description line breaks: %j",
    (description) => {
      const entry = { ...model, provider: "openrouter", description };
      expect(parseCailModelCatalog({ object: "list", data: [entry] }).data).toEqual([entry]);
    },
  );

  it.each(["\u0000", "\t", "\u000b", "\u001f", "\u007f"])(
    "rejects other controls in a multiline description: %j",
    (control) => {
      const entry = { ...model, description: `First line.\nSecond${control}line.\r\n` };
      expect(() => parseCailModelCatalog({ object: "list", data: [entry] })).toThrow(CailError);
    },
  );

  it.each(["id", "upstream_model", "name", "task"])(
    "keeps line breaks invalid in %s",
    (field) => {
      for (const lineBreak of ["\n", "\r"]) {
        const entry = { ...model, [field]: `first${lineBreak}second` };
        expect(() => parseCailModelCatalog({ object: "list", data: [entry] })).toThrow(CailError);
      }
    },
  );

  it("accepts the Cloudflare estimate and rejects shape drift", () => {
    const quota = parseCailQuotaSnapshot({
      object: "quota",
      managed_by: "cloudflare",
      state: "estimated",
      unit: "microdollar",
      currency: "USD",
      limit: 1_000,
      estimated_used: 200,
      estimated_remaining: 800,
      used_percent: 20,
      remaining_percent: 80,
      window_technique: "fixed",
      window_seconds: 60,
      calculated_at: 1_720_600_000,
    });
    expect(quota).toMatchObject({ object: "quota", estimated_remaining: 800 });
    expect(() => parseCailQuotaSnapshot({ ...quota, estimated_remaining: 1 })).toThrow(CailError);
    expect(() => parseCailQuotaSnapshot({ ...quota, remaining_percent: 1 })).toThrow(CailError);
    expect(() => parseCailQuotaSnapshot({ ...quota, used_percent: 19, remaining_percent: 81 })).toThrow(CailError);
    expect(() => parseCailQuotaSnapshot({ ...quota, used: 200 })).toThrow(CailError);
    expect(() => parseCailQuotaSnapshot({ ...quota, subject: "app-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toThrow(CailError);
  });

  it("rejects sparse, accessor, and trapped catalog arrays without reading getters", () => {
    let getterCalled = false;
    const accessorCapabilities: unknown[] = [];
    Object.defineProperty(accessorCapabilities, "0", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("capability getter must not run");
      },
    });
    accessorCapabilities.length = 1;
    expect(() => parseCailModelCatalog({ object: "list", data: [{ ...model, capabilities: accessorCapabilities }] })).toThrow(CailError);
    expect(getterCalled).toBe(false);

    const sparseCapabilities: unknown[] = [];
    sparseCapabilities.length = 1;
    expect(() => parseCailModelCatalog({ object: "list", data: [{ ...model, capabilities: sparseCapabilities }] })).toThrow(CailError);
    expect(() => parseCailModelCatalog({ object: "list", data: [{ ...model, capabilities: Array.from({ length: 33 }) }] })).toThrow(CailError);

    const trappedCapabilities = new Proxy(["text-generation"], {
      ownKeys() {
        throw new Error("capability ownKeys");
      },
    });
    expect(() => parseCailModelCatalog({ object: "list", data: [{ ...model, capabilities: trappedCapabilities }] })).toThrow(CailError);
    const getTrappedCapabilities = new Proxy(["text-generation"], {
      get() {
        throw new Error("capability get");
      },
    });
    expect(parseCailModelCatalog({ object: "list", data: [{ ...model, capabilities: getTrappedCapabilities }] }).data[0]?.capabilities)
      .toEqual(["text-generation"]);

    const sparseData: unknown[] = [];
    sparseData.length = 1;
    expect(() => parseCailModelCatalog({ object: "list", data: sparseData })).toThrow(CailError);
    expect(() => parseCailModelCatalog({ object: "list", data: Array.from({ length: 2_001 }) })).toThrow(CailError);
    const trappedData = new Proxy([model], {
      ownKeys() {
        throw new Error("catalog ownKeys");
      },
    });
    expect(() => parseCailModelCatalog({ object: "list", data: trappedData })).toThrow(CailError);
    const getTrappedData = new Proxy([model], {
      get() {
        throw new Error("catalog get");
      },
    });
    expect(parseCailModelCatalog({ object: "list", data: getTrappedData }).data).toHaveLength(1);
  });

  it("reads quota fields through own data descriptors only", () => {
    let getterCalled = false;
    const validQuota = {
      object: "quota",
      managed_by: "cloudflare",
      state: "estimated",
      unit: "microdollar",
      currency: "USD",
      limit: 1_000,
      estimated_used: 200,
      estimated_remaining: 800,
      used_percent: 20,
      remaining_percent: 80,
      window_technique: "fixed",
      window_seconds: 60,
      calculated_at: 1_720_600_000,
    };
    const hostile = { ...validQuota };
    Object.defineProperty(hostile, "estimated_remaining", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("quota getter must not run");
      },
    });
    expect(() => parseCailQuotaSnapshot(hostile)).toThrow(CailError);
    expect(getterCalled).toBe(false);

    const trapped = new Proxy({ ...validQuota }, {
      get() {
        throw new Error("quota get trap");
      },
    });
    expect(parseCailQuotaSnapshot(trapped)).toMatchObject({ estimated_remaining: 800 });

    const descriptorTrapped = new Proxy({ ...validQuota }, {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_QUOTA_DESCRIPTOR");
      },
    });
    let quotaError: Error | undefined;
    try {
      parseCailQuotaSnapshot(descriptorTrapped);
    } catch (error) {
      if (error instanceof Error) quotaError = error;
    }
    expect(quotaError).toBeInstanceOf(CailError);
    expect(quotaError?.message).not.toContain("PRIVATE_QUOTA_DESCRIPTOR");
  });
});
