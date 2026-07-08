# `@cuny-ai-lab/cail-client`

The CAIL model-proxy API client — one pure, load-bearing primitive. It is the
library every CAIL tool uses to *call* the model proxy correctly: it owns the
credential-forwarding, header, error-envelope, and retry contract from
[`INTEGRATION.md`](https://github.com/CUNY-AI-Lab) §1–2 so no tool re-derives it.

The **consumer-side twin** of [`@cuny-ai-lab/cail-identity`](https://github.com/CUNY-AI-Lab/cail-identity)
(the server-side verifier).

Pure Web-standard `fetch`/`Request`/`Response`: the same source runs unchanged in
the **browser**, **Cloudflare Workers**, and **Node ≥20**. No SDK dependencies.
The public surface is `string`/`number`/plain-object/`Response` only — no
ambient Cloudflare/Node types leak out of the `.d.ts`.

The **8 invariants below are the semver contract**: loosening or removing any one
is a major bump every consumer opts into deliberately.

## The contract

`createCailClient({ baseUrl, app, onAuthRequired?, fetchImpl?, maxRetries? })`
returns `{ call(path, init, credential, options?) }`. `call()` returns the 2xx
`Response` **by reference** (never buffered) and **throws** a `CailError` on any
backbone error.

| # | Invariant | What the client guarantees |
|---|-----------|----------------------------|
| **I1** | Exactly one credential on the wire | `kind:"jwt"` → sets `X-CAIL-Identity-JWT` **and deletes any `Authorization`** the caller/SDK injected (the dummy-bearer strip — the proxy is JWT-first-strict). `kind:"key"` → `Authorization: Bearer <token>`, **no** JWT header. Never both. |
| **I2** | `X-CAIL-App` always sent | Equals the constructed `app`; the caller cannot override it. The slug is validated at construction against `/^[a-z0-9][a-z0-9-]{0,63}$/` — **invalid → throws at construction** (fail fast, low-cardinality per-tool). |
| **I3** | `X-CAIL-Metadata` validated | Optional per-call: ≤8 keys, `string`\|`number` values, string values ≤128 chars, reserved keys (`user_id`, `app`, `via`) rejected. Violations **throw**; valid metadata is serialized as JSON. |
| **I4** | Error envelope → typed error, message verbatim | Non-2xx → parses `{error, message, ...extras}` into `CailError{code, message, status, extras}`. `message` is passed through **unmodified**. A non-JSON error body → `CailError{code:"unknown_error"}` — **never swallowed as success**. |
| **I5** | Retry policy | **Never** retries 4xx. Retries 5xx + network errors up to `maxRetries` (default 2) with exponential backoff. |
| **I6** | 401 hook | `status === 401 && code === "authentication_required"` → invokes `onAuthRequired(err)`, then **still throws** so callers can `await`. Browser default: same-origin redirect to `err.extras.login_url` or `/login?rt=<path>`. |
| **I7** | 2xx passthrough, streams intact | The success `Response` is returned **by reference** — body is not buffered, so SSE/streaming model responses pass through unmodified. |
| **I8** | Body + model untouched | `init.body` is forwarded verbatim; the client does **not** rewrite the `model` id (the proxy adds the `workers-ai/` prefix on compat routes). |

## Install

Published to GitHub Packages (org-scoped registry), or consumed as a public
git-dep. For the registry, consumers add an `.npmrc`:

```ini
# .npmrc
@cuny-ai-lab:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @cuny-ai-lab/cail-client
# or as a public git-dep:
npm install github:CUNY-AI-Lab/cail-client
```

## Usage

### Browser tool behind the SSO gate (JWT path)

Forward the gate-injected identity JWT. Any `Authorization` your model SDK
emits (the dummy-bearer footgun) is stripped for you.

```ts
import { createCailClient, CailError } from "@cuny-ai-lab/cail-client";

const cail = createCailClient({
  baseUrl: CAIL_API_BASE,       // e.g. https://api.ailab.gc.cuny.edu
  app: "alt-text",              // your stable, low-cardinality tool slug
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
  if (err instanceof CailError) {
    // err.message is written to be shown as-is (do not reword).
    showToast(err.message);
  }
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

### Streaming (SSE) responses

The 2xx `Response` is returned by reference and never buffered, so stream the
body directly:

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

Every backbone error is a `CailError{ code, message, status, extras }`. Show
`message` as-is; branch on `code`/`status` for behavior.

```ts
try {
  await cail.call(path, init, credential);
} catch (err) {
  if (err instanceof CailError) {
    switch (err.code) {
      case "quota_exceeded":       // 429 — do not retry; err.extras.retry_after_seconds
      case "invalid_api_key":      // 401 — link to /api-keys/
      case "forbidden":            // 403 — err.extras.missing_entitlement
        showMessage(err.message);
        break;
      default:
        showMessage(err.message);  // unknown_error / network_error included
    }
  }
}
```

## API

- `createCailClient(opts): CailClient` — validates the `app` slug at construction.
- `CailClient.call(path, init, credential, options?): Promise<Response>` — 2xx by
  reference; throws `CailError` otherwise.
- `class CailError extends Error` — `{ code, message, status, extras }`.
- `parseCailError(response): Promise<CailError>` — the standalone envelope parser
  (I4), for classifying a raw `Response`.
- `browserAuthRedirect(err)` — the default browser 401 hook (same-origin-guarded).

## Development

```bash
npm install
npm run typecheck   # tsc, source + tests
npm run build       # emit dist/ (committed, so git-deps resolve)
npm test            # the 26 contract vectors (vitest)
```

The [`test/`](test) suite injects a **recording mock** `fetch` that captures the
outgoing request and asserts every invariant on the **captured wire**, not the
client's internals — the contract is validated independently of the
implementation. `dist/` is committed so the package resolves as a public git-dep
without a build step.

## License

MIT — see [LICENSE](LICENSE).
