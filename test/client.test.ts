/**
 * The contract vectors (SPEC §5). Each asserts an invariant on the CAPTURED
 * WIRE via the recording mock proxy (test/mock.ts) — never on client internals.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createCailClient,
  CailError,
  parseCailError,
  browserAuthRedirect,
  type CailCredential,
} from "../src/index.js";
import {
  recordingFetch,
  jsonOk,
  envelope,
  nonJson,
  sseStream,
} from "./mock.js";

const BASE = "https://api.ailab.example";
const APP = "alt-text";
const JWT: CailCredential = { kind: "jwt", token: "jwt-token-abc" };
const KEY: CailCredential = { kind: "key", token: "sk-cail-xyz" };

/** Build a client wired to a fresh recording fetch. */
function wired(
  responses: Parameters<typeof recordingFetch>[0],
  opts: Partial<Parameters<typeof createCailClient>[0]> = {},
) {
  const rec = recordingFetch(responses);
  const client = createCailClient({
    baseUrl: BASE,
    app: APP,
    fetchImpl: rec.fn,
    ...opts,
  });
  return { rec, client };
}

function readableBody(text = "hello-stream"): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// ── Credential forwarding (I1) ────────────────────────────────────────────

describe("I1 — exactly one credential on the wire", () => {
  it("V1 jwt path sets X-CAIL-Identity-JWT and no Authorization", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call("/models", { method: "POST" }, JWT);
    expect(rec.one.headers["x-cail-identity-jwt"]).toBe("jwt-token-abc");
    expect(rec.one.headers["authorization"]).toBeUndefined();
  });

  it("V2 jwt path STRIPS a caller-injected dummy Authorization (the footgun)", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call(
      "/models",
      { method: "POST", headers: { Authorization: "Bearer dummy" } },
      JWT,
    );
    expect(rec.one.headers["authorization"]).toBeUndefined();
    expect(rec.one.headers["x-cail-identity-jwt"]).toBe("jwt-token-abc");
  });

  it("V3 key path sets Authorization: Bearer <key> and no JWT header", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call("/models", { method: "POST" }, KEY);
    expect(rec.one.headers["authorization"]).toBe("Bearer sk-cail-xyz");
    expect(rec.one.headers["x-cail-identity-jwt"]).toBeUndefined();
  });

  it("V4 never both credential headers present, either kind", async () => {
    // jwt kind, even with a stray JWT header already in init.
    {
      const { rec, client } = wired(jsonOk({ ok: true }));
      await client.call(
        "/models",
        { headers: { "X-CAIL-Identity-JWT": "stale", Authorization: "Bearer d" } },
        JWT,
      );
      const both =
        "authorization" in rec.one.headers &&
        "x-cail-identity-jwt" in rec.one.headers;
      expect(both).toBe(false);
    }
    // key kind, with a stray JWT header already in init.
    {
      const { rec, client } = wired(jsonOk({ ok: true }));
      await client.call(
        "/models",
        { headers: { "X-CAIL-Identity-JWT": "stale" } },
        KEY,
      );
      const both =
        "authorization" in rec.one.headers &&
        "x-cail-identity-jwt" in rec.one.headers;
      expect(both).toBe(false);
      expect(rec.one.headers["x-cail-identity-jwt"]).toBeUndefined();
    }
  });

  it("V29 token with control characters throws before fetch and does not echo token", async () => {
    const rec = recordingFetch(jsonOk({}));
    const client = createCailClient({
      baseUrl: BASE,
      app: APP,
      fetchImpl: rec.fn,
    });
    const err = await client
      .call("/models", {}, { kind: "key", token: "sk\r\nX-Evil: 1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("invalid_credential");
    expect(err.message).not.toContain("sk\r\nX-Evil");
    expect(rec.captured).toHaveLength(0);
  });
});

// ── Headers: app slug + metadata (I2/I3) ──────────────────────────────────

