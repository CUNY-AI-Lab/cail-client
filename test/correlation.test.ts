/**
 * Correlation vectors — the light cail-log integration.
 *
 * Two claims, asserted on the CAPTURED WIRE via the recording mock proxy:
 *   C-A  cail-client re-exports the cail-log correlation contract VERBATIM
 *        (one source of truth — the exact same functions/constants).
 *   C-B  `options.correlation` forwards `traceparent` + `X-CAIL-Request-Id`
 *        downstream, optionally and backward-compatibly: absent → not a byte
 *        of difference on the wire; malformed → client-side CailError before
 *        any transport attempt.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createCailClient,
  CailError,
  correlationFromHeaders,
  outboundCorrelationHeaders,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  CAIL_REQUEST_ID_HEADER,
  type CailCorrelation,
  type CailCorrelationOptions,
  type CailCredential,
} from "../src/index.js";
import * as cailLog from "@cuny-ai-lab/cail-log";
import { recordingFetch, jsonOk, envelope } from "./mock.js";

const BASE = "https://api.ailab.example";
const APP = "alt-text";
const JWT: CailCredential = { kind: "jwt", token: "jwt-token-abc" };

const CORR: CailCorrelation = {
  trace_id: "0af7651916cd43dd8448eb211c80319c",
  span_id: "b7ad6b7169203331",
  trace_flags: 1,
  request_id: "9f50d4a4-ef70-41b2-b225-0a5cbf2df5e7",
};
const WIRE_TRACEPARENT = `00-${CORR.trace_id}-${CORR.span_id}-0${CORR.trace_flags}`;

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

// ── C-A: the re-export IS the cail-log contract ───────────────────────────

describe("C-A — correlation contract re-exported verbatim from cail-log", () => {
  it("C1 re-exported functions are the SAME functions (identity, not copies)", () => {
    expect(correlationFromHeaders).toBe(cailLog.correlationFromHeaders);
    expect(outboundCorrelationHeaders).toBe(cailLog.outboundCorrelationHeaders);
  });

  it("C2 re-exported header constants are the canonical carrier names", () => {
    expect(TRACEPARENT_HEADER).toBe(cailLog.TRACEPARENT_HEADER);
    expect(TRACESTATE_HEADER).toBe(cailLog.TRACESTATE_HEADER);
    expect(CAIL_REQUEST_ID_HEADER).toBe(cailLog.CAIL_REQUEST_ID_HEADER);
    expect(TRACEPARENT_HEADER).toBe("traceparent");
    expect(TRACESTATE_HEADER).toBe("tracestate");
    expect(CAIL_REQUEST_ID_HEADER).toBe("x-cail-request-id");
  });

  it("C3 the round trip closes: correlationFromHeaders adopts what outboundCorrelationHeaders emits", () => {
    const outbound = outboundCorrelationHeaders(CORR);
    const adopted = correlationFromHeaders(new Headers(outbound));
    expect(adopted.trace_id).toBe(CORR.trace_id); // trace adopted
    expect(adopted.request_id).toBe(CORR.request_id); // request id adopted verbatim
    expect(adopted.span_id).not.toBe(CORR.span_id); // fresh span per hop (L7)
    expect(adopted.trace_flags).toBe(1); // inbound sampling decision preserved
  });

  it("C3b unsampled correlation stays unsampled and the options type is re-exported", () => {
    const unsampled = { ...CORR, trace_flags: 0 as const };
    const outbound = outboundCorrelationHeaders(unsampled);
    expect(outbound[TRACEPARENT_HEADER]).toBe(
      `00-${CORR.trace_id}-${CORR.span_id}-00`,
    );
    expect(correlationFromHeaders(new Headers(outbound)).trace_flags).toBe(0);

    const options: CailCorrelationOptions = { sampled: false };
    expect(correlationFromHeaders(new Headers(), options).trace_flags).toBe(0);
  });

  it("C3c legacy non-UUID request ids are not adopted", () => {
    const adopted = correlationFromHeaders(
      new Headers({
        [TRACEPARENT_HEADER]: WIRE_TRACEPARENT,
        [CAIL_REQUEST_ID_HEADER]: "req-legacy-0001",
      }),
    );
    expect(adopted.request_id).not.toBe("req-legacy-0001");
    expect(adopted.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("C3d rejects coercible outbound identifiers without coercion", () => {
    let coercions = 0;
    const coercible = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return CORR.trace_id;
      },
    };

    expect(() =>
      outboundCorrelationHeaders({
        ...CORR,
        trace_id: coercible as never,
      }),
    ).toThrow(TypeError);
    expect(coercions).toBe(0);
  });

  it("C3e snapshots each outbound identifier once", () => {
    const reads = new Map<string, number>();
    const changing = <Value>(name: string, safe: Value, forged: Value) => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      return count === 1 ? safe : forged;
    };
    const correlation = {
      get trace_id() {
        return changing("trace_id", CORR.trace_id, "f".repeat(32));
      },
      get span_id() {
        return changing("span_id", CORR.span_id, "f".repeat(16));
      },
      get trace_flags() {
        return changing("trace_flags", 1 as const, 0 as const);
      },
      get request_id() {
        return changing(
          "request_id",
          CORR.request_id,
          "ffffffff-ffff-4fff-8fff-ffffffffffff",
        );
      },
      get tracestate() {
        return changing("tracestate", "cail=trusted", "private=forged");
      },
    };

    expect(outboundCorrelationHeaders(correlation)).toEqual({
      traceparent: WIRE_TRACEPARENT,
      tracestate: "cail=trusted",
      "x-cail-request-id": CORR.request_id,
    });
    expect(Object.fromEntries(reads)).toEqual({
      trace_id: 1,
      span_id: 1,
      trace_flags: 1,
      request_id: 1,
      tracestate: 1,
    });
  });

  it("C3f fails boundedly instead of fabricating an all-zero identifier", () => {
    let randomCalls = 0;
    vi.stubGlobal("crypto", {
      getRandomValues<T extends ArrayBufferView | null>(array: T): T {
        randomCalls += 1;
        if (array !== null) {
          new Uint8Array(
            array.buffer,
            array.byteOffset,
            array.byteLength,
          ).fill(0);
        }
        return array;
      },
    });
    try {
      expect(() => correlationFromHeaders(new Headers())).toThrow(TypeError);
      expect(randomCalls).toBeGreaterThan(1);
      expect(randomCalls).toBeLessThanOrEqual(32);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── C-B: optional forwarding on the wire ──────────────────────────────────

describe("C-B — options.correlation forwards the trace downstream", () => {
  it("C4 call() with correlation puts traceparent + X-CAIL-Request-Id on the wire", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call("/v1/models", { method: "GET" }, JWT, {
      correlation: CORR,
    });
    expect(rec.one.headers["traceparent"]).toBe(WIRE_TRACEPARENT);
    expect(rec.one.headers["x-cail-request-id"]).toBe(CORR.request_id);
  });

  it("C5 run() forwards correlation alongside the existing contract headers", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.run({ model: "m", input: { prompt: "p" } }, JWT, {
      correlation: CORR,
    });
    expect(rec.one.headers["traceparent"]).toBe(WIRE_TRACEPARENT);
    expect(rec.one.headers["x-cail-request-id"]).toBe(CORR.request_id);
    // Additive: the pre-existing wire contract is untouched.
    expect(rec.one.headers["x-cail-app"]).toBe(APP);
    expect(rec.one.headers["x-cail-identity-jwt"]).toBe("jwt-token-abc");
    expect(rec.one.headers["idempotency-key"]).toBeTruthy();
  });

  it("C6 chatCompletions() forwards correlation", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.chatCompletions({ model: "m", messages: [] }, JWT, {
      correlation: CORR,
    });
    expect(rec.one.headers["traceparent"]).toBe(WIRE_TRACEPARENT);
    expect(rec.one.headers["x-cail-request-id"]).toBe(CORR.request_id);
  });

  it("C7 chatFetch() forwards correlation on the SDK adapter path", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    const doFetch = client.chatFetch(JWT, { correlation: CORR });
    await doFetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(rec.one.headers["traceparent"]).toBe(WIRE_TRACEPARENT);
    expect(rec.one.headers["x-cail-request-id"]).toBe(CORR.request_id);
  });

  it("C8 backward compatible: no correlation option → no correlation headers on the wire", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call("/v1/models", { method: "GET" }, JWT);
    expect(rec.one.headers["traceparent"]).toBeUndefined();
    expect(rec.one.headers["x-cail-request-id"]).toBeUndefined();
  });

  it("C9 the client's correlation overrides a stray caller-injected traceparent", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    await client.call(
      "/v1/models",
      {
        method: "GET",
        headers: {
          Traceparent: "00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-00",
          Tracestate: "stray=vendor",
          "X-CAIL-Request-Id": "stray-id",
        },
      },
      JWT,
      { correlation: CORR },
    );
    expect(rec.one.headers["traceparent"]).toBe(WIRE_TRACEPARENT);
    expect(rec.one.headers["tracestate"]).toBeUndefined();
    expect(rec.one.headers["x-cail-request-id"]).toBe(CORR.request_id);
  });

  it("C9b correlation replaces traceparent, tracestate, and request id as one unit", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    const correlation = { ...CORR, tracestate: "cail=trusted" };
    await client.call(
      "/v1/models",
      {
        method: "GET",
        headers: {
          Traceparent: "00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-00",
          Tracestate: "stray=vendor",
          "X-CAIL-Request-Id": "stray-id",
        },
      },
      JWT,
      { correlation },
    );
    expect(rec.one.headers["traceparent"]).toBe(WIRE_TRACEPARENT);
    expect(rec.one.headers["tracestate"]).toBe("cail=trusted");
    expect(rec.one.headers["x-cail-request-id"]).toBe(CORR.request_id);
  });

  it("C10 malformed correlation → CailError invalid_correlation, nothing on the wire", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    const bad = {
      trace_id: "not-hex",
      span_id: CORR.span_id,
      request_id: CORR.request_id,
    } as CailCorrelation;
    const err = await client
      .call("/v1/models", { method: "GET" }, JWT, { correlation: bad })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CailError);
    expect((err as CailError).code).toBe("invalid_correlation");
    expect((err as CailError).status).toBe(0);
    expect(rec.captured.length).toBe(0);
  });

  it("C10b invalid trace flags fail before transport", async () => {
    const { rec, client } = wired(jsonOk({ ok: true }));
    const bad = { ...CORR, trace_flags: 2 } as unknown as CailCorrelation;
    await expect(
      client.call("/v1/models", { method: "GET" }, JWT, {
        correlation: bad,
      }),
    ).rejects.toMatchObject({ code: "invalid_correlation", status: 0 });
    expect(rec.captured).toHaveLength(0);
  });

  it("C10c coercible correlation values fail without coercion or transport", async () => {
    let coercions = 0;
    const coercible = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return CORR.trace_id;
      },
    };
    const { rec, client } = wired(jsonOk({ ok: true }));

    await expect(
      client.call("/v1/models", { method: "GET" }, JWT, {
        correlation: {
          ...CORR,
          trace_id: coercible as never,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_correlation", status: 0 });
    expect(coercions).toBe(0);
    expect(rec.captured).toHaveLength(0);
  });

  it("C11 retries of one logical request carry the SAME correlation headers", async () => {
    const { rec, client } = wired([
      envelope(503, { error: "overloaded", message: "try again" }),
      jsonOk({ ok: true }),
    ]);
    await client.call("/v1/models", { method: "GET" }, JWT, {
      correlation: CORR,
    });
    expect(rec.captured.length).toBe(2);
    for (const c of rec.captured) {
      expect(c.headers["traceparent"]).toBe(WIRE_TRACEPARENT);
      expect(c.headers["x-cail-request-id"]).toBe(CORR.request_id);
    }
  });
});
