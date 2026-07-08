/**
 * The 26 contract vectors (SPEC §5). Each asserts an invariant on the CAPTURED
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

// ── Credential forwarding (I1) ────────────────────────────────────────────

describe("I1 — exactly one credential on the wire", () => {
  it("V1 jwt path sets X-CAIL-Identity-JWT and no Authorization", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call("/v1/compat/chat/completions", { method: "POST" }, JWT);
    expect(rec.one.headers["x-cail-identity-jwt"]).toBe("jwt-token-abc");
    expect(rec.one.headers["authorization"]).toBeUndefined();
  });

  it("V2 jwt path STRIPS a caller-injected dummy Authorization (the footgun)", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call(
      "/v1/compat/chat/completions",
      { method: "POST", headers: { Authorization: "Bearer dummy" } },
      JWT,
    );
    expect(rec.one.headers["authorization"]).toBeUndefined();
    expect(rec.one.headers["x-cail-identity-jwt"]).toBe("jwt-token-abc");
  });

  it("V3 key path sets Authorization: Bearer <key> and no JWT header", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call("/v1/compat/chat/completions", { method: "POST" }, KEY);
    expect(rec.one.headers["authorization"]).toBe("Bearer sk-cail-xyz");
    expect(rec.one.headers["x-cail-identity-jwt"]).toBeUndefined();
  });

  it("V4 never both credential headers present, either kind", async () => {
    // jwt kind, even with a stray JWT header already in init.
    {
      const { rec, client } = wired(jsonOk({ ok: true }));
      await client.call(
        "/v1",
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
        "/v1",
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
});

// ── Headers: app slug + metadata (I2/I3) ──────────────────────────────────

describe("I2 — X-CAIL-App", () => {
  it("V5 X-CAIL-App present == constructed slug on every call", async () => {
    const { rec, client } = wired([jsonOk({ a: 1 }), jsonOk({ b: 2 })]);
    await client.call("/v1", {}, JWT);
    await client.call("/v1", {}, KEY);
    expect(rec.captured).toHaveLength(2);
    for (const c of rec.captured) expect(c.headers["x-cail-app"]).toBe(APP);
  });

  it("V5b caller cannot override X-CAIL-App", async () => {
    const { rec, client } = wired(jsonOk({}));
    await client.call("/v1", { headers: { "X-CAIL-App": "evil" } }, JWT);
    expect(rec.one.headers["x-cail-app"]).toBe(APP);
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
    await client.call("/v1", {}, JWT, { metadata: { project: "x" } });
    expect(rec.one.headers["x-cail-metadata"]).toBe(JSON.stringify({ project: "x" }));
  });

  it("V8 9 keys → throws", async () => {
    const { client } = wired(jsonOk({}));
    const meta: Record<string, string> = {};
    for (let i = 0; i < 9; i++) meta[`k${i}`] = "v";
    await expect(client.call("/v1", {}, JWT, { metadata: meta })).rejects.toBeInstanceOf(CailError);
  });

  it("V9 value object/array → throws", async () => {
    const { client } = wired(jsonOk({}));
    await expect(
      client.call("/v1", {}, JWT, { metadata: { k: { nested: 1 } as unknown as string } }),
    ).rejects.toBeInstanceOf(CailError);
    await expect(
      client.call("/v1", {}, JWT, { metadata: { k: [1, 2] as unknown as string } }),
    ).rejects.toBeInstanceOf(CailError);
  });

  it("V10 value >128 chars → throws", async () => {
    const { client } = wired(jsonOk({}));
    await expect(
      client.call("/v1", {}, JWT, { metadata: { k: "a".repeat(129) } }),
    ).rejects.toBeInstanceOf(CailError);
    // exactly 128 is accepted
    const { rec, client: c2 } = wired(jsonOk({}));
    await c2.call("/v1", {}, JWT, { metadata: { k: "a".repeat(128) } });
    expect(rec.one.headers["x-cail-metadata"]).toBeDefined();
  });

  it("V11 reserved key (user_id) → throws", async () => {
    const { client } = wired(jsonOk({}));
    for (const reserved of ["user_id", "app", "via"]) {
      await expect(
        client.call("/v1", {}, JWT, { metadata: { [reserved]: "x" } }),
      ).rejects.toBeInstanceOf(CailError);
    }
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
    const err = await client.call("/v1", {}, JWT).catch((e) => e);
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
    const err = await client.call("/v1", {}, KEY).catch((e) => e);
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
    const err = await client.call("/v1", {}, KEY).catch((e) => e);
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
    const err = await client.call("/v1", {}, KEY).catch((e) => e);
    expect(err.code).toBe("upstream_auth_error");
    expect(err.status).toBe(502);
  });

  it("V17 503 sso_unavailable → typed", async () => {
    const { client } = wired(
      envelope(503, { error: "sso_unavailable", message: "SSO is temporarily down." }),
      { maxRetries: 0 },
    );
    const err = await client.call("/v1", {}, JWT).catch((e) => e);
    expect(err.code).toBe("sso_unavailable");
    expect(err.status).toBe(503);
  });

  it("V18 non-JSON 500 body → unknown_error, NOT swallowed as success", async () => {
    const { client } = wired(nonJson(500, "<html>Internal Server Error</html>"), {
      maxRetries: 0,
    });
    const err = await client.call("/v1", {}, KEY).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(err.code).toBe("unknown_error");
    expect(err.status).toBe(500);
    // Prove it was thrown, never returned as a Response.
    expect(err).not.toBeInstanceOf(Response);
  });

  it("V19 message is byte-identical to the envelope's message (no rewording)", async () => {
    const exact = "Précisely thîs — verbatim, incl. 中文 & symbols: <>&\"'.";
    const { client } = wired(envelope(400, { error: "bad_request", message: exact }));
    const err = await client.call("/v1", {}, KEY).catch((e) => e);
    expect(err.message).toBe(exact);
  });
});

// ── Retry policy (I5) ─────────────────────────────────────────────────────

describe("I5 — retry policy", () => {
  it("V20 500 then 200 → one retry, resolves", async () => {
    const { rec, client } = wired([
      envelope(500, { error: "server_error", message: "oops" }),
      jsonOk({ ok: true }),
    ]);
    const resp = await client.call("/v1", { method: "POST" }, KEY);
    expect(resp.status).toBe(200);
    expect(rec.captured).toHaveLength(2);
  });

  it("V21 network-error then 200 → retries", async () => {
    const { rec, client } = wired([{ networkError: true }, jsonOk({ ok: true })]);
    const resp = await client.call("/v1", { method: "POST" }, KEY);
    expect(resp.status).toBe(200);
    expect(rec.captured).toHaveLength(2);
  });

  it("V22 400 → NO retry (throws immediately)", async () => {
    const { rec, client } = wired([
      envelope(400, { error: "bad_request", message: "bad" }),
      jsonOk({ ok: true }), // must never be reached
    ]);
    await expect(client.call("/v1", {}, KEY)).rejects.toBeInstanceOf(CailError);
    expect(rec.captured).toHaveLength(1);
  });

  it("V23 429 → NO retry", async () => {
    const { rec, client } = wired([
      envelope(429, { error: "quota_exceeded", message: "budget" }),
      jsonOk({ ok: true }),
    ]);
    await expect(client.call("/v1", {}, KEY)).rejects.toBeInstanceOf(CailError);
    expect(rec.captured).toHaveLength(1);
  });

  it("V23b retries exhausted on persistent 5xx → throws typed", async () => {
    const { rec, client } = wired(
      envelope(500, { error: "server_error", message: "still down" }),
      { maxRetries: 2 },
    );
    const err = await client.call("/v1", {}, KEY).catch((e) => e);
    expect(err).toBeInstanceOf(CailError);
    expect(rec.captured).toHaveLength(3); // 1 + 2 retries
  });
});

// ── 401 hook + passthrough + verbatim body (I6/I7/I8) ─────────────────────

describe("I6 — 401 hook", () => {
  it("V24 401 authentication_required → onAuthRequired invoked once with the err, still throws", async () => {
    const spy = vi.fn();
    const body = { error: "authentication_required", message: "sign in", login_url: "/login" };
    const { client } = wired(envelope(401, body), { onAuthRequired: spy });
    const err = await client.call("/v1", {}, JWT).catch((e) => e);
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
    await client.call("/v1", {}, KEY).catch(() => {});
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
});

describe("I7 — 2xx passthrough, streams intact", () => {
  it("V25 200 SSE stream body returned by reference, first chunk readable before close (not buffered)", async () => {
    const stream = sseStream(["data: one\n\n", "data: two\n\n"], 30);
    const { client } = wired(stream);
    const resp = await client.call("/v1", { method: "POST" }, KEY);
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

describe("I8 — body + model ref untouched", () => {
  it("V26 init.body and model id are byte-identical on the wire", async () => {
    const payload = JSON.stringify({
      model: "@cf/zai-org/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    });
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call(
      "/v1/compat/chat/completions",
      { method: "POST", body: payload, headers: { "content-type": "application/json" } },
      JWT,
    );
    expect(rec.one.body).toBe(payload);
    // The bare @cf/... id is present verbatim — never rewritten to workers-ai/.
    expect(rec.one.body).toContain('"model":"@cf/zai-org/glm-5.2"');
    expect(rec.one.body).not.toContain("workers-ai/");
  });

  it("V26b URL is baseUrl + path (no double slash, path joined verbatim)", async () => {
    const { rec, client } = wired(jsonOk({}));
    await client.call("/v1/compat/chat/completions", {}, KEY);
    expect(rec.one.url).toBe(`${BASE}/v1/compat/chat/completions`);
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
});
