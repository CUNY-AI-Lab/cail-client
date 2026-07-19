# @cuny-ai-lab/cail-client

The shared Web-standard client for CUNY applications that use the CAIL
gateway. It forwards exactly one user-bound CAIL credential, stamps app
attribution and validated optional metadata, preserves quota information, and
turns gateway error envelopes into typed errors. It runs in browsers, Workers,
and Node 20 or newer. Its only runtime dependency is `@cuny-ai-lab/cail-log`.

This package is an outbound transport helper. The gateway and each tool retain
their inbound identity, authorization, tenant-isolation, origin, and CSRF
boundaries. This README is the canonical package guide; the CAIL Gateway
repository's `docs/INTEGRATION.md` is the canonical wire contract for changes
that span producer and consumer.

## Install

The package is published to GitHub Packages under the `@cuny-ai-lab` scope.
Add the registry mapping to the consuming repository's `.npmrc` (resolution
only — never commit a token):

```
@cuny-ai-lab:registry=https://npm.pkg.github.com
```

Pin a semver range, for example `"@cuny-ai-lab/cail-client": "^1.1.0"`, then
run `bun install` with `NODE_AUTH_TOKEN` set in the environment to a GitHub
PAT that has `read:packages` (supplied by a user-level `~/.npmrc` or a CI
secret). Maintainers publish with `npm publish`; `bun publish` does not
authenticate against GitHub Packages.

## Construct a client

```ts
import { CailError, createCailClient } from "@cuny-ai-lab/cail-client";

const cail = createCailClient({
  baseUrl: CAIL_API_BASE,
  app: "alt-text",
});
```

`baseUrl` must be an absolute HTTPS URL without embedded credentials, a query,
or a fragment. The constructor canonicalizes the host, default port, and
trailing slashes. Local development may opt into plaintext HTTP only for the
literal hosts `localhost`, `127.0.0.1`, or `[::1]`:

```ts
const local = createCailClient({
  baseUrl: "http://localhost:8787",
  app: "alt-text",
  allowInsecureLoopback: true,
});
```

Do not derive `baseUrl` from a request, tenant, project, or other untrusted
input.

## Run a model

`run()` sends `POST {baseUrl}/v1/run` with exactly `{ model, input }`.

```ts
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

Server and background work may pass a personal or delegated CAIL key. Both are
charged to the owning CUNY user's quota; delegated keys are short-lived and
app-locked.

```ts
const response = await cail.run(
  { model: selectedModel, input },
  { kind: "key", token: env.CAIL_DELEGATED_KEY },
  { metadata: { project: projectId } },
);
```

The successful `Response` is returned by reference. Use
`parseQuotaHeaders(response.headers)` to read advisory quota headers without
buffering or changing the body.

`run()` is buffered. For streaming chat, use `chatCompletions()`.

## Streaming chat

`chatCompletions()` sends the OpenAI chat shape to
`POST {baseUrl}/v1/chat/completions`. With `stream: true`, the returned body is
the live SSE stream of `chat.completion.chunk` events ending in
`data: [DONE]`.

```ts
const controller = new AbortController();

const response = await cail.chatCompletions(
  {
    model: selectedModel,
    messages: [{ role: "user", content: "Count to three." }],
    stream: true,
  },
  { kind: "jwt", token: identityJwt },
  { signal: controller.signal },
);

// response.body is the untouched SSE stream.
```

Extra OpenAI parameters such as `temperature` and `tools` pass through
verbatim. The gateway owns streamed usage metering; the client does not rewrite
the request or successful response body.

### OpenAI-compatible SDK adapter

`chatFetch()` provides a narrowly scoped `fetch` adapter for
`POST /v1/chat/completions`. It accepts string, `URL`, and `Request` inputs,
normalizes semantically equivalent URLs, rejects other endpoints and methods
before network I/O, and never runs the client's retry loop.

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const provider = createOpenAICompatible({
  name: "cail",
  baseURL: `${CAIL_API_BASE}/v1`,
  apiKey: "cail-proxy", // dummy; chatFetch replaces this header
  fetch: cail.chatFetch({ kind: "jwt", token: identityJwt }),
});

const result = streamText({
  model: provider(selectedModel),
  messages,
  maxRetries: 0,
});
```

