# @cuny-ai-lab/cail-client

Call the CAIL model proxy correctly. One wrapper that forwards exactly one
credential, stamps the spend-attribution headers, and turns the backbone's
error envelope into typed errors — so no tool re-derives the contract by hand
and gets the subtle parts wrong.

The **consumer-side twin** of
[`@cuny-ai-lab/cail-identity`](https://github.com/CUNY-AI-Lab/cail-identity)
(the server-side verifier). This one *sends* a credential; that one *checks*
one. They share no code and version independently.

Pure Web-standard `fetch`/`Request`/`Response` — the same source runs unchanged
in the **browser**, **Cloudflare Workers**, and **Node ≥20**. No SDK
dependencies. The secret/token is always yours, passed per call.

## Who needs this

Anything that *makes model calls* through the proxy — Site Studio, Agent Studio,
Kale Workbench, a tool frontend, or a Kale-deployed student project. The
backbone itself (the model proxy, the key service) does **not** need this: it
*is* the API being called. If you only *verify* an inbound identity token and
never call the proxy, you want `@cuny-ai-lab/cail-identity` instead.

The single hardest thing to get right by hand — and the reason this exists — is
credential forwarding: the proxy is JWT-first-strict, so when you send the
session JWT you must send *exactly* that and strip any `Authorization` header
your model SDK quietly added (the "dummy bearer" footgun). This library does it
for you.

## Install

Consumed as a public git dependency. The package commits its build output, so
it resolves with no build step:

```bash
bun add github:CUNY-AI-Lab/cail-client
# or
npm install github:CUNY-AI-Lab/cail-client
```

Pin to a tag or commit for reproducibility, e.g.
`github:CUNY-AI-Lab/cail-client#v1.0.0`.

> Not on GitHub Packages (can't host public packages, needs a `write:packages`
> token). The public git-dep above is the supported path.

## Quick start

### Browser tool behind the SSO gate (JWT path)

Forward the gate-injected identity JWT. Any `Authorization` your SDK emits is
stripped for you.

```ts
import { createCailClient, CailError } from "@cuny-ai-lab/cail-client";

const cail = createCailClient({
  baseUrl: CAIL_API_BASE,   // e.g. https://api.ailab.gc.cuny.edu
  app: "alt-text",          // your stable, low-cardinality tool slug
  // onAuthRequired defaults to a same-origin login redirect in the browser.
});

try {
  const res = await cail.call(
    "/v1/compat/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "@cf/zai-org/glm-5.2",   // bare @cf/... id — forwarded verbatim
        messages: [{ role: "user", content: "Describe this image." }],
      }),
    },
    { kind: "jwt", token: identityJwt },
    { metadata: { purpose: "alt-text" } }, // optional spend dimensions
  );
  const data = await res.json();
} catch (err) {
  if (err instanceof CailError) showToast(err.message); // shown as-is; do not reword
}
```

### Server / Worker with a personal or delegated key (key path)

```ts
const cail = createCailClient({ baseUrl: CAIL_API_BASE, app: "kale-project" });

const res = await cail.call(
  "/v1/compat/chat/completions",
  { method: "POST", headers: { "content-type": "application/json" }, body },
  { kind: "key", token: env.CAIL_DELEGATED_KEY },  // sk-cail-…
  { metadata: { project: projectId } },            // per-project spend drill-down
);
```

### Streaming (SSE)

The 2xx `Response` is returned by reference and never buffered — stream directly:

```ts
const res = await cail.call("/v1/compat/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, messages, stream: true }),
}, credential);

const reader = res.body!.getReader();
// … read chunks as they arrive …
```

### Error handling

Every backbone error is a `CailError { code, message, status, extras }`. Show
`message` as-is; branch on `code`/`status` for behavior. **4xx are never
retried.**

```ts
try {
  await cail.call(path, init, credential);
} catch (err) {
  if (err instanceof CailError) {
    switch (err.code) {
      case "quota_exceeded":   // 429 — err.extras.retry_after_seconds
      case "invalid_api_key":  // 401 — link to /api-keys/
      case "forbidden":        // 403 — err.extras.missing_entitlement
      default:                 // unknown_error / network_error included
        showMessage(err.message);
    }
  }
}
```

## The contract — 8 invariants

`createCailClient({ baseUrl, app, onAuthRequired?, fetchImpl?, maxRetries? })`
returns `{ call(path, init, credential, options?) }`. `call()` returns the 2xx
`Response` **by reference** and **throws** a `CailError` on any backbone error.
Loosening or removing any invariant is a **major** semver bump.

| # | Invariant | The client guarantees |
|---|-----------|-----------------------|
| **I1** | Exactly one credential on the wire | `kind:"jwt"` → sets `X-CAIL-Identity-JWT` **and deletes any `Authorization`** the caller/SDK injected (dummy-bearer strip; the proxy is JWT-first-strict). `kind:"key"` → `Authorization: Bearer <token>`, **no** JWT header. Never both. |
| **I2** | `X-CAIL-App` always sent | Equals the constructed `app`; the caller can't override it. The slug is validated against `/^[a-z0-9][a-z0-9-]{0,63}$/` — **invalid → throws at construction**. |
| **I3** | `X-CAIL-Metadata` validated | Optional per call: ≤8 keys, `string`\|`number` values, string values ≤128 chars, reserved keys (`user_id`, `app`, `via`) rejected. Violations **throw**; valid metadata is serialized as JSON. |
| **I4** | Error envelope → typed error, message verbatim | Non-2xx → `CailError{code, message, status, extras}`; `message` passed through **unmodified**. Non-JSON error body → `CailError{code:"unknown_error"}` — **never swallowed as success**. |
| **I5** | Retry policy | **Never** retries 4xx. Retries 5xx + network up to `maxRetries` (default 2) with exponential backoff. |
| **I6** | 401 hook | `401 authentication_required` → invokes `onAuthRequired(err)`, then **still throws**. Browser default: same-origin redirect to `err.extras.login_url` or `/login?rt=<path>`. |
| **I7** | 2xx passthrough, streams intact | Success `Response` returned **by reference** — body not buffered, so SSE streams pass through. |
| **I8** | Body + model untouched | `init.body` forwarded verbatim; the client does **not** rewrite the `model` id (the proxy adds the `workers-ai/` prefix on compat routes). |

## API

- `createCailClient(opts): CailClient` — validates the `app` slug at construction.
- `CailClient.call(path, init, credential, options?): Promise<Response>` — 2xx by
  reference; throws `CailError` otherwise.
- `class CailError extends Error` — `{ code, message, status, extras }`.
- `parseCailError(response): Promise<CailError>` — standalone envelope parser (I4).
- `browserAuthRedirect(err)` — the default browser 401 hook (same-origin-guarded).

## Development

```bash
npm install
npm run typecheck   # tsc, source + tests
npm run build       # emit dist/ (committed, so git-deps resolve)
npm test            # the 26 contract vectors (vitest)
```

The test suite injects a **recording mock** `fetch` that captures the outgoing
request and asserts every invariant on the **captured wire**, not the client's
internals — the contract is validated independently of the implementation.

## License

MIT — see [LICENSE](LICENSE).
