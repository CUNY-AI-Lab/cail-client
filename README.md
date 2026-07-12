# @cuny-ai-lab/cail-client

The shared Web-standard client for the CAIL gateway. It sends exactly one CAIL
credential, stamps spend-attribution headers, preserves quota information, and
turns gateway error envelopes into typed errors.

It runs in browsers, Workers, and Node 20 or newer with no runtime dependencies.

## Install

The package is consumed from its public Git repository. Build output is
committed, so consumers do not need to build it during installation.

```bash
bun add github:CUNY-AI-Lab/cail-client
```

Pin a tag or commit for reproducibility, for example
`github:CUNY-AI-Lab/cail-client#v1.1.0`.

## Run a model

`run()` is the model API. It always sends `POST {baseUrl}/v1/run` with a JSON
body containing exactly `{ model, input }`.

```ts
import { CailError, createCailClient } from "@cuny-ai-lab/cail-client";

const cail = createCailClient({
  baseUrl: CAIL_API_BASE,
  app: "alt-text",
});

try {
  const response = await cail.run(
    {
      model: selectedModel,
      input: {
        messages: [{ role: "user", content: "Describe this image." }],
      },
    },
    { kind: "jwt", token: identityJwt },
    { metadata: { purpose: "alt-text" } },
  );

  const result = await response.json();
} catch (error) {
  if (error instanceof CailError) showMessage(error.message);
}
```

For server or background work, pass a personal or delegated CAIL key:

```ts
const response = await cail.run(
  { model: selectedModel, input },
  { kind: "key", token: env.CAIL_DELEGATED_KEY },
  { metadata: { project: projectId } },
);
```

The successful `Response` is returned by reference. Use
`parseQuotaHeaders(response.headers)` to read advisory quota headers without
buffering or changing the response body.

`run()` is buffered by design (the gateway rejects `input.stream`). For
streaming chat, use `chatCompletions()`.

## Streaming chat

`chatCompletions()` sends the OpenAI chat shape to
`POST {baseUrl}/v1/chat/completions`. With `stream: true` the returned
`Response` body is the live SSE stream — `chat.completion.chunk` events
ending in `data: [DONE]`:

```ts
const response = await cail.chatCompletions(
  {
    model: selectedModel,
    messages: [{ role: "user", content: "Count to three." }],
    stream: true,
  },
  { kind: "jwt", token: identityJwt },
);
// response.body is the SSE stream, untouched.
```

Extra OpenAI parameters (`temperature`, `max_tokens`, `tools`, …) pass
through verbatim. The gateway meters streamed spend itself (it force-injects
`stream_options.include_usage` upstream); the client never rewrites the body.

### With the Vercel AI SDK

`chatFetch()` builds a `fetch`-shaped adapter that owns the credential and
header discipline, so tools stop hand-rolling it:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const provider = createOpenAICompatible({
  name: "cail",
  baseURL: `${CAIL_API_BASE}/v1`,
  apiKey: "cail-proxy", // dummy — the adapter strips it and sends the real credential
  fetch: cail.chatFetch({ kind: "jwt", token: identityJwt }),
});

const result = streamText({ model: provider(selectedModel), messages });
```

The adapter keeps raw fetch semantics: non-2xx responses are returned (the
SDK parses them and owns retries), the client's own retry loop is disabled,
redirects still throw (the identity JWT never follows a redirect), and the
`onAuthRequired` hook still fires on 401s. It serves only
`POST {baseUrl}/v1/chat/completions` — any other URL throws, which catches
SDK base-URL misconfiguration loudly.

One deliberate carve-out: a `429 quota_exceeded` envelope **throws the
`CailError`** instead of returning the response. AI SDKs treat any 429 as
retryable, but a CAIL quota 429 resets on a budget window — retrying only
burns attempts and then buries the envelope inside the SDK's `RetryError`.
The thrown `CailError` is not a type any SDK retries, so the verbatim quota
message (with `extras.retry_after_seconds`) surfaces on the first failure.
Catch it (or `instanceof CailError` in your SDK `onError`) to show the user
their quota state.

## Other gateway endpoints

`call()` remains available for non-model gateway endpoints such as `/models`
and key delegation. Do not use it for model invocation.

```ts
const response = await cail.call(
  "/models",
  { method: "GET" },
  credential,
);
```

For an explicit quota snapshot:

```ts
const quota = await cail.getQuota(credential);
```

## Authentication and headers

The client enforces these wire rules:

- `{ kind: "jwt" }` sends `X-CAIL-Identity-JWT` and removes `Authorization`.
- `{ kind: "key" }` sends `Authorization: Bearer <key>` and removes the JWT
  header.
- `X-CAIL-App` is always the validated app slug supplied at construction.
- Optional `X-CAIL-Metadata` accepts at most eight string or finite-number
  values. Reserved identity and prototype-pollution keys are rejected.

Tokens must be non-empty and contain no control characters.

## Errors and retries

Non-success responses throw `CailError { code, message, status, extras }`.
Gateway error messages are preserved verbatim. Each buffered `run()` call
generates one UUID v4 `Idempotency-Key` before its retry loop and reuses it for
every attempt, allowing safe network and 5xx retries through the gateway's
durable claim/replay contract. Streaming `chatCompletions()` calls are never
retried by this client. The client also never retries 4xx, aborted requests, or
requests with one-shot stream bodies. Eligible calls retry network and 5xx
failures up to `maxRetries` (default 2 when omitted). A present but
invalid `maxRetries` — anything other than a finite integer >= 0 — throws
`invalid_config` at construction; invalid config is never silently coerced.

A `401 authentication_required` response invokes `onAuthRequired` and still
throws the original error. In a browser, the default hook performs a guarded
same-origin login redirect.

## API

- `createCailClient(options): CailClient`
- `CailClient.run(request, credential, options?): Promise<Response>`
- `CailClient.chatCompletions(request, credential, options?): Promise<Response>`
  (streaming-capable)
- `CailClient.chatFetch(credential, options?): (url, init?) => Promise<Response>`
  adapter for OpenAI-style SDKs (raw fetch semantics)
- `CailClient.call(path, init, credential, options?): Promise<Response>` for
  non-model endpoints
- `CailClient.getQuota(credential): Promise<CailQuotaSnapshot>`
- `parseQuotaHeaders(headers): CailQuota | null`
- `parseCailError(response): Promise<CailError>`
- `browserAuthRedirect(error): void`

## Development

```bash
bun install
bun run typecheck
bun run build
bun test
```

The tests use a recording fetch mock to assert outgoing URLs, headers, methods,
and bodies at the wire boundary.

## License

MIT — see [LICENSE](LICENSE).