describe("I2 — X-CAIL-App", () => {
  it("V5 X-CAIL-App present == constructed slug on every call", async () => {
    const { rec, client } = wired([jsonOk({ a: 1 }), jsonOk({ b: 2 })]);
    await client.call("/models", {}, JWT);
    await client.call("/models", {}, KEY);
    expect(rec.captured).toHaveLength(2);
    for (const c of rec.captured) expect(c.headers["x-cail-app"]).toBe(APP);
  });

  it("V5b caller cannot override X-CAIL-App", async () => {
    const { rec, client } = wired(jsonOk({}));
    await client.call("/models", { headers: { "X-CAIL-App": "evil" } }, JWT);
    expect(rec.one.headers["x-cail-app"]).toBe(APP);
  });

  it("array-form duplicate headers are combined like native Headers", async () => {
    const headerPairs: [string, string][] = [
      ["X-Trace", "first"],
      ["X-Trace", "second"],
    ];
    const { rec, client } = wired(jsonOk({}));

    await client.call("/models", { headers: headerPairs }, JWT);

    expect(rec.one.headers["x-trace"]).toBe("first, second");
    expect(rec.one.headers["x-trace"]).toBe(
      new Headers(headerPairs).get("x-trace"),
    );
  });

  it("V6 invalid app slug throws at construct (Bad App / empty / 65 chars)", () => {
    for (const bad of ["Bad App", "", "a".repeat(65), "-lead", "UPPER", "a b"]) {
      expect(() =>
        createCailClient({ baseUrl: BASE, app: bad, fetchImpl: recordingFetch(jsonOk({})).fn }),
      ).toThrowError(CailError);
    }
    // A valid 64-char slug is accepted.
    expect(() =>
      createCailClient({
        baseUrl: BASE,
        app: "a".repeat(64),
        fetchImpl: recordingFetch(jsonOk({})).fn,
      }),
    ).not.toThrow();
  });
});

