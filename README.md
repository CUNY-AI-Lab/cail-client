# @cuny-ai-lab/cail-client

Small Web-standard helpers for the CAIL Gateway's CAIL-native extensions. The
package owns bounded CAIL error extraction, the public model catalog, the
authenticated quota snapshot, and the buffered `POST /v1/run` extension. It
does not implement an OpenAI-compatible model client. Use the official OpenAI
or AI SDK client for ordinary model requests.

## Install

The package is published to GitHub Packages. Keep the registry token outside
the repository and pin a release in the consuming application:

```ini
@cuny-ai-lab:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_CONFIG_TOKEN}
```

```sh
bun add @cuny-ai-lab/cail-client
```

## Client

```ts
import { createCailClient } from "@cuny-ai-lab/cail-client";

const cail = createCailClient({
  baseUrl: CAIL_API_BASE,
  app: "alt-text",
});
```

`baseUrl` must be an absolute HTTPS URL without credentials, a query, or a
fragment. Local HTTP is available only for `localhost`, `127.0.0.1`, or `[::1]`
when `allowInsecureLoopback: true` is set. The app value is a lowercase slug.

Every request uses one `Authorization: Bearer <token>` value, whether the
token is a CAIL API key or a trusted Doorway identity JWT. Requests use
`credentials: "omit"` and `redirect: "error"`; successful responses are
returned by reference. Tokens and response bodies are never copied into
client-generated errors.

### CAIL-native run

`run()` is the small buffered CAIL extension. The current Gateway accepts a
JSON object with exactly `model` and `input`; the input must be a JSON object.
The method sends one `POST /v1/run` attempt and returns the raw successful
`Response`.

```ts
const response = await cail.run(
  { model: selectedModel, input: { prompt: "Describe this image." } },
  identityJwt,
);
const result = await response.json();
```

For ordinary OpenAI-compatible requests, use an official client directly:

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: `${CAIL_API_BASE}/v1`,
  apiKey: cailToken,
  maxRetries: 0,
});
```

The same `baseURL`, bearer token, and `maxRetries: 0` settings apply to other
official OpenAI-compatible or AI SDK clients.

### Catalog and quota

`getCatalog()` sends a credential-free `GET /v1/catalog`; its optional
`modality` is `text`, `image`, or `all`. `getCatalogSnapshot()` consumes at
most 8 MiB and validates the enriched CAIL catalog before returning plain
data.

```ts
const catalog = await cail.getCatalogSnapshot({ modality: "all" });
const quota = await cail.getQuota(cailToken);
```

`getQuota()` sends an authenticated `GET /quota` and validates the canonical
subject, units, safe integer fields, window, state, and remaining relationship.
Malformed successful bodies fail closed as `CailError` with
`code: "unknown_error"`.

## Errors

Non-success Gateway responses become `CailError` values with `code`, `type`,
`param`, `status`, and bounded `extras`. A valid CAIL envelope preserves its
message verbatim. Non-JSON, oversized, and malformed bodies produce a generic
safe message instead of echoing raw body text.

```ts
import { CailError, extractCailError, parseCailError } from "@cuny-ai-lab/cail-client";

try {
  await cail.getQuota(cailToken);
} catch (error) {
  if (error instanceof CailError) console.error(error.code, error.message);
}

// For an already-consumed SDK error object:
const typed = extractCailError(errorValue);
```

`parseCailError(response)` handles a live `Response`; `extractCailError(value)`
walks bounded, already-buffered wrapper layers such as `cause`, `error`,
`responseBody`, `data`, `lastError`, and `errors[]` without invoking getters.

## Testing fixtures

The optional `@cuny-ai-lab/cail-client/testing` subpath contains pure fixtures
for CAIL envelopes and quota snapshots. It has no test-framework dependency.

## Development and publication

Use Bun:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun pm pack --dry-run --ignore-scripts
```

The check gate formats tracked text, typechecks, runs focused tests, rebuilds
and compares `dist/`, and verifies packed contents. Publication runs only from
a clean checkout through a version-matching `v<version>` Git tag. It never
publishes a dirty or unverified build.

## License

MIT. See [LICENSE](LICENSE).
