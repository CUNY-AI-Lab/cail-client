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

function catalogOf<Data>(data: Data) {
  return { object: "list", data };
}

describe("public catalog parser", () => {
  it("accepts enriched catalog entries from every provider", () => {
    const entries = [
      model,
      { ...model, id: "example/chat", upstream_model: "example/chat", provider: "openrouter" },
      { ...model, id: "openai.gpt-oss-20b", upstream_model: "openai.gpt-oss-20b", provider: "bedrock-mantle" },
    ];
    expect(parseCailModelCatalog(catalogOf(entries)).data).toEqual(entries);
  });

  it("rejects duplicate model ids", () => {
    expect(() => parseCailModelCatalog(catalogOf([model, model]))).toThrow(CailError);
  });

  it("rejects an unknown provider", () => {
    expect(() => parseCailModelCatalog(catalogOf([{ ...model, provider: "private" }]))).toThrow(CailError);
  });

  it("drops entry keys outside the catalog contract, including __proto__", () => {
    const polluted = JSON.parse(
      JSON.stringify({ ...model, private_note: "internal" }).replace("{", '{"__proto__":{"polluted":true},'),
    );
    const [entry] = parseCailModelCatalog(catalogOf([polluted])).data;
    expect(entry).toEqual(model);
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
  });

  it.each(["First paragraph.\nSecond paragraph.", "First line.\rSecond line.", "First line.\r\nSecond line."])(
    "preserves Gateway description line breaks: %j",
    (description) => {
      const entry = { ...model, provider: "openrouter", description };
      expect(parseCailModelCatalog(catalogOf([entry])).data).toEqual([entry]);
    },
  );

  it.each(["\u0000", "\t", "\u000b", "\u001f", "\u007f"])(
    "rejects other controls in a multiline description: %j",
    (control) => {
      const entry = { ...model, description: `First line.\nSecond${control}line.\r\n` };
      expect(() => parseCailModelCatalog(catalogOf([entry]))).toThrow(CailError);
    },
  );

  it.each([
    ["id", "\n"], ["id", "\r"],
    ["upstream_model", "\n"], ["upstream_model", "\r"],
    ["name", "\n"], ["name", "\r"],
    ["task", "\n"], ["task", "\r"],
  ])("keeps line breaks invalid in %s: %j", (field, lineBreak) => {
    const entry = { ...model, [field]: `first${lineBreak}second` };
    expect(() => parseCailModelCatalog(catalogOf([entry]))).toThrow(CailError);
  });

  it("rejects an accessor capability without reading it", () => {
    let getterCalled = false;
    const accessorCapabilities: string[] = [];
    Object.defineProperty(accessorCapabilities, "0", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("capability getter must not run");
      },
    });
    accessorCapabilities.length = 1;
    expect(() => parseCailModelCatalog(catalogOf([{ ...model, capabilities: accessorCapabilities }]))).toThrow(CailError);
    expect(getterCalled).toBe(false);
  });

  it.each([
    {
      label: "sparse capabilities",
      catalog: () => {
        const capabilities: string[] = [];
        capabilities.length = 1;
        return catalogOf([{ ...model, capabilities }]);
      },
    },
    { label: "33 capabilities", catalog: () => catalogOf([{ ...model, capabilities: Array.from({ length: 33 }) }]) },
    {
      label: "capabilities whose keys cannot be listed",
      catalog: () => catalogOf([{
        ...model,
        capabilities: new Proxy(["text-generation"], {
          ownKeys() {
            throw new Error("capability ownKeys");
          },
        }),
      }]),
    },
    {
      label: "sparse data",
      catalog: () => {
        const data: object[] = [];
        data.length = 1;
        return catalogOf(data);
      },
    },
    { label: "2,001 entries", catalog: () => catalogOf(Array.from({ length: 2_001 })) },
    {
      label: "data whose keys cannot be listed",
      catalog: () => catalogOf(new Proxy([model], {
        ownKeys() {
          throw new Error("catalog ownKeys");
        },
      })),
    },
  ])("rejects a catalog with $label", ({ catalog }) => {
    expect(() => parseCailModelCatalog(catalog())).toThrow(CailError);
  });

  it("reads capabilities through descriptors when the array traps get", () => {
    const capabilities = new Proxy(["text-generation"], {
      get() {
        throw new Error("capability get");
      },
    });
    expect(parseCailModelCatalog(catalogOf([{ ...model, capabilities }])).data[0]?.capabilities)
      .toEqual(["text-generation"]);
  });

  it("reads data through descriptors when the array traps get", () => {
    const data = new Proxy([model], {
      get() {
        throw new Error("catalog get");
      },
    });
    expect(parseCailModelCatalog(catalogOf(data)).data).toHaveLength(1);
  });
});

describe("quota parser", () => {
  it("accepts the Cloudflare estimate", () => {
    expect(parseCailQuotaSnapshot(validQuota)).toMatchObject({ object: "quota", estimated_remaining: 800 });
  });

  it.each([
    ["a remaining estimate that does not match the limit", { estimated_remaining: 1 }],
    ["a remaining percent that does not match the estimate", { remaining_percent: 1 }],
    ["percents that do not match the estimate", { used_percent: 19, remaining_percent: 81 }],
    ["an undeclared used field", { used: 200 }],
    ["a subject field", { subject: "app-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
  ])("rejects %s", (_label, drift) => {
    expect(() => parseCailQuotaSnapshot({ ...validQuota, ...drift })).toThrow(CailError);
  });

  it("rejects an accessor quota field without reading it", () => {
    let getterCalled = false;
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
  });

  it("reads quota fields through descriptors when the object traps get", () => {
    const trapped = new Proxy({ ...validQuota }, {
      get() {
        throw new Error("quota get trap");
      },
    });
    expect(parseCailQuotaSnapshot(trapped)).toMatchObject({ estimated_remaining: 800 });
  });

  it("contains a descriptor trap without echoing it", () => {
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
