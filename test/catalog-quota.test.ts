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
    expect(parseCailModelCatalog({ object: "list", data: [model] }).data[0]).toMatchObject(model);
    expect(() => parseCailModelCatalog({ object: "list", data: [model, model] })).toThrow(CailError);
    expect(() => parseCailModelCatalog({ object: "list", data: [{ ...model, provider: "private" }] })).toThrow(CailError);
  });

  it("accepts canonical quota values and rejects shape drift", () => {
    const quota = parseCailQuotaSnapshot({
      object: "quota",
      subject: "app-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      unit: "microdollar",
      currency: "USD",
      limit: 1_000,
      used: 200,
      remaining: 800,
      reset: null,
      window_technique: "fixed",
      window_seconds: 60,
      state: "ok",
      enforced: true,
      as_of: 1_720_600_000,
    });
    expect(quota.remaining).toBe(800);
    expect(() => parseCailQuotaSnapshot({ ...quota, remaining: 1 })).toThrow(CailError);
    expect(() => parseCailQuotaSnapshot({ ...quota, subject: "not-a-subject" })).toThrow(CailError);
  });

  it("rejects sparse, accessor, trapped, and oversized catalog arrays without reading getters", () => {
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
    expect(() => parseCailModelCatalog({ object: "list", data: [{ ...model, capabilities: new Array(33) }] })).toThrow(CailError);

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
    expect(() => parseCailModelCatalog({ object: "list", data: new Array(2_001) })).toThrow(CailError);
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
      subject: "app-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      unit: "microdollar",
      currency: "USD",
      limit: 1_000,
      used: 200,
      remaining: 800,
      reset: null,
      window_technique: "fixed",
      window_seconds: 60,
      state: "ok",
      enforced: true,
      as_of: 1_720_600_000,
    };
    const hostile = { ...validQuota } as Record<string, unknown>;
    Object.defineProperty(hostile, "remaining", {
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
    expect(parseCailQuotaSnapshot(trapped)).toMatchObject({ remaining: 800 });
  });
});