The default adapter is intended for SDKs, including the Vercel AI SDK, that
decide retries from status codes but do not honor `x-should-retry`. Ordinary
provider errors are returned for SDK parsing. A response carrying
`x-should-retry: false`, a `quota_exceeded` response, or an ambiguous network
failure throws `CailError`, preventing the SDK from replaying it. Redirects
also throw, and the 401 hook still runs from a cloned body.

The fleet contract keeps higher-level SDK automatic retries disabled. The
adapter's fail-closed behavior also protects direct callers and catches retry
configuration drift.

An SDK whose retry contract explicitly honors `x-should-retry: false` may
request response-preserving mode:

```ts
const sdkFetch = cail.chatFetch(credential, {
  nonRetryableErrorMode: "return",
});
```

In that mode, gateway-declared non-retryable responses remain `Response`
objects and platform network errors remain platform errors. A
`quota_exceeded` response is returned only when it explicitly carries
`x-should-retry: false`; otherwise it still throws fail closed. Verify an SDK's
current retry contract before selecting this mode, and keep its automatic
retries disabled under the fleet policy.

## Other gateway endpoints

`call()` is available for non-model endpoints such as `/v1/models` and key
delegation. It rejects the two model routes, which belong to `run()` and
`chatCompletions()`. Do not pass a path taken directly from user input; the
client joins the path to the configured base URL but does not maintain an
endpoint allowlist.

```ts
const response = await cail.call("/v1/models", { method: "GET" }, credential);
const quota = await cail.getQuota(credential);
```

## Authentication, ambient credentials, and attribution

The client enforces these wire rules:

- `{ kind: "jwt" }` sends `X-CAIL-Identity-JWT` and removes `Authorization`.
- `{ kind: "key" }` accepts only a non-empty, control-free `sk-cail-` key,
  sends it as `Authorization: Bearer <key>`, and removes the JWT header.
- `X-CAIL-App` is always the validated app slug supplied at construction.
- `X-CAIL-Metadata` accepts at most eight string or finite-number values.
  Reserved identity and prototype-pollution keys are rejected.

The gateway derives the subject from the verified JWT or CAIL key, authorizes
the request, enforces delegated-key app locks, and charges quota.
`X-CAIL-App` records app attribution. The current gateway ignores
`X-CAIL-Metadata`, so project, course, and purpose values are not authoritative
gateway spend dimensions.

Ambient cookies are omitted by default. A caller-supplied `Cookie` header or a
`RequestInit.credentials` value other than `omit` fails before fetch. A
deployment with an explicitly reviewed cookie contract may opt in:

```ts
const cail = createCailClient({
  baseUrl: CAIL_API_BASE,
  app: "alt-text",
  allowAmbientCredentials: true,
});
```

Use session JWTs in browser code. Never embed a personal or delegated key in a
browser bundle or local storage. The package does not provide CSRF or origin
checks. Custom CAIL headers also trigger CORS preflight on cross-origin browser
calls; the gateway must allow the origin, method, and headers.

The default browser 401 hook accepts only a same-origin `login_url` and falls
back to `/login` on the application's origin. A different login origin needs a
custom `onAuthRequired` callback with an explicit origin allowlist.

## Correlation

Pass a `CailCorrelation` from `correlationFromHeaders()` through
`options.correlation`. The client replaces `traceparent`, `tracestate`, and
`X-CAIL-Request-Id` as one unit, using `outboundCorrelationHeaders()`. If the
correlation has no `tracestate`, a caller-supplied stale value is removed.
The sampling bit in `trace_flags` is preserved, and request IDs are lowercase
UUID v4 values. Malformed correlation fails before fetch. The package
re-exports the cail-log correlation functions, types, and all three header
constants. Its logging schema-v2, versioned-subject, and event-provenance APIs
remain logger concerns; this transport does not construct or reinterpret log
events or quota subjects.

