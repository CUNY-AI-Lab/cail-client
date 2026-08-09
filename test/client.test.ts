import { describe, expect, it, vi } from "vitest";
import { CailError, createCailClient } from "../src/index.js";
import { cailErrorResponse, quotaSnapshotResponse } from "../src/testing.js";

const BASE = "https://gateway.example/api";
const CHAT = `${BASE}/v1/chat/completions`;

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

describe("CAIL Gateway transport", () => {
  it("validates the authority and permits explicit loopback HTTP", () => {
    for (const baseUrl of [
      "http://gateway.example",
      "https://user:pass@gateway.example",
      "https://gateway.example?mode=test",
      "https://gateway.example#fragment",
    ]) {
      expect(() => createCailClient({ baseUrl, app: "test-app", fetchImpl: vi.fn() })).toThrow(CailError);
    }
    expect(() => createCailClient({
      baseUrl: "http://localhost:8787",
      app: "test-app",
      allowInsecureLoopback: true,
      fetchImpl: vi.fn(),
    })).not.toThrow();
  });

  it("sends one bearer credential, app attribution, and Web transport safeguards", async () => {
    const recorded = client(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await recorded.client.run({ model: "@cf/example/model", input: { prompt: "hello" } }, "trusted-token");
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.url).toBe(`${BASE}/v1/run`);
    expect(recorded.calls[0]?.init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer trusted-token");
    expect(headers.get("x-cail-app")).toBe("test-app");
    expect(headers.get("x-cail-identity-jwt")).toBeNull();
    expect(await new Response(recorded.calls[0]?.init.body).json()).toEqual({
      model: "@cf/example/model",
      input: { prompt: "hello" },
    });
  });

  it("uses the identity header for JWT credentials and strips caller auth", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await recorded.client.call(
      "/v1/models",
      { method: "GET", headers: { Authorization: "sdk-placeholder", "X-CAIL-Identity-JWT": "wrong" } },
      { kind: "jwt", token: "trusted-jwt" },
    );
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(headers.get("x-cail-identity-jwt")).toBe("trusted-jwt");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-cail-app")).toBe("test-app");
  });

  it("passes metadata and correlation as validated CAIL headers", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await recorded.client.call(
      "/v1/models",
      { method: "GET", headers: { "X-CAIL-Metadata": JSON.stringify({ existing: "yes" }) } },
      "key-token",
      {
        metadata: { added: 2 },
        correlation: {
          trace_id: "0123456789abcdef0123456789abcdef",
          span_id: "0123456789abcdef",
          trace_flags: 1,
          request_id: "019f8bdc-342a-76e1-ba71-005d69808f86",
        },
      },
    );
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(JSON.parse(headers.get("x-cail-metadata") ?? "")).toEqual({ existing: "yes", added: 2 });
    expect(headers.get("traceparent")).toBe("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    expect(headers.get("x-cail-request-id")).toBe("019f8bdc-342a-76e1-ba71-005d69808f86");
  });

  it("keeps native and OpenAI-shaped request bodies as simple pass-through JSON", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await recorded.client.chatCompletions({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      provider_specific_option: { retained: true },
    }, "key-token");
    expect(recorded.calls[0]?.url).toBe(`${BASE}/v1/chat/completions`);
    expect(await new Response(recorded.calls[0]?.init.body).json()).toEqual({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      provider_specific_option: { retained: true },
    });
  });

  it("adapts chat SDK fetches without buffering successful responses or retrying", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    const recorded = client(response);
    const adapter = recorded.client.chatFetch({ kind: "jwt", token: "trusted-jwt" });
    const returned = await adapter(CHAT, {
      method: "POST",
      headers: { Authorization: "sdk-placeholder", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    });
    expect(returned).toBe(response);
    expect(recorded.calls).toHaveLength(1);
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-cail-identity-jwt")).toBe("trusted-jwt");
    expect(await new Response(recorded.calls[0]?.init.body).json()).toMatchObject({ model: "gpt-test" });
    await expect(returned.text()).resolves.toContain("[DONE]");
  });

  it("throws only Gateway-declared non-retryable chat failures by default", async () => {
    const response = cailErrorResponse(503, {
      error: {
        message: "provider unavailable",
        type: "server_error",
        param: null,
        code: "provider_unavailable",
      },
    }, { "x-should-retry": "false" });
    const recorded = client(response);
    const adapter = recorded.client.chatFetch("key-token");
    await expect(adapter(CHAT, { method: "POST", body: "{}" })).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503,
    });
    expect(recorded.calls).toHaveLength(1);
  });

  it("can return retryable chat failures for SDKs that honor retry headers", async () => {
    const response = new Response(JSON.stringify({ error: { message: "busy" } }), {
      status: 503,
      headers: { "x-should-retry": "true" },
    });
    const recorded = client(response);
    const adapter = recorded.client.chatFetch("key-token", { nonRetryableErrorMode: "return" });
    await expect(adapter(CHAT, { method: "POST", body: "{}" })).resolves.toBe(response);
    expect(recorded.calls).toHaveLength(1);
  });

  it("still invokes the authentication hook when raw chat errors are returned", async () => {
    const response = cailErrorResponse(401, {
      error: {
        message: "Sign-in required",
        type: "authentication_error",
        param: null,
        code: "authentication_required",
      },
    });
    const recorded = wire(response);
    const onAuthRequired = vi.fn();
    const clientWithHook = createCailClient({
      baseUrl: BASE,
      app: "test-app",
      fetchImpl: recorded.fetch,
      onAuthRequired,
    });
    const returned = await clientWithHook.chatFetch("key-token", { nonRetryableErrorMode: "return" })(CHAT, {
      method: "POST",
      body: "{}",
    });
    expect(returned).toBe(response);
    expect(onAuthRequired).toHaveBeenCalledOnce();
  });

  it("invokes the authentication hook without masking the Gateway error", async () => {
    const response = cailErrorResponse(401, {
      error: {
        message: "Sign-in required",
        type: "authentication_error",
        param: null,
        code: "authentication_required",
      },
    }, { "x-should-retry": "false" });
    const recorded = wire(response);
    const onAuthRequired = vi.fn(() => {
      throw new Error("hook detail");
    });
    const clientWithHook = createCailClient({
      baseUrl: BASE,
      app: "test-app",
      fetchImpl: recorded.fetch,
      onAuthRequired,
    });
    await expect(clientWithHook.call("/v1/models", { method: "GET" }, "key-token")).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
    expect(onAuthRequired).toHaveBeenCalledOnce();
  });

  it("keeps public catalog requests free of auth and app headers and validates quota", async () => {
    const catalog = client(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }));
    await catalog.client.getCatalog({ modality: "all" });
    const catalogHeaders = new Headers(catalog.calls[0]?.init.headers);
    expect(catalog.calls[0]?.url).toBe(`${BASE}/v1/catalog?modality=all`);
    expect(catalogHeaders.get("authorization")).toBeNull();
    expect(catalogHeaders.get("x-cail-app")).toBeNull();

    const quota = client(quotaSnapshotResponse());
    await expect(quota.client.getQuota("trusted-token")).resolves.toMatchObject({
      object: "quota",
      managed_by: "cloudflare",
      state: "estimated",
      estimated_remaining: 9_370_000,
      remaining_percent: 94,
    });
  });

  it("does not retry failed requests and never includes credentials in transport errors", async () => {
    const token = "secret-token-value";
    const recorded = client(new Error("private transport detail"));
    await expect(recorded.client.getQuota(token)).rejects.toMatchObject({ code: "network_error", status: 0 });
    expect(recorded.calls).toHaveLength(1);
    await expect(recorded.client.getQuota(token).catch((error: unknown) => error)).resolves.not.toHaveProperty("cause", "private transport detail");
    await expect(recorded.client.getQuota("bad token\n")).rejects.toMatchObject({ code: "invalid_credential", status: 0 });
  });
});
