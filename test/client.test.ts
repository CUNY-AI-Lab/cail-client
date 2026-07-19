import { describe, expect, it, vi } from "vitest";

import { createCailClient } from "../src/index.js";

const baseUrl = "https://models.example.edu/openai/v1";
const token = "sk-native-user-key";
const identityJwt = "eyJhbGciOiJSUzI1NiJ9.payload.signature";

function clientWith(fetchImpl: typeof fetch) {
  return createCailClient({
    baseUrl,
    app: "agent-studio",
    fetchImpl,
  });
}

describe("configuration", () => {
  it("requires an HTTPS OpenAI /v1 base", () => {
    expect(() =>
      createCailClient({ baseUrl: "https://models.example.edu", app: "app" }),
    ).toThrow("end with");
    expect(() =>
      createCailClient({
        baseUrl: "http://models.example.edu/v1",
        app: "app",
      }),
    ).toThrow("HTTPS");
  });

  it("allows explicit loopback HTTP for local proofs", () => {
    expect(() =>
      createCailClient({
        baseUrl: "http://127.0.0.1:4000/v1/",
        app: "proof",
        allowInsecureLoopback: true,
      }),
    ).not.toThrow();
  });

  it("validates the application slug and bearer token", async () => {
    expect(() =>
      createCailClient({ baseUrl, app: "Agent Studio" }),
    ).toThrow("app must match");

    const client = clientWith(vi.fn());
    await expect(client.models("has a space")).rejects.toThrow("bearer token");
  });
});

