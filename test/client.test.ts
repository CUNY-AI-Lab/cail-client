import { describe, expect, it, vi } from "vitest";
import { CailError, createCailClient } from "../src/index.js";
import { cailErrorResponse, quotaSnapshotResponse } from "../src/testing.js";

const BASE = "https://gateway.example/api";

function wire(response: Response | Error): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function client(response: Response | Error) {
  const recorded = wire(response);
  return {
    ...recorded,
    client: createCailClient({ baseUrl: BASE, app: "test-app", fetchImpl: recorded.fetch }),
  };
}

describe("fixed extension routes", () => {
  it("rejects unsafe base URL authority and delimiters", () => {
    for (const baseUrl of [
      "http://gateway.example",
      "https://user:pass@gateway.example",
      "https://gateway.example?",
      "https://gateway.example?mode=test",
      "https://gateway.example#",
      "https://gateway.example#fragment",
    ]) {
      expect(() =>
        createCailClient({ baseUrl, app: "test-app", fetchImpl: vi.fn() }),
      ).toThrow(CailError);
    }
  });

  it("sends one bearer string and fixed transport safety options", async () => {
    const recorded = client(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await recorded.client.run({ model: "@cf/example/model", input: { prompt: "hello" } }, "trusted-token");
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.url).toBe(`${BASE}/v1/run`);
    expect(recorded.calls[0]?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
    });
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer trusted-token");
    expect(headers.get("x-cail-app")).toBe("test-app");
    expect(headers.get("x-cail-identity-jwt")).toBeNull();
    expect(await new Response(recorded.calls[0]?.init.body).json()).toEqual({
      model: "@cf/example/model",
      input: { prompt: "hello" },
    });
  });

  it("does not retry a failed run and keeps the token out of the error", async () => {
    const token = "secret-token-value";
    const recorded = client(cailErrorResponse(503, {
      error: {
        message: "provider unavailable",
        type: "server_error",
        param: null,
        code: "provider_unavailable",
      },
    }));
    await expect(recorded.client.run({ model: "m", input: {} }, token)).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503,
    });
    expect(recorded.calls).toHaveLength(1);
    await expect(recorded.client.run({ model: "m", input: {} }, "bad token\n")).rejects.toMatchObject({
      code: "invalid_credential",
      status: 0,
    });
  });

  it("keeps public catalog requests free of auth and app headers", async () => {
    const recorded = client(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }));
    await recorded.client.getCatalog({ modality: "all" });
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(recorded.calls[0]?.url).toBe(`${BASE}/v1/catalog?modality=all`);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-cail-app")).toBeNull();
    expect(recorded.calls[0]?.init).toMatchObject({ redirect: "error", credentials: "omit" });
  });

  it("parses the bounded authenticated quota snapshot", async () => {
    const recorded = client(quotaSnapshotResponse());
    await expect(recorded.client.getQuota("trusted-token")).resolves.toMatchObject({
      subject: "cail-0123456789abcdef0123456789abcdef",
      remaining: 9_370_000,
    });
    expect(recorded.calls[0]?.url).toBe(`${BASE}/quota`);
    expect(new Headers(recorded.calls[0]?.init.headers).get("authorization")).toBe("Bearer trusted-token");
  });

  it("preserves caller abort reasons and wraps transport failures safely", async () => {
    const reason = new Error("caller abort");
    const recorded = client(new Error("private transport detail"));
    await expect(recorded.client.getQuota("token")).rejects.toMatchObject({ code: "network_error", status: 0 });
    expect(JSON.stringify(await recorded.client.getQuota("token").catch((error: unknown) => error))).not.toContain("private transport detail");
    const controller = new AbortController();
    controller.abort(reason);
    const aborted = client(new Response("{}", { status: 200 }));
    await expect(aborted.client.getQuota("token", { signal: controller.signal })).rejects.toBe(reason);
  });

  it("serializes descriptor data without invoking object or array hooks", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const originalObjectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const originalArrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const objectToJson = vi.fn(() => {
      throw new Error("Object.prototype.toJSON must not run");
    });
    const arrayToJson = vi.fn(() => {
      throw new Error("Array.prototype.toJSON must not run");
    });
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      enumerable: false,
      value: objectToJson,
      writable: true,
    });
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      enumerable: false,
      value: arrayToJson,
      writable: true,
    });
    let proxyToJsonCalled = false;
    const nested = new Proxy({ answer: 42 }, {
      get(target, key, receiver) {
        if (key === "toJSON") {
          proxyToJsonCalled = true;
          throw new Error("proxy toJSON must not run");
        }
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      await recorded.client.run({ model: "m", input: { nested, values: [1, 2] } }, "token");
      expect(JSON.parse(String(recorded.calls[0]?.init.body))).toEqual({
        model: "m",
        input: { nested: { answer: 42 }, values: [1, 2] },
      });
      expect(objectToJson).not.toHaveBeenCalled();
      expect(arrayToJson).not.toHaveBeenCalled();
      expect(proxyToJsonCalled).toBe(false);
    } finally {
      if (originalObjectToJson === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Object.prototype, "toJSON", originalObjectToJson);
      if (originalArrayToJson === undefined) delete (Array.prototype as { toJSON?: unknown }).toJSON;
      else Object.defineProperty(Array.prototype, "toJSON", originalArrayToJson);
    }
  });

  it("rejects descriptor-hostile, cyclic, deep, and oversized inputs", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const invalidInput = async (input: unknown) => {
      await expect(recorded.client.run({ model: "m", input: input as Record<string, unknown> }, "token"))
        .rejects.toMatchObject({ code: "invalid_request", status: 0 });
    };

    let getterCalled = false;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("input getter must not run");
      },
    });
    await invalidInput({ accessor });
    expect(getterCalled).toBe(false);

    const sparse: unknown[] = [];
    sparse.length = 1;
    await invalidInput({ sparse });
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("array getter must not run");
      },
    });
    accessorArray.length = 1;
    await invalidInput({ accessorArray });
    await invalidInput({ oversized: new Array(10_001) });

    const trapped = new Proxy({ value: 1 }, {
      ownKeys() {
        throw new Error("proxy ownKeys");
      },
    });
    await invalidInput({ trapped });

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    await invalidInput({ cycle });
    let deep: Record<string, unknown> = {};
    const deepRoot = deep;
    for (let index = 0; index < 40; index += 1) {
      const child: Record<string, unknown> = {};
      deep.next = child;
      deep = child;
    }
    await invalidInput(deepRoot);

    const many: Record<string, unknown> = {};
    for (let index = 0; index < 10_001; index += 1) many[`key_${index}`] = index;
    await invalidInput(many);
    await invalidInput({ large: "x".repeat(1024 * 1024) });
  });

  it("rejects non-ASCII bearer tokens before constructing headers", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    for (const token of ["token🙂", "token\u200b", "token\n"] as unknown[]) {
      await expect(recorded.client.getQuota(token as string)).rejects.toMatchObject({
        code: "invalid_credential",
        status: 0,
      });
    }
    expect(recorded.calls).toHaveLength(0);
  });
});
