import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

async function bundle(name: string): Promise<string> {
  const result = await build({
    entryPoints: [new URL(`./fixtures/workerd-${name}.ts`, import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("Worker bundle was not emitted");
  return output.text;
}

describe("workerd service binding transport", () => {
  let runtime: Miniflare;

  beforeAll(async () => {
    const [caller, receiver, destination] = await Promise.all([
      bundle("caller"), bundle("receiver"), bundle("destination"),
    ]);
    runtime = new Miniflare({
      workers: [
        {
          name: "caller",
          modules: true,
          compatibilityDate: "2026-07-22",
          script: caller,
          serviceBindings: { GATEWAY: "receiver" },
          outboundService: "destination",
        },
        {
          name: "receiver",
          modules: true,
          compatibilityDate: "2026-07-22",
          script: receiver,
          outboundService: "destination",
        },
        {
          name: "destination",
          modules: true,
          compatibilityDate: "2026-07-22",
          script: destination,
        },
      ],
    });
  });

  afterAll(async () => {
    await runtime?.dispose();
  });

  it.each(["/chat", "/run", "/chat-fetch"])("sends authenticated %s requests to the receiver", async (path) => {
    const response = await runtime.dispatchFetch(`https://caller.test${path}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization: "Bearer test-key",
      app: "workerd-test",
      body: path === "/run"
        ? { model: "test", input: { prompt: "hello" } }
        : { model: "test", messages: [] },
    });
  });

  it.each([301, 302, 303, 307, 308])("rejects HTTP %i without following or retrying", async (status) => {
    const receiver = await runtime.getWorker("receiver");
    const before = await (await receiver.fetch("https://gateway.test/calls")).json();
    const response = await runtime.dispatchFetch(`https://caller.test/chat?status=${status}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "unexpected_redirect" });
    const after = await (await receiver.fetch("https://gateway.test/calls")).json();
    expect(Number(after) - Number(before)).toBe(1);
    const destination = await runtime.getWorker("destination");
    expect(await (await destination.fetch("https://destination.test/calls")).json()).toBe(0);
  });

  it("preserves a multipart upload through call() and the service binding", async () => {
    const response = await runtime.dispatchFetch("https://caller.test/multipart");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization: "Bearer test-key",
      app: "workerd-test",
      model: "test-transcription",
      file: { name: "sample.wav", type: "audio/wav", text: "synthetic audio bytes" },
    });
  });
});
