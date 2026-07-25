# @cuny-ai-lab/cail-client

The shared Web-standard client for CUNY applications that use the CAIL
gateway. On authenticated calls it forwards exactly one CAIL credential,
stamps app attribution and validated optional metadata, and turns gateway
error envelopes into typed errors. It also exposes the gateway's deliberately
public model catalog without private headers. It runs in browsers, Workers,
and Node 20 or newer. Its only runtime dependency is
`@cuny-ai-lab/cail-log`.

This package is an outbound transport helper. The gateway and each tool retain
their inbound identity, authorization, tenant-isolation, origin, and CSRF
boundaries. This README is the canonical package guide; the CAIL Gateway
repository's `docs/INTEGRATION.md` is the canonical wire contract for changes
that span producer and consumer.

## Boundary and invariants

Trusted configuration (`baseUrl` and `app`), one caller-supplied credential,
and request data enter the authenticated boundary. A Web `Response` or typed
`CailError` leaves it. The public catalog is the sole zero-credential path.

- The client is not an identity verifier, authorization layer, provider-key
  holder, quota source, or logging system.
- Authenticated calls send one credential family and client-owned headers
  override caller copies. Public catalog calls send none of those headers.
- Paths stay on the configured origin and inside its base path. Redirects are
  never followed.
- `run()` owns buffered model idempotency. Chat and SSE calls are
  single-attempt.
- Successful response bodies, including SSE, pass through untouched. Only
  client-owned error and quota parsing is bounded.
- The client emits no logs and never puts credentials or raw response bodies
  in its own errors.

## Install

The package is published to GitHub Packages under the `@cuny-ai-lab` scope.
Add the registry mapping and environment-variable interpolation to the
consuming repository's `.npmrc`. Never place an actual token in this file:

```
@cuny-ai-lab:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Pin an exact release, for example `"@cuny-ai-lab/cail-client": "2.0.1"`, then
run `bun install` with `NODE_AUTH_TOKEN` set in the environment to a GitHub
PAT that has `read:packages` (supplied by a user-level `~/.npmrc` or a CI
secret). Bun 1.3.5 reads the registry and token interpolation from `.npmrc`;
the npm CLI is not required.

Maintainers keep authentication outside the repository. The source checkout
pins the independently reviewed cail-log 0.6.0 tarball under `vendor/` so
frozen installs and tests need no sibling repository or package credential.
That source-only artifact is excluded from the packed client; the published
client truthfully depends on exact `@cuny-ai-lab/cail-log` 0.6.0 from GitHub
Packages.

The reviewed cail-log artifact and its immutable registry receipt are present,
so that dependency gate is satisfied. Client 2.0.0 is already present in the
registry; this source uses the unoccupied 2.0.1 successor and does not claim it
has been published. The checked-in release authority records the 2.0.0 package
version identity and the dated observation that 2.0.1 was absent. The publish
workflow repeats that read-only registry query immediately before publishing.
Changing either local authority file alone cannot authorize a conflicting
release. An exact source archive may run `bun install --frozen-lockfile` and
`bun run check` without Git history. Publication is intentionally limited to a
clean Git checkout and fails closed with a clear error in archive mode.

Set `NODE_AUTH_TOKEN` to a classic GitHub PAT with `write:packages`, verify with
`bun publish --dry-run`, and release with `bun publish`. Both commands invoke
the complete `prepublishOnly` gate before any registry mutation. GitHub Actions
may instead use a repository `GITHUB_TOKEN` with `packages: write`.

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

Server and background work may pass a personal, delegated, or app-principal
CAIL key. All use the `sk-cail-…` family. The gateway resolves the key to its
canonical user (`cail-…`) or application (`app-…`) subject and enforces its
policy. Delegated keys are short-lived and app-locked. App-principal deployment
state and key rotation remain application responsibilities.

```ts
const response = await cail.run(
  { model: selectedModel, input },
  { kind: "key", token: env.CAIL_DELEGATED_KEY },
  { metadata: { project: projectId } },
);
```

The successful `Response` is returned by reference. Quota is read through the
canonical authenticated `GET /quota` endpoint; the client does not implement
the retired advisory quota-header path.

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
verbatim. The gateway may add usage fields for bounded diagnostics, while
Cloudflare AI Gateway owns accounting and enforcement. The client does not
rewrite the request or successful response body.

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

`getCatalog()` reads the public `GET /v1/catalog` model catalog without a
credential, app attribution, metadata, correlation, cookies, or ambient
browser credentials. The optional facet is `"text"`, `"image"`, or `"all"`.

```ts
const publicCatalog = await cail.getCatalog({ modality: "all" });
const catalog = await cail.getCatalogSnapshot({ modality: "text" });
```

`getCatalog()` leaves the successful response body to the caller.
`getCatalogSnapshot()` consumes a bounded body and validates the CAIL catalog
contract before returning plain data.

`call()` is available for authenticated non-model endpoints such as
`/v1/models`, `/quota`, and key delegation. It rejects model invocation and the
public catalog, which belong to their dedicated methods. Paths must be
gateway-relative, contain no fragment, backslash, control character, or
whitespace, and remain inside the configured base path after URL
normalization. Do not pass a path taken directly from user input; `call()` does
not maintain a general endpoint allowlist.

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
the request, and enforces delegated-key app locks. Cloudflare AI Gateway
partitions accounting and budget enforcement by the canonical subject.
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

Use session JWTs in browser code. Never embed a personal, delegated, or
app-principal key in a browser bundle or local storage. The package does not
provide CSRF or origin checks. Custom CAIL headers also trigger CORS preflight
on cross-origin browser calls; the gateway must allow the origin, method, and
headers. `getCatalog()` avoids that preflight by sending only `Accept`.

The default browser 401 hook accepts only a same-origin `login_url` and falls
back to `/login` on the application's origin. A different login origin needs a
custom `onAuthRequired` callback with an explicit origin allowlist.

## Correlation

Pass a `CailCorrelation` from `correlationFromHeaders()` through
`options.correlation`. The client replaces `traceparent`, `tracestate`, and
`X-CAIL-Request-Id` as one unit, using `outboundCorrelationHeaders()`. If the
correlation has no `tracestate`, a caller-supplied stale value is removed.
The sampling bit in `trace_flags` is preserved, and request IDs are lowercase
UUID v4 or UUID v7 values. Malformed correlation fails before fetch. The package
re-exports the cail-log correlation functions, types, and all three header
constants. Its logging schema-v2, versioned-subject, and event-provenance APIs
remain logger concerns; this transport does not construct or reinterpret log
events or quota subjects. The client itself emits no logs.

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

`chatCompletions()` and `chatFetch()` are always single-attempt. Direct calls
also do not retry ordinary 4xx responses, aborted requests, one-shot stream
bodies, or responses with `x-should-retry: false`. The safe public catalog uses
the normal idempotent-GET retry policy. `getQuota()` caps retryable network/5xx
read-through failures at one retry, even when the client's `maxRetries` is
higher; `maxRetries: 0` and `x-should-retry: false` still disable it.

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
Treat the outcome as ambiguous. A stable `run()` idempotency key lets the
gateway's durable claim/replay contract resolve a later replay; chat has no
equivalent replay contract.

## Cancellation and streaming ownership

`CailCallOptions.signal` works with `call()`, `run()`,
`chatCompletions()`, and `chatFetch()`. It takes precedence over an
`init.signal`. Aborts preserve the original abort reason and are never retried.
`getCatalog()` and `getQuota()` accept the same kind of signal. The package
sets no implicit request deadline; callers that need one should pass
`AbortSignal.timeout(...)` or an `AbortController`.

Successful responses are returned by reference. The caller owns consuming and
cancelling a streaming response body when its browser request, Worker request,
or server connection closes. The client imposes no size limit on successful
model or SSE bodies because it does not consume them. Direct error and quota
bodies are limited to 64 KiB before parsing. `extractCailError()` refuses
already-buffered SDK JSON strings over 256 KiB.

## Quota read-through

`getQuota()` reads the authenticated user or app subject's current stateless
Cloudflare AI Gateway snapshot. It validates the canonical subject, fixed
`microdollar`/`USD` units, safe integer fields, positive window and limit, and
the relationship `remaining = max(0, limit - used)`. A malformed 2xx body
throws `CailError { code: "unknown_error" }`. The read is eventually
consistent and is not evidence that a concurrent model request has or has not
been accounted for.

## API

- `createCailClient(options): CailClient`
- `CailClient.run(request, credential, options?): Promise<Response>`
- `CailClient.chatCompletions(request, credential, options?): Promise<Response>`
- `CailClient.chatFetch(credential, options?): typeof fetch`-compatible adapter
- `CailClient.call(path, init, credential, options?): Promise<Response>`
- `CailClient.getCatalog(options?): Promise<Response>`
- `CailClient.getCatalogSnapshot(options?): Promise<CailModelCatalog>`
- `CailClient.getQuota(credential, options?): Promise<CailQuotaSnapshot>`
- `parseCailModelCatalog(value): CailModelCatalog`
- `parseCailError(response, signal?): Promise<CailError>`
- `extractCailError(value): CailError | null` — dig the typed CAIL envelope
  out of an already-consumed, SDK-wrapped error object (AI SDK `RetryError` →
  `APICallError.responseBody` JSON strings, nested
  `cause`/`error`/`data`/`lastError`, `errors[]` arrays). Returns `null` for
  non-CAIL errors; it never sniffs bare HTTP statuses or message text.
- `browserAuthRedirect(error): void`

Important option types are exported as `CailClientOptions`, `CailCallOptions`,
`CailRunOptions`, `CailChatFetchOptions`, `CailCatalogOptions`, and
`CailQuotaOptions`.

## Test fixtures (`@cuny-ai-lab/cail-client/testing`)

Consumer tests kept hand-rolling the CAIL wire shapes and drifting from the
contract the client actually consumes. Build fixtures from the blessed
subpath instead:

```ts
import {
  cailErrorEnvelope,      // { error: { message, type, param, code, cail? } }
  cailErrorResponse,      // wraps an envelope in a JSON Response
  quotaExceededEnvelope,  // canonical 429 quota_exceeded body
  quotaExceededResponse,  // + Retry-After and x-should-retry: false headers
  quotaSnapshotBody,      // valid GET /quota body
  quotaSnapshotResponse,  // 200 JSON Response for a mocked GET /quota
} from "@cuny-ai-lab/cail-client/testing";

