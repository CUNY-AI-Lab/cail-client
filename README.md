# @cuny-ai-lab/cail-client

Small Web-standard helpers for the CAIL Gateway. The client owns credential
headers, the OpenAI-compatible chat transport, the CAIL-native `run` route,
the public model catalog, the Cloudflare quota estimate, and safe Gateway
errors. It does not implement provider schemas or retry requests.

## Install

The package is published to GitHub Packages:

```ini
@cuny-ai-lab:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```sh
bun add @cuny-ai-lab/cail-client
```

## Client

```ts
import {
  CAIL_GATEWAY_OPENAI_BASE_URL,
  createCailClient,
} from "@cuny-ai-lab/cail-client";

const cail = createCailClient({
  app: "alt-text",
});
```

The client defaults to the canonical Gateway origin
`https://tools.ailab.gc.cuny.edu`. `CAIL_GATEWAY_OPENAI_BASE_URL` is the full
OpenAI-compatible base, `https://tools.ailab.gc.cuny.edu/v1`, for SDKs that
need a URL. An explicit `baseUrl` remains available for a real custom Gateway
origin (for example, a local loopback during development); it must be an
absolute HTTPS URL without credentials, a query, or a fragment. Local HTTP is
available only for `localhost`, `127.0.0.1`, or `[::1]` with
`allowInsecureLoopback: true`. The app is a lowercase slug.

Credentials can be passed as a key string shorthand or an explicit kind:

```ts
await cail.run({ model: selectedModel, input: { prompt: "Describe this image." } }, apiKey);
await cail.run({ model: selectedModel, input: { prompt: "Describe this image." } }, {
  kind: "jwt",
  token: identityJwt,
});
```

Key credentials send `Authorization: Bearer …`; JWT credentials send only
`X-CAIL-Identity-JWT`. Authenticated calls include `X-CAIL-App`; CAIL
authentication headers are authoritative, and ambient `Authorization`,
`Proxy-Authorization`, and `Cookie` headers are stripped. The client uses
`credentials: "omit"`, rejects redirects, and makes one fetch attempt. Other
caller headers, including provider-specific and OpenAI extension headers, pass
through unchanged. Successful `Response` objects are returned by reference.

## OpenAI-compatible chat

`chatCompletions()` posts the supplied JSON object to
`/v1/chat/completions`. Unknown provider fields pass through unchanged, and a
streaming response remains a live Web `Response`. The TypeScript request type
models this JSON boundary without imposing a provider schema.

Pass one stable identifier for each continuing conversation so the Gateway can
keep provider-side session affinity without exposing that identifier upstream:

```ts
const response = await cail.chatCompletions(
  { model: selectedModel, messages },
  apiKey,
  { sessionId: conversationId },
);
```

Use the same value for every turn in one conversation and a different value for
an independent conversation. Omit it for stateless calls. The value must be
1–256 trimmed characters without controls. It is routing context, not a user id
or credential; the Gateway combines it with the verified principal and hashes
it before provider egress. It is a routing hint, not a keep-warm or latency
guarantee.

For an SDK that accepts a custom fetch function, use `chatFetch()`:

```ts
const fetchChat = cail.chatFetch(
  { kind: "key", token: apiKey },
  { sessionId: conversationId },
);
const response = await fetchChat(`${CAIL_GATEWAY_OPENAI_BASE_URL}/chat/completions`, {
  method: "POST",
  body: JSON.stringify({ model: selectedModel, messages }),
});
```

The adapter serves only that configured POST endpoint. It never retries. By
default it throws a `CailError` for Gateway-declared non-retryable responses
and quota exhaustion; `nonRetryableErrorMode: "return"` leaves those responses
for an SDK that understands `X-Should-Retry: false`.

## CAIL extensions

`call(path, init, credential, options)` sends a request to a relative path
within the configured Gateway base URL. Use it for Gateway endpoints that need
a body such as `FormData`; the client preserves that body and applies the same
credential, redirect, and cancellation handling as the named methods. Let fetch
set the multipart content type and boundary when sending `FormData`.

`run()` sends `{ model, input }` to `POST /v1/run` and returns the raw response.
`getCatalog()` sends credential-free `GET /v1/catalog`; its optional modality
is `text`, `image`, or `all`. `getCatalogSnapshot()` validates the enriched
catalog. `getQuota()` sends authenticated `GET /v1/quota` and validates the
Cloudflare-managed estimate (`microdollar` values, percentages, window
metadata, and calculation time).

Version 6.2 accepts the Gateway's `bedrock-mantle` provider alongside
`workers-ai` and `openrouter`. Update catalog consumers before enabling Mantle
in Gateway; earlier clients reject a catalog containing that provider.
Version 6.2.1 preserves CR/LF line breaks in catalog descriptions, matching the
Gateway's public metadata. Other control characters remain invalid, and model
identifiers and other text fields still reject line breaks.

```ts
const catalog = await cail.getCatalogSnapshot({ modality: "all" });
const quota = await cail.getQuota(apiKey);
```

## Errors

Non-success Gateway responses become `CailError` values with `code`, `type`,
`param`, `status`, and scalar `extras`. Known request/retry fields are typed,
and other scalar CAIL fields remain available through the same scalar value
contract. A valid CAIL envelope keeps its message. Malformed or non-JSON
bodies produce a generic safe message; raw bodies, tokens, and transport
causes are not copied into the message or JSON representation.

```ts
import { CailError, extractCailError } from "@cuny-ai-lab/cail-client";

try {
  await cail.getQuota(apiKey);
} catch (error) {
  if (error instanceof CailError) console.error(error.code, error.message);
}

const typed = extractCailError(alreadyConsumedSdkError);
```

## Development and publication

Use Bun:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`bun run check` formats tracked sources, typechecks, runs tests, builds the
package into the ignored `dist/` directory, and packs `.release/package.tgz`.
It installs that tarball into a temporary consumer with lifecycle scripts disabled
and exercises the public client and testing exports against a local HTTP server
using Node (Node 20 in CI).
It also runs the vendored generic [anti-slop profile](tools/oxlint/anti-slop/)
from `tools/oxlint/anti-slop/`; its upstream commit and license are recorded
there. Findings are fixed at their actual contract or runtime boundary. The
publish workflow runs the same check and publishes that tested tarball to GitHub
Packages.

## License

MIT. See [LICENSE](LICENSE).