## Errors, retries, and ambiguous outcomes

Non-success direct calls throw
`CailError { code, type, param, message, status, extras }`. The parser accepts
the nested OpenAI-compatible gateway envelope and preserves its message,
`type`, `param`, `code`, and `error.cail` fields. Valid `x-request-id`,
`x-should-retry`, and `Retry-After` response metadata is added to `extras`.

Each `run()` call mints one UUID v4 `Idempotency-Key` before its retry loop and
reuses it for every attempt. A caller may supply a UUID v4 through
`options.idempotencyKey` to deduplicate the same logical run across its own
restart. The gateway's durable claim/replay contract makes those retries safe.

`chatCompletions()` is always single-attempt. Direct calls also do not retry
ordinary 4xx responses, aborted requests, one-shot stream bodies, or responses
with `x-should-retry: false`. `getQuota()` is single-attempt, including on 5xx.

Generic non-idempotent `call()` requests are single-attempt even when they
carry an `Idempotency-Key`. Retrying one requires both a non-empty key and the
explicit assertion that the endpoint implements durable claim/replay:

```ts
await cail.call(
  "/some-durable-endpoint",
  { method: "POST", headers: { "Idempotency-Key": stableKey } },
  credential,
  { retryNonIdempotent: true },
);
```

Idempotent methods such as GET, HEAD, PUT, and DELETE remain eligible for
network and 5xx retries. Eligible calls use `maxRetries` (default 2) and
full-jitter exponential backoff between zero and
`min(2s, 200ms x 2^attempt)`. `Retry-After` delay-seconds and HTTP-date values
are honored up to a 30-second ceiling. A larger hint is capped at 30 seconds;
the caller must handle longer recovery windows outside this transport.

Cancellation cannot prove that a model request was not accepted or billed.
Treat the outcome as ambiguous unless the gateway's idempotency replay
contract resolves it.

## Cancellation and streaming ownership

`CailCallOptions.signal` works with `call()`, `run()`,
`chatCompletions()`, and `chatFetch()`. It takes precedence over an
`init.signal`. Aborts preserve the original abort reason and are never retried.

Successful responses are returned by reference. The caller owns consuming and
cancelling a streaming response body when its browser request, Worker request,
or server connection closes.

## API

- `createCailClient(options): CailClient`
- `CailClient.run(request, credential, options?): Promise<Response>`
- `CailClient.chatCompletions(request, credential, options?): Promise<Response>`
- `CailClient.chatFetch(credential, options?): typeof fetch`-compatible adapter
- `CailClient.call(path, init, credential, options?): Promise<Response>`
- `CailClient.getQuota(credential): Promise<CailQuotaSnapshot>`
- `parseQuotaHeaders(headers): CailQuota | null`
- `parseCailError(response): Promise<CailError>`
- `extractCailError(value): CailError | null` — dig the typed CAIL envelope
  out of an already-consumed, SDK-wrapped error object (AI SDK `RetryError` →
  `APICallError.responseBody` JSON strings, nested
  `cause`/`error`/`data`/`lastError`, `errors[]` arrays). Returns `null` for
  non-CAIL errors; it never sniffs bare HTTP statuses or message text.
- `browserAuthRedirect(error): void`

Important option types are exported as `CailClientOptions`, `CailCallOptions`,
`CailRunOptions`, and `CailChatFetchOptions`.

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run test
bun pm pack --dry-run
git diff --exit-code -- dist
```

CI builds and checks the package contents before testing. It fails if the
tracked or untracked `dist/` tree differs after the build. The recording fetch
tests assert outgoing URLs, methods, headers, credentials, signals, and bodies
at the wire boundary.

`test/quota-wire-vectors.json` is a byte-for-byte copy of the producer-owned
`cail-gateway/model-proxy/test/quota-wire-vectors.json`, with its SHA-256 pinned
in both repositories. Change the producer artifact first, then copy the whole
file and update both hash assertions in one coordinated change. The client
parses those raw producer bodies and rejects the retired flat envelope; it must
not introduce a second schema.

## License

MIT. See [LICENSE](LICENSE).