describe("wire contract", () => {
  it("uses bearer auth and the configured app header", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("x-cail-identity-jwt")).toBeNull();
      expect(headers.get("x-cail-app")).toBe("agent-studio");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("manual");
      return new Response('{"object":"list","data":[]}', { status: 200 });
    });
    const client = clientWith(fetchImpl as typeof fetch);

    const response = await client.request(
      "models",
      {
        headers: {
          authorization: "Bearer SDK-DUMMY",
          "x-cail-identity-jwt": "legacy",
          "x-cail-app": "spoofed",
        },
      },
      token,
    );

    expect(response.status).toBe(200);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${baseUrl}/models`);
  });

  it("exchanges a CAIL identity JWT and sends only the native key to /v1", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      seen.push({ url, authorization });
      if (url.endsWith("/cail/auth/exchange")) {
        expect(new Headers(init?.headers).get("x-cail-app")).toBe(
          "agent-studio",
        );
        return Response.json({
          access_token: "sk-native-session",
          token_type: "Bearer",
          expires_at: "2099-01-01T00:00:00Z",
        });
      }
      return Response.json({ object: "list", data: [] });
    });
    const firstClient = clientWith(fetchImpl as typeof fetch);
    const secondClient = clientWith(fetchImpl as typeof fetch);

    const [first, second] = await Promise.all([
      firstClient.models(identityJwt),
      secondClient.models(identityJwt),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await firstClient.models(identityJwt)).status).toBe(200);

    expect(seen).toEqual([
      {
        url: "https://models.example.edu/openai/cail/auth/exchange",
        authorization: `Bearer ${identityJwt}`,
      },
      {
        url: `${baseUrl}/models`,
        authorization: "Bearer sk-native-session",
      },
      {
        url: `${baseUrl}/models`,
        authorization: "Bearer sk-native-session",
      },
      {
        url: `${baseUrl}/models`,
        authorization: "Bearer sk-native-session",
      },
    ]);
  });

  it("surfaces a typed exchange failure without sending a model request", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          error: {
            message: "A valid CAIL identity is required.",
            code: "authentication_required",
          },
        },
        { status: 401 },
      ),
    );
    const client = clientWith(fetchImpl as typeof fetch);

    await expect(
      client.models({
        kind: "identity-jwt",
        token: `${identityJwt}.different`,
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the identity JWT only on native key-management routes", async () => {
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toBe(
        "https://models.example.edu/openai/cail/keys",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${identityJwt}`,
      );
      return Response.json(
        {
          id: "hash",
          key: "sk-native-personal",
          name: "Notebook",
          expires_at: null,
        },
        { status: 201 },
      );
    });
    const client = clientWith(fetchImpl as typeof fetch);

    const response = await client.createPersonalKey(identityJwt, "Notebook");
    expect(response.status).toBe(201);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exposes every standard OpenAI endpoint beneath /v1", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 204 });
    });
    const client = clientWith(fetchImpl as typeof fetch);

    await client.request("responses", { method: "POST" }, token);
    await client.request("/embeddings", { method: "POST" }, token);
    await client.request("images/generations", { method: "POST" }, token);

    expect(urls).toEqual([
      `${baseUrl}/responses`,
      `${baseUrl}/embeddings`,
      `${baseUrl}/images/generations`,
    ]);
  });

  it("returns non-2xx responses untouched", async () => {
    const original = new Response(
      JSON.stringify({
        error: { message: "Budget exceeded", type: "budget_exceeded" },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    const client = clientWith(
      vi.fn(async () => original) as unknown as typeof fetch,
    );

    const result = await client.models(token);
    expect(result).toBe(original);
    expect(result.status).toBe(429);
    expect(await result.json()).toEqual({
      error: { message: "Budget exceeded", type: "budget_exceeded" },
    });
  });

  it("returns streaming bodies without buffering or replacement", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          ),
        );
        controller.close();
      },
    });
    const original = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
    const client = clientWith(
      vi.fn(async () => original) as unknown as typeof fetch,
    );

    const result = await client.chatCompletions(
      { model: "cail/default", messages: [], stream: true },
      token,
    );
    expect(result).toBe(original);
    expect(result.body).toBe(body);
    expect(await result.text()).toContain('"content":"Hi"');
  });

  it("passes AbortSignal through to the transport", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = clientWith(fetchImpl as typeof fetch);
    const controller = new AbortController();

    const pending = client.chatCompletions(
      { model: "cail/default", messages: [] },
      token,
      { signal: controller.signal },
    );
    controller.abort(new Error("caller cancelled"));

    await expect(pending).rejects.toThrow("caller cancelled");
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  it("does not follow redirects carrying the bearer token", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/collect" },
      });
    });
    const client = clientWith(fetchImpl as typeof fetch);

    const response = await client.models(token);
    expect(response.status).toBe(302);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAI SDK fetch adapter", () => {
  it("serves normal external OpenAI-compatible paths under the base", async () => {
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/chat/completions`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      return new Response("{}", { status: 200 });
    });
    const openAIFetch = clientWith(
      fetchImpl as typeof fetch,
    ).openAIFetch(token);

    await openAIFetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer unused-sdk-key" },
      body: "{}",
    });
  });

  it("supports Request objects without buffering their bodies", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.body).toBeInstanceOf(ReadableStream);
      expect((init as RequestInit & { duplex?: string }).duplex).toBe("half");
      return new Response(null, { status: 204 });
    });
    const openAIFetch = clientWith(
      fetchImpl as typeof fetch,
    ).openAIFetch(token);
    const request = new Request(`${baseUrl}/responses`, {
      method: "POST",
      body: "{}",
    });

    await openAIFetch(request);
  });

  it("rejects cross-origin, traversal, and paths outside /v1", async () => {
    const fetchImpl = vi.fn();
    const client = clientWith(fetchImpl);
    const openAIFetch = client.openAIFetch(token);

    await expect(
      openAIFetch("https://attacker.example/v1/chat/completions"),
    ).rejects.toThrow("only the configured");
    await expect(
      openAIFetch("https://models.example.edu/openai/v10/chat/completions"),
    ).rejects.toThrow("only the configured");
    await expect(
      client.request("../admin", undefined, token),
    ).rejects.toThrow("beneath");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
