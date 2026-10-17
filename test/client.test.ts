import { describe, expect, it, vi } from "vitest";
import {
  CAIL_GATEWAY_OPENAI_BASE_URL,
  CAIL_GATEWAY_ORIGIN,
  CailError,
  createCailClient,
} from "../src/index.js";
import type {
  CailCallOptions,
  CailChatRequest,
  CailClient,
  CailClientOptions,
  CailCorrelation,
  CailMetadata,
} from "../src/index.js";
import { cailErrorResponse, quotaSnapshotResponse } from "../src/testing.js";

const BASE = "https://gateway.example/api";
const CHAT = `${BASE}/v1/chat/completions`;
const CORRELATION: CailCorrelation = {
  trace_id: "0123456789abcdef0123456789abcdef",
  span_id: "0123456789abcdef",
  trace_flags: 1,
  request_id: "019f8bdc-342a-76e1-ba71-005d69808f86",
};

interface RecordedCall {
  url: string;
  init: RequestInit;
}

interface WiredClient {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

function wire(response: Response | Error): WiredClient {
  const calls: RecordedCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch, calls };
}

function client(response: Response | Error) {
  const recorded = wire(response);
  return {
    ...recorded,
    client: createCailClient({ baseUrl: BASE, app: "test-app", fetchImpl: recorded.fetch }),
  };
}

function sentHeaders(recorded: WiredClient): Headers {
  return new Headers(recorded.calls[0]?.init.headers);
}

interface DelayedBodyResponse {
  response: Response;
  /** Settles when a reader first waits on the body. */
  read: Promise<void>;
  /** Settles when every reader of the body has cancelled it. */
  cancelled: Promise<void>;
}

function delayedBodyResponse(status: number): DelayedBodyResponse {
  let markRead: () => void = () => {};
  let markCancelled: () => void = () => {};
  let releasePull: () => void = () => {};
  const read = new Promise<void>((resolve) => { markRead = resolve; });
  const cancelled = new Promise<void>((resolve) => { markCancelled = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      markRead();
      return new Promise<void>((resolve) => { releasePull = resolve; });
    },
    cancel() {
      markCancelled();
      releasePull();
    },
    // A zero high-water mark keeps the stream from pulling until a reader asks.
  }, { highWaterMark: 0 });
  return {
    response: new Response(stream, {
      status,
      headers: { "content-type": "application/json", "x-should-retry": "true" },
    }),
    read,
    cancelled,
  };
}

const SENTINEL = "PRIVATE_DESCRIPTOR_SENTINEL";

function descriptorTrap<Target extends object>(target: Target): Target {
  return new Proxy(target, {
    getOwnPropertyDescriptor() {
      throw new Error(SENTINEL);
    },
  });
}