// Exactly what parseCailError / extractCailError consume:
const wrapped = { lastError: { statusCode: 429, responseBody: JSON.stringify(quotaExceededEnvelope()) } };
extractCailError(wrapped)?.extras.retry_after_seconds; // 3600

// Exactly what getQuota consumes:
const fetchImpl = async () => quotaSnapshotResponse({ remaining: 0, state: "stale" });
```

Every builder is round-tripped in this package's own suite through
`parseCailError`, `extractCailError`, and `getQuota`, so
the fixtures cannot drift from the client. The subpath is additive test
support: the runtime entry never imports it, and it imports no test
framework. For canonical test *subjects* and identity-JWT minting, use
`@cuny-ai-lab/cail-identity/testing`.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` scans tracked text formatting, typechecks, runs every test,
dry-runs the package contents without lifecycle scripts, rebuilds in a
temporary directory, and rejects tracked or untracked
`dist/` drift. `prepublishOnly` runs this same package-local gate; it does not
depend on a sibling repository. CI installs from the frozen lockfile and the
reviewed vendored Log artifact without registry credentials. The recording
fetch tests assert outgoing URLs, methods, headers, credentials, signals, and
bodies at the wire boundary.

`contract/model-gateway-v1.json` is the packaged catalog/quota/error
conformance fixture. The broader `test/quota-wire-vectors.json` suite is
reviewed against the current gateway quota read-through and nested error
contract. The client rejects the old flat error envelope and must not
introduce a second schema.

## License

MIT. See [LICENSE](LICENSE).
