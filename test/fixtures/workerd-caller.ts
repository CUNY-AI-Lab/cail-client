import { CailError, createCailClient } from "../../src/index.js";

interface Environment {
  GATEWAY: { fetch: typeof fetch };
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const url = new URL(request.url);
    const client = createCailClient({
      app: "workerd-test",
      baseUrl: `https://gateway.test/${url.searchParams.get("status") ?? "200"}`,
      fetchImpl: (input, init) => env.GATEWAY.fetch(input, init),
    });
    try {
      if (url.pathname === "/multipart") {
        const body = new FormData();
        body.set("model", "test-transcription");
        body.set("file", new Blob(["synthetic audio bytes"], { type: "audio/wav" }), "sample.wav");
        return await client.call("/v1/audio/transcriptions", { method: "POST", body }, "test-key");
      }
      if (url.pathname === "/run") {
        return await client.run({ model: "test", input: { prompt: "hello" } }, "test-key");
      }
      if (url.pathname === "/chat-fetch") {
        return await client.chatFetch("test-key")("https://gateway.test/200/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "test", messages: [] }),
        });
      }
      return await client.chatCompletions({ model: "test", messages: [] }, "test-key");
    } catch (error) {
      if (!(error instanceof CailError)) throw error;
      return Response.json({ code: error.code }, { status: 502 });
    }
  },
};