describe("CAIL Gateway transport", () => {
  it("rejects a chat request that serializes to nothing", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const request: CailChatRequest = { model: "test", messages: [] };
    Object.assign(request, { toJSON: () => undefined });
    await expect(recorded.client.chatCompletions(request, "key-token"))
      .rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });

  it("defaults to the canonical origin and joins /v1 endpoints once", async () => {
    expect(CAIL_GATEWAY_ORIGIN).toBe("https://tools.ailab.gc.cuny.edu");
    expect(CAIL_GATEWAY_OPENAI_BASE_URL).toBe(`${CAIL_GATEWAY_ORIGIN}/v1`);
    const recorded = wire(new Response("ok", { status: 200 }));
    const canonical = createCailClient({ app: "test-app", fetchImpl: recorded.fetch });

    await canonical.call("/v1/models", { method: "GET" }, "key-token");
    await canonical.chatCompletions({ model: "gpt-test", messages: [] }, "key-token");

    expect(recorded.calls.map(({ url }) => url)).toEqual([
      `${CAIL_GATEWAY_ORIGIN}/v1/models`,
      `${CAIL_GATEWAY_ORIGIN}/v1/chat/completions`,
    ]);
  });

  it.each([
    "http://gateway.example",
    "https://user:pass@gateway.example",
    "https://gateway.example?",
    "https://gateway.example#",
    "https://gateway.example?mode=test",
    "https://gateway.example#fragment",
  ])("rejects the base URL %s", (baseUrl) => {
    expect(() => createCailClient({ baseUrl, app: "test-app", fetchImpl: vi.fn() })).toThrow(CailError);
  });

  it("permits HTTP for an explicitly enabled loopback host", () => {
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
    expect(recorded.calls[0]?.init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
    const headers = sentHeaders(recorded);
    expect(headers.get("authorization")).toBe("Bearer trusted-token");
    expect(headers.get("x-cail-app")).toBe("test-app");
    expect(headers.get("x-cail-identity-jwt")).toBeNull();
    expect(await new Response(recorded.calls[0]?.init.body).json()).toEqual({
      model: "@cf/example/model",
      input: { prompt: "hello" },
    });
  });

  it.each([
    { label: "an HTTP 302", opaque: false },
    { label: "an opaque redirect", opaque: true },
  ])("rejects and cancels $label without another attempt", async ({ opaque }) => {
    const pending = delayedBodyResponse(302);
    if (opaque) {
      Object.defineProperty(pending.response, "type", { value: "opaqueredirect" });
      Object.defineProperty(pending.response, "status", { value: 0 });
    }
    const recorded = client(pending.response);
    await expect(recorded.client.run({ model: "test", input: {} }, "key-token"))
      .rejects.toMatchObject({ code: "unexpected_redirect" });
    await pending.cancelled;
    expect(recorded.calls).toHaveLength(1);
  });

  it("uses the identity header for JWT credentials and strips caller auth", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await recorded.client.call(
      "/v1/models",
      { method: "GET", headers: { Authorization: "sdk-placeholder", "X-CAIL-Identity-JWT": "wrong" } },
      { kind: "jwt", token: "trusted-jwt" },
    );
    const headers = sentHeaders(recorded);
    expect(headers.get("x-cail-identity-jwt")).toBe("trusted-jwt");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-cail-app")).toBe("test-app");
  });

  it("strips Cookie while preserving unrelated provider extension headers", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await recorded.client.call(
      "/v1/models",
      {
        method: "GET",
        headers: {
          Cookie: "session=private",
          "Proxy-Authorization": "Basic private",
          "X-Provider-Trace": "provider-extension",
          "OpenAI-Beta": "assistants=v2",
        },
      },
      "key-token",
    );
    const headers = sentHeaders(recorded);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-provider-trace")).toBe("provider-extension");
    expect(headers.get("openai-beta")).toBe("assistants=v2");
  });

  it("merges call metadata into an existing X-CAIL-Metadata header", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await recorded.client.call(
      "/v1/models",
      { method: "GET", headers: { "X-CAIL-Metadata": JSON.stringify({ existing: "yes" }) } },
      "key-token",
      { metadata: { added: 2 } },
    );
    expect(JSON.parse(sentHeaders(recorded).get("x-cail-metadata") ?? "")).toEqual({ existing: "yes", added: 2 });
  });

  it("sends only enumerable metadata without reading hidden getters", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const metadata: CailMetadata = { added: 2 };
    Object.defineProperty(metadata, "hidden", { enumerable: false, value: "not sent" });
    let hiddenGetterRead = false;
    Object.defineProperty(metadata, "hiddenGetter", {
      enumerable: false,
      get() {
        hiddenGetterRead = true;
        throw new Error("hidden metadata getter must not run");
      },
    });
    await recorded.client.call("/v1/models", { method: "GET" }, "key-token", { metadata });
    expect(JSON.parse(sentHeaders(recorded).get("x-cail-metadata") ?? "")).toEqual({ added: 2 });
    expect(hiddenGetterRead).toBe(false);
  });

  it.each(["user_id", "app", "via"])("rejects the reserved metadata key %s before fetch", async (key) => {
    const recorded = client(new Response("ok", { status: 200 }));
    await expect(recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
      metadata: { [key]: "caller-claimed" },
    })).rejects.toMatchObject({ code: "invalid_metadata", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });

  it("sends correlation as traceparent and X-CAIL-Request-Id headers", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await recorded.client.call("/v1/models", { method: "GET" }, "key-token", { correlation: CORRELATION });
    const headers = sentHeaders(recorded);
    expect(headers.get("traceparent")).toBe("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    expect(headers.get("x-cail-request-id")).toBe("019f8bdc-342a-76e1-ba71-005d69808f86");
  });

  it.each([
    {
      label: "client options",
      code: "invalid_config",
      attempt: async () => {
        createCailClient(descriptorTrap({ baseUrl: BASE, app: "test-app" }));
      },
    },
    {
      label: "a credential",
      code: "invalid_credential",
      attempt: async (target: CailClient) => {
        await target.getQuota(descriptorTrap({ kind: "key" as const, token: "key-token" }));
      },
    },
    {
      label: "a request init",
      code: "invalid_request",
      attempt: async (target: CailClient) => {
        await target.call("/v1/models", descriptorTrap<RequestInit>({ method: "GET" }), "key-token");
      },
    },
    {
      label: "a run request",
      code: "invalid_request",
      attempt: async (target: CailClient) => {
        await target.run(descriptorTrap({ model: "gpt-test", input: { prompt: "hello" } }), "key-token");
      },
    },
  ])("contains a descriptor trap on $label without echoing it", async ({ code, attempt }) => {
    const recorded = client(new Response("ok", { status: 200 }));
    const error = await attempt(recorded.client).then(() => undefined, (caught) => caught);
    expect(error).toBeInstanceOf(CailError);
    expect(error).toMatchObject({ code, status: 0 });
    expect(error.message).not.toContain(SENTINEL);
    expect(recorded.calls).toHaveLength(0);
  });

  it("rejects an explicitly supplied non-callable fetch implementation", () => {
    const invalidOptions: CailClientOptions = { baseUrl: BASE, app: "test-app" };
    Object.defineProperty(invalidOptions, "fetchImpl", { enumerable: true, value: "not-a-fetch" });
    let error: Error | undefined;
    try {
      createCailClient(invalidOptions);
    } catch (caught) {
      if (caught instanceof Error) error = caught;
    }
    expect(error).toMatchObject({ code: "invalid_config", status: 0 });
  });

  it.each([
    ["an uppercase request id", { request_id: CORRELATION.request_id.toUpperCase() }],
    ["an all-zero trace id", { trace_id: "0".repeat(32) }],
    ["an all-zero span id", { span_id: "0".repeat(16) }],
    ["an uppercase tracestate key", { tracestate: "A=value" }],
    ["a duplicate tracestate key", { tracestate: "vendor=value,vendor=other" }],
    ["a tracestate value with =", { tracestate: "vendor=value=other" }],
    ["a tracestate with inner whitespace", { tracestate: "vendor=value, vendor2=other" }],
    ["33 tracestate members", { tracestate: Array.from({ length: 33 }, (_, index) => `v${index}=x`).join(",") }],
    ["a tracestate over 512 characters", { tracestate: `a=${"x".repeat(254)},b=${"y".repeat(254)}` }],
  ])("rejects correlation with %s before fetch", async (_label, override) => {
    const recorded = client(new Response("ok", { status: 200 }));
    await expect(recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
      correlation: { ...CORRELATION, ...override },
    })).rejects.toMatchObject({ code: "invalid_correlation", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });

  it.each([
    {
      label: "metadata whose keys cannot be listed",
      code: "invalid_metadata",
      options: (): CailCallOptions => ({
        metadata: new Proxy<CailMetadata>({}, {
          ownKeys() {
            throw new Error(SENTINEL);
          },
        }),
      }),
    },
    {
      label: "metadata with a throwing getter",
      code: "invalid_metadata",
      options: (): CailCallOptions => {
        const metadata: CailMetadata = {};
        Object.defineProperty(metadata, "private", {
          enumerable: true,
          get() {
            throw new Error(SENTINEL);
          },
        });
        return { metadata };
      },
    },
    {
      label: "a correlation descriptor trap",
      code: "invalid_correlation",
      options: (): CailCallOptions => ({ correlation: descriptorTrap({ ...CORRELATION }) }),
    },
    {
      label: "a correlation with a throwing tracestate getter",
      code: "invalid_correlation",
      options: (): CailCallOptions => {
        const correlation: CailCorrelation = { ...CORRELATION };
        Object.defineProperty(correlation, "tracestate", {
          enumerable: true,
          get() {
            throw new Error(SENTINEL);
          },
        });
        return { correlation };
      },
    },
  ])("contains $label without echoing it", async ({ code, options }) => {
    const recorded = client(new Response("ok", { status: 200 }));
    const error = await recorded.client.call("/v1/models", { method: "GET" }, "key-token", options())
      .catch((caught) => caught);
    expect(error).toMatchObject({ code, status: 0 });
    expect(error.message).not.toContain(SENTINEL);
    expect(recorded.calls).toHaveLength(0);
  });

  it.each([
    {
      label: "an object without AbortSignal methods",
      // SAFETY: this fixture intentionally omits AbortSignal methods to test the
      // transport's structural rejection of a malformed signal.
      options: (): CailCallOptions => ({ signal: { aborted: false } as AbortSignal }),
    },
    {
      label: "a string on a null-prototype options object",
      options: (): CailCallOptions => {
        const options = Object.create(null);
        options.signal = "not-a-signal";
        return options;
      },
    },
  ])("rejects $label as a signal before fetch", async ({ options }) => {
    const recorded = client(new Response("ok", { status: 200 }));
    await expect(recorded.client.call("/v1/models", { method: "GET" }, "key-token", options()))
      .rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(recorded.calls).toHaveLength(0);
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

  it("sends the chatCompletions sessionId as X-CAIL-Session-Id", async () => {
    const direct = client(new Response("ok", { status: 200 }));
    await direct.client.chatCompletions(
      { model: "gpt-test", messages: [] },
      "key-token",
      { sessionId: "conversation-123" },
    );
    expect(sentHeaders(direct).get("x-cail-session-id")).toBe("conversation-123");
  });

  it("replaces a caller session header with the configured chatFetch sessionId", async () => {
    const adapted = client(new Response("ok", { status: 200 }));
    const fetchChat = adapted.client.chatFetch("key-token", {
      sessionId: "conversation-456",
    });
    await fetchChat(CHAT, {
      method: "POST",
      headers: { "x-cail-session-id": "caller-value" },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    });
    expect(sentHeaders(adapted).get("x-cail-session-id")).toBe("conversation-456");
  });

  it.each(["", " conversation", "conversation ", "line\nbreak", "x".repeat(257)])(
    "rejects invalid chat session id %j before fetch",
    async (sessionId) => {
      const recorded = client(new Response("ok", { status: 200 }));
      await expect(
        recorded.client.chatCompletions(
          { model: "gpt-test", messages: [] },
          "key-token",
          { sessionId },
        ),
      ).rejects.toMatchObject({ code: "invalid_session_id", status: 0 });
      expect(recorded.calls).toHaveLength(0);
    },
  );

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
    expect(await new Response(recorded.calls[0]?.init.body).json()).toMatchObject({ model: "gpt-test" });
    await expect(returned.text()).resolves.toContain("[DONE]");
  });

  it("sets duplex before constructing a Node Request for stream bodies", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stream-body"));
        controller.close();
      },
    });
    await recorded.client.chatFetch("key-token")(CHAT, {
      method: "POST",
      body,
    });
    expect(recorded.calls[0]?.init).toMatchObject({ duplex: "half" });
    await expect(new Response(recorded.calls[0]?.init.body).text()).resolves.toBe("stream-body");
  });

  it("cleans up the original response when a delayed retryable error parse aborts", async () => {
    const delayed = delayedBodyResponse(429);
    const recorded = wire(delayed.response);
    const controller = new AbortController();
    const reason = new Error("retry parse cancelled");
    const pending = createCailClient({ baseUrl: BASE, app: "test-app", fetchImpl: recorded.fetch })
      .chatFetch("key-token")(
        CHAT,
        { method: "POST", body: "{}", signal: controller.signal },
      );
    await delayed.read;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await delayed.cancelled;
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

  it("cleans up the original response when raw auth-hook inspection aborts", async () => {
    const delayed = delayedBodyResponse(401);
    const recorded = wire(delayed.response);
    const controller = new AbortController();
    const reason = new Error("auth inspection cancelled");
    const onAuthRequired = vi.fn();
    const clientWithHook = createCailClient({
      baseUrl: BASE,
      app: "test-app",
      fetchImpl: recorded.fetch,
      onAuthRequired,
    });
    const pending = clientWithHook.chatFetch("key-token", { nonRetryableErrorMode: "return" })(CHAT, {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });
    await delayed.read;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await delayed.cancelled;
    expect(onAuthRequired).not.toHaveBeenCalled();
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

  it("sends public catalog requests without auth or app headers", async () => {
    const catalog = client(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }));
    await catalog.client.getCatalog({ modality: "all" });
    const catalogHeaders = sentHeaders(catalog);
    expect(catalog.calls[0]?.url).toBe(`${BASE}/v1/catalog?modality=all`);
    expect(catalogHeaders.get("authorization")).toBeNull();
    expect(catalogHeaders.get("x-cail-app")).toBeNull();
  });

  it("returns the validated quota snapshot from /v1/quota", async () => {
    const quota = client(quotaSnapshotResponse());
    await expect(quota.client.getQuota("trusted-token")).resolves.toMatchObject({
      object: "quota",
      managed_by: "cloudflare",
      state: "estimated",
      estimated_remaining: 9_370_000,
      remaining_percent: 94,
    });
    expect(quota.calls[0]?.url).toBe(`${BASE}/v1/quota`);
  });

  it("rejects a run request whose own input value is undefined", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await expect(recorded.client.run({ model: "gpt-test", input: undefined }, "key-token"))
      .rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });

  it.each([
    ["a function", () => "private"],
    ["a symbol", Symbol("private")],
  ])("rejects a run input that JSON.stringify would omit: %s", async (_label, input) => {
    const recorded = client(new Response("ok", { status: 200 }));
    await expect(recorded.client.run({ model: "gpt-test", input }, "key-token"))
      .rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });

  it("does not let an explicit null option signal fall through to request init", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const controller = new AbortController();
    const malformedOptions = Object.create(null);
    malformedOptions.signal = null;
    await expect(recorded.client.call(
      "/v1/models",
      { method: "GET", signal: controller.signal },
      "key-token",
      malformedOptions,
    )).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });

  it("makes one attempt and reports a network failure without the token or transport detail", async () => {
    const token = "secret-token-value";
    const recorded = client(new Error("private transport detail"));
    const error = await recorded.client.getQuota(token).catch((caught) => caught);
    expect(error).toBeInstanceOf(CailError);
    expect(error).toMatchObject({ code: "network_error", status: 0 });
    expect(recorded.calls).toHaveLength(1);
    expect(Object.hasOwn(error, "cause")).toBe(false);
    // The message is not enumerable, so JSON alone would not show it.
    const exposed = `${error.message}\n${JSON.stringify(error)}`;
    expect(exposed).not.toContain(token);
    expect(exposed).not.toContain("private transport detail");
  });

  it.each(["", " padded", "bad token\n"])("rejects the credential %j before fetch", async (token) => {
    const recorded = client(new Response("ok", { status: 200 }));
    await expect(recorded.client.getQuota(token)).rejects.toMatchObject({ code: "invalid_credential", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });
});
