import { describe, expect, it, vi } from "vitest";
import {
  CAIL_GATEWAY_OPENAI_BASE_URL,
  CAIL_GATEWAY_ORIGIN,
  CailError,
  createCailClient,
} from "../src/index.js";
import type { CailChatRequest, CailClientOptions, CailCorrelation, CailMetadata } from "../src/index.js";
import { cailErrorResponse, quotaSnapshotResponse } from "../src/testing.js";

const BASE = "https://gateway.example/api";
const CHAT = `${BASE}/v1/chat/completions`;

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

interface DelayedBodyResponse {
  response: Response;
  wasCancelled: () => boolean;
}

function delayedBodyResponse(status: number): DelayedBodyResponse {
  let releasePull: (() => void) | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>((resolve) => {
        releasePull = resolve;
      });
    },
    cancel() {
      cancelled = true;
      releasePull?.();
    },
  });
  return {
    response: new Response(stream, {
      status,
      headers: { "content-type": "application/json", "x-should-retry": "true" },
    }),
    wasCancelled: () => cancelled,
  };
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

  it("validates the authority and permits explicit loopback HTTP", () => {
    for (const baseUrl of [
      "http://gateway.example",
      "https://user:pass@gateway.example",
      "https://gateway.example?",
      "https://gateway.example#",
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
    expect(recorded.calls[0]?.init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer trusted-token");
    expect(headers.get("x-cail-app")).toBe("test-app");
    expect(headers.get("x-cail-identity-jwt")).toBeNull();
    expect(await new Response(recorded.calls[0]?.init.body).json()).toEqual({
      model: "@cf/example/model",
      input: { prompt: "hello" },
    });
  });

  it("rejects and cancels redirect responses without another attempt", async () => {
    for (const opaque of [false, true]) {
      const pending = delayedBodyResponse(302);
      if (opaque) {
        Object.defineProperty(pending.response, "type", { value: "opaqueredirect" });
        Object.defineProperty(pending.response, "status", { value: 0 });
      }
      const recorded = client(pending.response);
      await expect(recorded.client.run({ model: "test", input: {} }, "key-token"))
        .rejects.toMatchObject({ code: "unexpected_redirect" });
      expect(pending.wasCancelled()).toBe(true);
      expect(recorded.calls).toHaveLength(1);
    }
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
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-provider-trace")).toBe("provider-extension");
    expect(headers.get("openai-beta")).toBe("assistants=v2");
  });

  it("passes metadata and correlation as validated CAIL headers", async () => {
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
    await recorded.client.call(
      "/v1/models",
      { method: "GET", headers: { "X-CAIL-Metadata": JSON.stringify({ existing: "yes" }) } },
      "key-token",
      {
        metadata,
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
    expect(hiddenGetterRead).toBe(false);
    expect(headers.get("traceparent")).toBe("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
    expect(headers.get("x-cail-request-id")).toBe("019f8bdc-342a-76e1-ba71-005d69808f86");
  });

  it("contains descriptor traps at client request boundaries", async () => {
    const optionsProxy = new Proxy({ baseUrl: BASE, app: "test-app" }, {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_OPTIONS_DESCRIPTOR");
      },
    });
    let optionsError: Error | undefined;
    try {
      createCailClient(optionsProxy);
    } catch (error) {
      if (error instanceof Error) optionsError = error;
    }
    expect(optionsError).toBeInstanceOf(CailError);
    expect(optionsError?.message).not.toContain("PRIVATE_OPTIONS_DESCRIPTOR");

    const recorded = client(new Response("ok", { status: 200 }));
    const credentialProxy = new Proxy({ kind: "key" as const, token: "key-token" }, {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_CREDENTIAL_DESCRIPTOR");
      },
    });
    const credentialError = await recorded.client.getQuota(credentialProxy).catch((error) => error);
    expect(credentialError).toMatchObject({ code: "invalid_credential", status: 0 });
    expect(credentialError instanceof Error ? credentialError.message : "").not.toContain("PRIVATE_CREDENTIAL_DESCRIPTOR");

    const initProxy = new Proxy<RequestInit>({ method: "GET" }, {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_INIT_DESCRIPTOR");
      },
    });
    const initError = await recorded.client.call("/v1/models", initProxy, "key-token").catch((error) => error);
    expect(initError).toMatchObject({ code: "invalid_request", status: 0 });
    expect(initError instanceof Error ? initError.message : "").not.toContain("PRIVATE_INIT_DESCRIPTOR");

    const requestProxy = new Proxy({ model: "gpt-test", input: { prompt: "hello" } }, {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_RUN_DESCRIPTOR");
      },
    });
    const requestError = await recorded.client.run(requestProxy, "key-token").catch((error) => error);
    expect(requestError).toMatchObject({ code: "invalid_request", status: 0 });
    expect(requestError instanceof Error ? requestError.message : "").not.toContain("PRIVATE_RUN_DESCRIPTOR");
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
    expect(error?.message).toBe("No fetch implementation is available.");
  });

  it("rejects non-canonical correlation IDs and tracestate", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const baseCorrelation = {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      trace_flags: 1 as const,
      request_id: "019f8bdc-342a-76e1-ba71-005d69808f86",
    };
    await expect(recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
      correlation: { ...baseCorrelation, request_id: baseCorrelation.request_id.toUpperCase() },
    })).rejects.toMatchObject({ code: "invalid_correlation", status: 0 });
    for (const tracestate of [
      "A=value",
      "vendor=value,vendor=other",
      "vendor=value=other",
      "vendor=value, vendor2=other",
      Array.from({ length: 33 }, (_, index) => `v${index}=x`).join(","),
      `a=${"x".repeat(254)},b=${"y".repeat(254)}`,
    ]) {
      await expect(recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
        correlation: { ...baseCorrelation, tracestate },
      })).rejects.toMatchObject({ code: "invalid_correlation", status: 0 });
    }
    expect(recorded.calls).toHaveLength(0);
  });

  it("contains hostile metadata, correlation, and signal options", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const metadataTarget: CailMetadata = {};
    const metadataProxy = new Proxy(metadataTarget, {
      ownKeys() {
        throw new Error("PRIVATE_METADATA");
      },
    });
    const metadataError = await recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
      metadata: metadataProxy,
    }).catch((error) => error);
    expect(metadataError).toMatchObject({ code: "invalid_metadata", status: 0 });
    expect(metadataError instanceof Error ? metadataError.message : "").not.toContain("PRIVATE_METADATA");

    const metadataGetter: Record<string, string | number> = {};
    Object.defineProperty(metadataGetter, "private", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_METADATA_GETTER");
      },
    });
    const getterError = await recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
      metadata: metadataGetter,
    }).catch((error) => error);
    expect(getterError).toMatchObject({ code: "invalid_metadata", status: 0 });
    expect(getterError instanceof Error ? getterError.message : "").not.toContain("PRIVATE_METADATA_GETTER");

    const correlationTarget: CailCorrelation = {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      trace_flags: 1,
      request_id: "019f8bdc-342a-76e1-ba71-005d69808f86",
    };
    const correlationProxy = new Proxy(correlationTarget, {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_CORRELATION");
      },
    });
    const correlationError = await recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
      correlation: correlationProxy,
    }).catch((error) => error);
    expect(correlationError).toMatchObject({ code: "invalid_correlation", status: 0 });
    expect(correlationError instanceof Error ? correlationError.message : "").not.toContain("PRIVATE_CORRELATION");

    const correlationGetter = {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      trace_flags: 1 as const,
      request_id: "019f8bdc-342a-76e1-ba71-005d69808f86",
    };
    Object.defineProperty(correlationGetter, "tracestate", {
      enumerable: true,
      get() {
        throw new Error("PRIVATE_CORRELATION_GETTER");
      },
    });
    const correlationGetterError = await recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
      correlation: correlationGetter,
    }).catch((error) => error);
    expect(correlationGetterError).toMatchObject({ code: "invalid_correlation", status: 0 });
    expect(correlationGetterError instanceof Error ? correlationGetterError.message : "").not.toContain("PRIVATE_CORRELATION_GETTER");

    // SAFETY: this fixture intentionally omits AbortSignal methods to test the
    // transport's structural rejection of a malformed signal.
    const fakeSignal = { aborted: false } as AbortSignal;
    const signalError = await recorded.client.call("/v1/models", { method: "GET" }, "key-token", {
      signal: fakeSignal,
    }).catch((error) => error);
    expect(signalError).toMatchObject({ code: "invalid_request", status: 0 });

    const primitiveSignalOptions = Object.create(null);
    primitiveSignalOptions.signal = "not-a-signal";
    const primitiveSignalError = await recorded.client.call("/v1/models", { method: "GET" }, "key-token", primitiveSignalOptions)
      .catch((error) => error);
    expect(primitiveSignalError).toMatchObject({ code: "invalid_request", status: 0 });
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

  it("adds one validated conversation identifier to both chat transports", async () => {
    const direct = client(new Response("ok", { status: 200 }));
    await direct.client.chatCompletions(
      { model: "gpt-test", messages: [] },
      "key-token",
      { sessionId: "conversation-123" },
    );
    expect(
      new Headers(direct.calls[0]?.init.headers).get("x-cail-session-id"),
    ).toBe("conversation-123");

    const adapted = client(new Response("ok", { status: 200 }));
    const fetchChat = adapted.client.chatFetch("key-token", {
      sessionId: "conversation-456",
    });
    await fetchChat(CHAT, {
      method: "POST",
      headers: { "x-cail-session-id": "caller-value" },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    });
    expect(
      new Headers(adapted.calls[0]?.init.headers).get("x-cail-session-id"),
    ).toBe("conversation-456");
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
    const headers = new Headers(recorded.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-cail-identity-jwt")).toBe("trusted-jwt");
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(delayed.wasCancelled()).toBe(true);
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(delayed.wasCancelled()).toBe(true);
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
    expect(quota.calls[0]?.url).toBe(`${BASE}/v1/quota`);
  });

  it("rejects a run request whose own input value is undefined", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    await expect(recorded.client.run({ model: "gpt-test", input: undefined }, "key-token"))
      .rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });

  it("rejects run inputs that JSON.stringify would omit", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    for (const input of [() => "private", Symbol("private")]) {
      await expect(recorded.client.run({ model: "gpt-test", input }, "key-token"))
        .rejects.toMatchObject({ code: "invalid_request", status: 0 });
    }
    expect(recorded.calls).toHaveLength(0);
  });

  it("does not let an explicit null option signal fall through to request init", async () => {
    const recorded = client(new Response("ok", { status: 200 }));
    const controller = new AbortController();
    await expect(recorded.client.call(
      "/v1/models",
      { method: "GET", signal: controller.signal },
      "key-token",
      (() => {
        const malformedOptions = Object.create(null);
        malformedOptions.signal = null;
        return malformedOptions;
      })(),
    )).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(recorded.calls).toHaveLength(0);
  });

  it("does not retry failed requests and never includes credentials in transport errors", async () => {
    const token = "secret-token-value";
    const recorded = client(new Error("private transport detail"));
    const error = await recorded.client.getQuota(token).catch((value) => value);
    expect(error).toMatchObject({ code: "network_error", status: 0 });
    expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
    expect(recorded.calls).toHaveLength(1);
    await expect(recorded.client.getQuota("bad token\n")).rejects.toMatchObject({ code: "invalid_credential", status: 0 });
  });
});
