import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { CailError, createCailClient } from "@cuny-ai-lab/cail-client";
import { quotaExceededEnvelope } from "@cuny-ai-lab/cail-client/testing";

const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ url: request.url, headers: request.headers, body });
  if (request.url === "/v1/quota") {
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify(quotaExceededEnvelope()));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert(address && "port" in address);
  const client = createCailClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    allowInsecureLoopback: true,
    app: "package-consumer",
  });
  const body = { model: "test-model", messages: [], stream: true };
  const response = await client.chatCompletions(body, "package-test-key");
  assert.equal(await response.text(), "data: [DONE]\n\n");
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer package-test-key");
  assert.equal(requests[0].headers["x-cail-app"], "package-consumer");
  assert.deepEqual(JSON.parse(requests[0].body), body);
  await assert.rejects(client.getQuota("package-test-key"), (error) =>
    error instanceof CailError && error.code === "quota_exceeded");
  assert.equal(requests.length, 2);
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