describe("I3 — X-CAIL-Metadata validation", () => {
  it("V7 metadata {project:'x'} → X-CAIL-Metadata JSON present", async () => {
    const { rec, client } = wired(jsonOk({}));
    await client.call("/models", {}, JWT, { metadata: { project: "x" } });
    expect(rec.one.headers["x-cail-metadata"]).toBe(JSON.stringify({ project: "x" }));
  });

  it("V8 9 keys → throws", async () => {
    const { client } = wired(jsonOk({}));
    const meta: Record<string, string> = {};
    for (let i = 0; i < 9; i++) meta[`k${i}`] = "v";
    await expect(client.call("/models", {}, JWT, { metadata: meta })).rejects.toBeInstanceOf(CailError);
  });

  it("V9 value object/array → throws", async () => {
    const { client } = wired(jsonOk({}));
    await expect(
      client.call("/models", {}, JWT, { metadata: { k: { nested: 1 } as unknown as string } }),
    ).rejects.toBeInstanceOf(CailError);
    await expect(
      client.call("/models", {}, JWT, { metadata: { k: [1, 2] as unknown as string } }),
    ).rejects.toBeInstanceOf(CailError);
  });

  it("V10 value >128 chars → throws", async () => {
    const { client } = wired(jsonOk({}));
    await expect(
      client.call("/models", {}, JWT, { metadata: { k: "a".repeat(129) } }),
    ).rejects.toBeInstanceOf(CailError);
    // exactly 128 is accepted
    const { rec, client: c2 } = wired(jsonOk({}));
    await c2.call("/models", {}, JWT, { metadata: { k: "a".repeat(128) } });
    expect(rec.one.headers["x-cail-metadata"]).toBeDefined();
  });

  it("V11 reserved key (user_id) → throws", async () => {
    const { client } = wired(jsonOk({}));
    for (const reserved of ["user_id", "app", "via"]) {
      await expect(
        client.call("/models", {}, JWT, { metadata: { [reserved]: "x" } }),
      ).rejects.toBeInstanceOf(CailError);
    }
  });

  it("V30 existing metadata __proto__ object value → throws, not silently dropped", async () => {
    const { rec, client } = wired(jsonOk({}));
    const err = await client
      .call(
        "/models",
        {
          headers: {
            "X-CAIL-Metadata":
              '{"__proto__":{"nested":1},"project":"x"}',
          },
        },
        JWT,
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("invalid_metadata");
    expect(rec.captured).toHaveLength(0);
  });

  it("V30b options.metadata constructor key → throws", async () => {
    const { rec, client } = wired(jsonOk({}));
    const metadata = { ["constructor"]: "x" };
    const err = await client
      .call("/models", {}, JWT, { metadata })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("invalid_metadata");
    expect(rec.captured).toHaveLength(0);
  });
});

// ── Error envelope → typed error (I4) ─────────────────────────────────────

describe("I4 — error envelope → typed error, message verbatim", () => {
  it("V12 401 authentication_required carries message + login_url verbatim", async () => {
    const body = {
      error: "authentication_required",
      message: "Your session has expired. Please sign in again.",
      login_url: "/login",
    };
    const { client } = wired(envelope(401, body), {
      onAuthRequired: () => {},
    });
    const err = await client.call("/models", {}, JWT).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("authentication_required");
    expect(err.status).toBe(401);
    expect(err.message).toBe(body.message);
    expect(err.extras["login_url"]).toBe("/login");
  });

  it("V13 429 quota_exceeded carries retry_after_seconds + Retry-After", async () => {
    const body = {
      error: "quota_exceeded",
      message: "You have reached your monthly budget.",
      retry_after_seconds: 3600,
    };
    const { client } = wired(envelope(429, body, { "Retry-After": "3600" }));
    const err = await client.call("/models", {}, KEY).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("quota_exceeded");
    expect(err.status).toBe(429);
    expect(err.extras["retry_after_seconds"]).toBe(3600);
    expect(err.extras["retry_after"]).toBe("3600");
  });

  it("V14 403 forbidden → typed", async () => {
    const { client } = wired(
      envelope(403, { error: "forbidden", message: "Missing entitlement.", missing_entitlement: "pro" }),
    );
    const err = await client.call("/models", {}, KEY).catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(err.status).toBe(403);
    expect(err.extras["missing_entitlement"]).toBe("pro");
  });

  it("V15 409 key_limit_reached → typed", async () => {
    const { client } = wired(
      envelope(409, { error: "key_limit_reached", message: "Too many keys.", limit: 10 }),
    );
    const err = await client.call("/keys", { method: "POST" }, JWT).catch((e) => e);
    expect(err.code).toBe("key_limit_reached");
    expect(err.status).toBe(409);
    expect(err.extras["limit"]).toBe(10);
  });

  it("V16 502 upstream_auth_error → typed", async () => {
    // 502 is 5xx: disable retries so the single envelope surfaces as the error.
    const { client } = wired(
      envelope(502, { error: "upstream_auth_error", message: "Contact ailab@gc.cuny.edu." }),
      { maxRetries: 0 },
    );
    const err = await client.call("/models", {}, KEY).catch((e) => e);
    expect(err.code).toBe("upstream_auth_error");
    expect(err.status).toBe(502);
  });

  it("V17 503 sso_unavailable → typed", async () => {
    const { client } = wired(
      envelope(503, { error: "sso_unavailable", message: "SSO is temporarily down." }),
      { maxRetries: 0 },
    );
    const err = await client.call("/models", {}, JWT).catch((e) => e);
    expect(err.code).toBe("sso_unavailable");
    expect(err.status).toBe(503);
  });

  it("V18 non-JSON 500 body → unknown_error, NOT swallowed as success", async () => {
    const { client } = wired(nonJson(500, "<html>Internal Server Error</html>"), {
      maxRetries: 0,
    });
    const err = await client.call("/models", {}, KEY).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("unknown_error");
    expect(err.status).toBe(500);
    // Prove it was thrown, never returned as a Response.
    expect(err).not.toBeInstanceOf(Response);
  });

  it("V33b non-JSON 503 preserves Retry-After on unknown_error", async () => {
    const { client } = wired(nonJson(503, "busy", { "Retry-After": "7" }), {
      maxRetries: 0,
    });
    const err = await client.call("/models", {}, KEY).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("unknown_error");
    expect(err.status).toBe(503);
    expect(err.extras["retry_after"]).toBe("7");
  });

  it("V19 message is byte-identical to the envelope's message (no rewording)", async () => {
    const exact = "Précisely thîs — verbatim, incl. 中文 & symbols: <>&\"'.";
    const { client } = wired(envelope(400, { error: "bad_request", message: exact }));
    const err = await client.call("/models", {}, KEY).catch((e) => e);
    expect(err.message).toBe(exact);
  });
});

// ── Retry policy (I5) ─────────────────────────────────────────────────────

describe("I5 — retry policy", () => {
  it("forces manual redirects even when the caller requests follow", async () => {
    const rec = recordingFetch(jsonOk({ ok: true }));
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        return rec.fn(input, init);
      },
    ) as typeof fetch;
    const client = createCailClient({
      baseUrl: BASE,
      app: APP,
      fetchImpl,
    });

    await client.call("/models", { redirect: "follow" }, JWT);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(rec.captured).toHaveLength(1);
  });

  it("rejects a proxy redirect as unexpected_redirect without retrying", async () => {
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example/landing" },
    });
    const { rec, client } = wired(redirect);

    const err = await client.call("/models", {}, JWT).catch((e) => e);

    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("unexpected_redirect");
    expect(err.status).toBe(302);
    expect(rec.captured).toHaveLength(1);
  });

  it("V20 500 then 200 → one retry, resolves", async () => {
    const { rec, client } = wired([
      envelope(500, { error: "server_error", message: "oops" }),
      jsonOk({ ok: true }),
    ]);
    const resp = await client.call("/models", { method: "POST" }, KEY);
    expect(resp.status).toBe(200);
    expect(rec.captured).toHaveLength(2);
  });

  it("V21 network-error then 200 → retries", async () => {
    const { rec, client } = wired([{ networkError: true }, jsonOk({ ok: true })]);
    const resp = await client.call("/models", { method: "POST" }, KEY);
    expect(resp.status).toBe(200);
    expect(rec.captured).toHaveLength(2);
  });

  it("V22 400 → NO retry (throws immediately)", async () => {
    const { rec, client } = wired([
      envelope(400, { error: "bad_request", message: "bad" }),
      jsonOk({ ok: true }), // must never be reached
    ]);
    await expect(client.call("/models", {}, KEY)).rejects.toBeInstanceOf(CailError);
    expect(rec.captured).toHaveLength(1);
  });

  it("V23 429 → NO retry", async () => {
    const { rec, client } = wired([
      envelope(429, { error: "quota_exceeded", message: "budget" }),
      jsonOk({ ok: true }),
    ]);
    await expect(client.call("/models", {}, KEY)).rejects.toBeInstanceOf(CailError);
    expect(rec.captured).toHaveLength(1);
  });

  it("V23b retries exhausted on persistent 5xx → throws typed", async () => {
    // One envelope per expected wire call (the mock throws on over-calling).
    const down = () => envelope(500, { error: "server_error", message: "still down" });
    const { rec, client } = wired([down(), down(), down()], { maxRetries: 2 });
    const err = await client.call("/models", {}, KEY).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(rec.captured).toHaveLength(3); // 1 + 2 retries
  });

  it("buffered model POST retries network loss with one stable idempotency key", async () => {
    const { rec, client } = wired([{ networkError: true }, jsonOk({ ok: true })]);

    const response = await client.run(
      { model: "@cf/m/x", input: { prompt: "hi" } },
      KEY,
    );

    expect(response.status).toBe(200);
    expect(rec.captured).toHaveLength(2);
    const firstKey = rec.captured[0]!.headers["idempotency-key"];
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.captured[1]!.headers["idempotency-key"]).toBe(firstKey);
  });

  it("buffered model POST retries an in-progress idempotency conflict", async () => {
    const { rec, client } = wired([
      envelope(
        409,
        { error: "idempotency_in_progress", message: "still running" },
        { "retry-after": "0" },
      ),
      jsonOk({ ok: true }),
    ]);

    const response = await client.run(
      { model: "@cf/m/x", input: { prompt: "hi" } },
      KEY,
    );

    expect(response.status).toBe(200);
    expect(rec.captured).toHaveLength(2);
    expect(rec.captured[1]!.headers["idempotency-key"]).toBe(
      rec.captured[0]!.headers["idempotency-key"],
    );
  });

  it("does not retry an unrelated 409 on a buffered model POST", async () => {
    const { rec, client } = wired([
      envelope(409, { error: "conflict", message: "not retryable" }),
      jsonOk({ ok: true }),
    ]);

    await expect(
      client.run({ model: "@cf/m/x", input: { prompt: "hi" } }, KEY),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });
    expect(rec.captured).toHaveLength(1);
  });

  it("model POST 5xx is never retried without gateway idempotency", async () => {
    const { rec, client } = wired([
      envelope(503, { error: "server_error", message: "uncertain execution" }),
      jsonOk({ ok: true }),
    ]);

    await expect(
      client.chatCompletions({ model: "@cf/m/x", messages: [] }, KEY),
    ).rejects.toMatchObject({ code: "server_error", status: 503 });

    expect(rec.captured).toHaveLength(1);
  });

  it("V23c present-but-invalid maxRetries throws invalid_config at construction (never silently coerced)", () => {
    for (const bad of [
      NaN,
      Infinity,
      -Infinity,
      -1,
      2.5,
      "3" as unknown as number,
    ]) {
      let err: unknown = null;
      try {
        createCailClient({
          baseUrl: BASE,
          app: APP,
          fetchImpl: recordingFetch(jsonOk({})).fn,
          maxRetries: bad,
        });
      } catch (e) {
        err = e;
      }
      expect(err, `maxRetries=${String(bad)} must throw`).toBeInstanceOf(CailError);
      expect((err as CailError).code).toBe("invalid_config");
      expect((err as CailError).message).toContain("maxRetries");
    }
  });

  it("V23d absent maxRetries defaults to 2 (1 + 2 attempts); valid values honored", async () => {
    // Absent → default 2 retries: exactly three wire calls.
    const down = () => envelope(500, { error: "server_error", message: "still down" });
    {
      const { rec, client } = wired([down(), down(), down()]);
      const err = await client.call("/models", {}, KEY).catch((e) => e);
      expect(err).toBeInstanceOf(CailError);
      expect(rec.captured).toHaveLength(3);
    }
    // Valid 0 honored: exactly one wire call.
    {
      const { rec, client } = wired(down(), { maxRetries: 0 });
      await client.call("/models", {}, KEY).catch(() => {});
      expect(rec.captured).toHaveLength(1);
    }
    // Valid 1 honored: exactly two wire calls.
    {
      const { rec, client } = wired([down(), down()], { maxRetries: 1 });
      await client.call("/models", {}, KEY).catch(() => {});
      expect(rec.captured).toHaveLength(2);
    }
  });

  it("V27 abort mid-flight rejects with original AbortError and does not retry", async () => {
    const { rec, client } = wired({ abortableHang: true });
    const ac = new AbortController();
    const abortErr = new DOMException("stop", "AbortError");
    const started = Date.now();
    const pending = client
      .call("/models", { signal: ac.signal }, KEY)
      .catch((e) => e);

    setTimeout(() => ac.abort(abortErr), 10);
    const err = await pending;

    expect(Date.now() - started).toBeLessThan(100);
    expect(err).toBe(abortErr);
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(CailError);
    expect(rec.captured).toHaveLength(1);
  });

  it("V27b abort during 5xx backoff rejects promptly and does not issue retry", async () => {
    const { rec, client } = wired([
      envelope(500, { error: "server_error", message: "try later" }),
      jsonOk({ ok: true }),
    ]);
    const ac = new AbortController();
    const abortErr = new DOMException("stop", "AbortError");
    const started = Date.now();
    const pending = client
      .call("/models", { signal: ac.signal }, KEY)
      .catch((e) => e);

    setTimeout(() => ac.abort(abortErr), 10);
    const err = await pending;

    expect(Date.now() - started).toBeLessThan(100);
    expect(err).toBe(abortErr);
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(CailError);
    expect(rec.captured).toHaveLength(1);
  });

  it("V28 ReadableStream body + 500 envelope → no retry, preserves envelope", async () => {
    const { rec, client } = wired([
      envelope(500, { error: "server_error", message: "stream failed" }),
      jsonOk({ ok: true }),
    ]);
    const err = await client
      .call("/models", { method: "POST", body: readableBody() }, KEY)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("server_error");
    expect(err.message).toBe("stream failed");
    expect(rec.captured).toHaveLength(1);
  });

  it("V28b ReadableStream body + network error → no retry, network_error", async () => {
    const { rec, client } = wired([{ networkError: true }, jsonOk({ ok: true })]);
    const err = await client
      .call("/models", { method: "POST", body: readableBody() }, KEY)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("network_error");
    expect(rec.captured).toHaveLength(1);
  });

  it("V33 503 Retry-After seconds is honored before retry", async () => {
    const { rec, client } = wired([
      envelope(
        503,
        { error: "server_busy", message: "try later" },
        { "Retry-After": "1" },
      ),
      jsonOk({ ok: true }),
    ]);
    const started = Date.now();
    const resp = await client.call("/models", {}, KEY);
    const elapsed = Date.now() - started;
    expect(resp.status).toBe(200);
    expect(rec.captured).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });
});

