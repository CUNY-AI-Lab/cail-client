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
Gateway error messages are preserved verbatim. The client never retries 4xx,
aborted requests, or requests with one-shot stream bodies. It retries network
and 5xx failures up to `maxRetries` (default 2).

A `401 authentication_required` response invokes `onAuthRequired` and still
throws the original error. In a browser, the default hook performs a guarded
same-origin login redirect.

## API

- `createCailClient(options): CailClient`
- `CailClient.run(request, credential, options?): Promise<Response>`
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