// ── 401 hook + passthrough + verbatim body (I6/I7/I8) ─────────────────────

describe("I6 — 401 hook", () => {
  it("V24 401 authentication_required → onAuthRequired invoked once with the err, still throws", async () => {
    const spy = vi.fn();
    const body = { error: "authentication_required", message: "sign in", login_url: "/login" };
    const { client } = wired(envelope(401, body), { onAuthRequired: spy });
    const err = await client.call("/models", {}, JWT).catch((e) => e);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(err);
    expect(err).toBeInstanceOf(CailError);
  });

  it("V24b 401 invalid_api_key does NOT invoke onAuthRequired (only authentication_required)", async () => {
    const spy = vi.fn();
    const { client } = wired(
      envelope(401, { error: "invalid_api_key", message: "bad key" }),
      { onAuthRequired: spy },
    );
    await client.call("/models", {}, KEY).catch(() => {});
    expect(spy).not.toHaveBeenCalled();
  });

  it("V24c browserAuthRedirect same-origin guard: rejects cross-origin login_url", () => {
    const loc = {
      href: "https://tools.ailab.gc.cuny.edu/alt-text",
      origin: "https://tools.ailab.gc.cuny.edu",
      pathname: "/alt-text",
      search: "",
    };
    const orig = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = loc;
    try {
      browserAuthRedirect(
        new CailError("authentication_required", "x", 401, {
          login_url: "https://evil.example/login",
        }),
      );
      // Cross-origin login_url ignored → falls back to same-origin /login?rt=
      expect(loc.href.startsWith("/login?rt=")).toBe(true);

      loc.href = "https://tools.ailab.gc.cuny.edu/alt-text";
      browserAuthRedirect(
        new CailError("authentication_required", "x", 401, {
          login_url: "/login?rt=%2Falt-text",
        }),
      );
      expect(loc.href).toContain("/login?rt=");
    } finally {
      (globalThis as { location?: unknown }).location = orig;
    }
  });

  it("V31 throwing onAuthRequired hook does not mask the CailError", async () => {
    const { client } = wired(
      envelope(401, {
        error: "authentication_required",
        message: "sign in",
        login_url: "/login",
      }),
      {
        onAuthRequired: () => {
          throw new Error("hook exploded");
        },
      },
    );
    const err = await client.call("/models", {}, JWT).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("authentication_required");
    expect(err.message).toBe("sign in");
  });

  it("V32 malformed authentication_required envelope → unknown_error, no hook", async () => {
    const spy = vi.fn();
    const { client } = wired(
      envelope(401, {
        error: "authentication_required",
        message: 123,
        login_url: "/login",
      }),
      { onAuthRequired: spy },
    );
    const err = await client.call("/models", {}, JWT).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("unknown_error");
    expect(err.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("I7 — 2xx passthrough, streams intact", () => {
  it("V25 200 SSE stream body returned by reference, first chunk readable before close (not buffered)", async () => {
    const stream = sseStream(["data: one\n\n", "data: two\n\n"], 30);
    const { client } = wired(stream);
    const resp = await client.call("/models", { method: "POST" }, KEY);
    // Same Response object by reference (I7).
    expect(resp).toBe(stream);
    expect(resp.body).not.toBeNull();

    const reader = resp.body!.getReader();
    const first = await reader.read();
    const decoder = new TextDecoder();
    expect(decoder.decode(first.value)).toBe("data: one\n\n");
    // The stream is still open at this point — proves no buffering.
    const stillOpen = (stream as unknown as { __closed: () => boolean }).__closed();
    expect(stillOpen).toBe(false);
    reader.cancel();
  });
});

describe("I8 — canonical model run", () => {
  it("V26 POSTs exactly {model,input} to /v1/run", async () => {
    const request = {
      model: "@cf/example/text-model",
      input: { messages: [{ role: "user", content: "hi" }] },
      ignored: "not part of the wire contract",
    };
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.run(request, JWT, { metadata: { purpose: "test" } });

    expect(rec.one.url).toBe(`${BASE}/v1/run`);
    expect(rec.one.method).toBe("POST");
    expect(rec.one.headers["content-type"]).toBe("application/json");
    expect(rec.one.headers["x-cail-app"]).toBe(APP);
    expect(rec.one.headers["x-cail-metadata"]).toBe(
      JSON.stringify({ purpose: "test" }),
    );
    expect(JSON.parse(rec.one.body)).toEqual({
      model: request.model,
      input: request.input,
    });
  });

  it("V26b preserves the successful Response by reference", async () => {
    const response = jsonOk({ response: "hello" });
    const { client } = wired(response);
    await expect(
      client.run({ model: "@cf/example/text-model", input: "hi" }, KEY),
    ).resolves.toBe(response);
  });

  it("V26c rejects malformed requests before fetch", async () => {
    const { rec, client } = wired(jsonOk({}));
    await expect(
      client.run({ model: "", input: "hi" }, KEY),
    ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    await expect(
      client.run({ model: "@cf/example/text-model", input: undefined }, KEY),
    ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(rec.captured).toHaveLength(0);
  });

  it("V26d generic call() cannot invoke the model endpoint", async () => {
    const { rec, client } = wired(jsonOk({}));
    await expect(
      client.call("/v1/run", { method: "POST" }, KEY),
    ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(rec.captured).toHaveLength(0);
  });
});

// ── parseCailError as a standalone export ─────────────────────────────────

describe("parseCailError (standalone)", () => {
  it("parses an envelope", async () => {
    const err = await parseCailError(
      envelope(429, { error: "quota_exceeded", message: "no budget" }),
    );
    expect(err.code).toBe("quota_exceeded");
    expect(err.message).toBe("no budget");
  });
  it("non-JSON → unknown_error", async () => {
    const err = await parseCailError(nonJson(500, "boom"));
    expect(err.code).toBe("unknown_error");
  });

  it("preserves AbortError thrown while reading an error body", async () => {
    const response = new Response(null, { status: 400 });
    Object.defineProperty(response, "text", {
      value: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    });

    const err = await parseCailError(response).catch((e) => e);

    expect(err).not.toBeInstanceOf(CailError);
    expect(err.name).toBe("AbortError");
  });
});

// ── I8 extension — canonical chat completions ─────────────────────────────

describe("I8 — canonical chat completions", () => {
  it("V27 POSTs the OpenAI body verbatim to /v1/chat/completions (client never injects stream_options)", async () => {
    const request = {
      model: "@cf/example/text-model",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      temperature: 0.2,
    };
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.chatCompletions(request, JWT, { metadata: { purpose: "t" } });
    expect(rec.one.url).toBe(`${BASE}/v1/chat/completions`);
    expect(rec.one.method).toBe("POST");
    expect(rec.one.headers["content-type"]).toBe("application/json");
    expect(rec.one.headers["x-cail-app"]).toBe(APP);
    expect(JSON.parse(rec.one.body)).toEqual(request); // verbatim — include_usage is the gateway's job
  });

  it("V28 streaming Response passes through by reference, first chunk readable before close", async () => {
    const stream = sseStream(["data: {\"choices\":[]}\n\n", "data: [DONE]\n\n"], 30);
    const { client } = wired(stream);
    const resp = await client.chatCompletions(
      { model: "@cf/m/x", messages: [], stream: true },
      KEY,
    );
    expect(resp).toBe(stream);
    const reader = resp.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("choices");
    expect(
      (stream as unknown as { __closed: () => boolean }).__closed(),
    ).toBe(false); // not buffered
    reader.cancel();
  });

  it("V29 rejects malformed requests before fetch; non-2xx throws the envelope", async () => {
    const { rec, client } = wired(
      envelope(429, {
        error: "quota_exceeded",
        message: "over budget",
        retry_after_seconds: 9,
      }),
    );
    await expect(
      client.chatCompletions({ model: "", messages: [] }, KEY),
    ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    await expect(
      client.chatCompletions({ model: "@cf/m/x", messages: "no" as unknown as unknown[] }, KEY),
    ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    await expect(
      client.chatCompletions(
        { model: "@cf/m/x", messages: [], stream: "yes" as unknown as boolean },
        KEY,
      ),
    ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(rec.captured).toHaveLength(0);
    await expect(
      client.chatCompletions({ model: "@cf/m/x", messages: [] }, KEY),
    ).rejects.toMatchObject({ code: "quota_exceeded", status: 429 });
  });

  it("V30 generic call() cannot invoke /v1/chat/completions", async () => {
    const { rec, client } = wired(jsonOk({}));
    await expect(
      client.call("/v1/chat/completions", { method: "POST" }, KEY),
    ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
    expect(rec.captured).toHaveLength(0);
  });
});

// ── chatFetch — the OpenAI-SDK adapter (raw fetch semantics) ──────────────

describe("chatFetch — SDK adapter", () => {
  const CHAT_URL = `${BASE}/v1/chat/completions`;
  const sdkInit = (body: unknown): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer cail-proxy", // the AI-SDK dummy-key footgun
    },
    body: JSON.stringify(body),
  });

  it("V31 applies I1/I2 discipline: dummy Authorization stripped, JWT + app slug on the wire", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    const fetchLike = client.chatFetch(JWT);
    await fetchLike(CHAT_URL, sdkInit({ model: "@cf/m/x", messages: [] }));
    expect(rec.one.headers["authorization"]).toBeUndefined();
    expect(rec.one.headers["x-cail-identity-jwt"]).toBe("jwt-token-abc");
    expect(rec.one.headers["x-cail-app"]).toBe(APP);
  });

  it("V32 quota carve-out: 429 quota_exceeded THROWS the CailError (never SDK-retried), one wire call", async () => {
    const { rec, client } = wired([
      envelope(
        429,
        { error: "quota_exceeded", message: "over budget", retry_after_seconds: 120 },
        { "retry-after": "120" },
      ),
      jsonOk({ never: "reached" }),
    ]);
    const fetchLike = client.chatFetch(KEY);
    await expect(
      fetchLike(CHAT_URL, sdkInit({ model: "@cf/m/x", messages: [] })),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
      status: 429,
      message: "over budget",
      extras: expect.objectContaining({ retry_after_seconds: 120 }),
    });
    expect(rec.captured).toHaveLength(1); // thrown on the FIRST failure — no retry storm
  });

  it("V32a non-quota 429 keeps raw semantics: returned, not thrown", async () => {
    const { rec, client } = wired(
      envelope(429, { error: "rate_limited", message: "slow down" }),
    );
    const resp = await client.chatFetch(KEY)(CHAT_URL, sdkInit({ model: "@cf/m/x", messages: [] }));
    expect(resp.status).toBe(429);
    expect(((await resp.json()) as { error: string }).error).toBe("rate_limited"); // body intact
    expect(rec.captured).toHaveLength(1);
  });

  it("V32b raw semantics: 500 returned unretried; network error rethrown as-is", async () => {
    const { rec, client } = wired([nonJson(500, "boom"), jsonOk({})]);
    const fetchLike = client.chatFetch(KEY);
    const resp = await fetchLike(CHAT_URL, sdkInit({ model: "@cf/m/x", messages: [] }));
    expect(resp.status).toBe(500);
    expect(rec.captured).toHaveLength(1);

    const netErr = wired({ networkError: true });
    await expect(
      netErr.client.chatFetch(KEY)(CHAT_URL, sdkInit({ model: "@cf/m/x", messages: [] })),
    ).rejects.toThrowError(TypeError); // platform error preserved, not CailError-wrapped
  });

  it("V33 401 fires onAuthRequired on a clone; SDK still receives a readable body", async () => {
    const seen: unknown[] = [];
    const { client } = wired(
      envelope(401, { error: "authentication_required", message: "sign in", login_url: "/login" }),
      { onAuthRequired: (err) => void seen.push(err.code) },
    );
    const resp = await client.chatFetch(JWT)(CHAT_URL, sdkInit({ model: "@cf/m/x", messages: [] }));
    expect(resp.status).toBe(401);
    expect(seen).toEqual(["authentication_required"]);
    expect(((await resp.json()) as { error: string }).error).toBe("authentication_required"); // body intact
  });

  it("V34 serves ONLY the chat-completions URL — anything else throws before fetch", async () => {
    const { rec, client } = wired(jsonOk({}));
    const fetchLike = client.chatFetch(KEY);
    for (const bad of [`${BASE}/v1/run`, `${BASE}/models`, "https://evil.example/v1/chat/completions"]) {
      await expect(fetchLike(bad, sdkInit({}))).rejects.toMatchObject({
        code: "invalid_request",
        status: 0,
      });
    }
    expect(rec.captured).toHaveLength(0);
  });

  it("V35 redirect protection still applies in raw mode (JWT never follows cross-origin)", async () => {
    const { client } = wired(
      new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    await expect(
      client.chatFetch(JWT)(CHAT_URL, sdkInit({ model: "@cf/m/x", messages: [] })),
    ).rejects.toMatchObject({ code: "unexpected_redirect" });
  });
});

// ── recording mock — over-calling guard ───────────────────────────────────

describe("recording mock — over-calling guard", () => {
  it("a call beyond the queued responses throws (never silently reuses the last response)", async () => {
    const rec = recordingFetch(jsonOk({ ok: true }));
    const first = await rec.fn("https://x.example/one", { method: "GET" });
    expect(first.status).toBe(200);
    await expect(
      rec.fn("https://x.example/two", { method: "GET" }),
    ).rejects.toThrow(/unexpected call #2/);
  });
});
