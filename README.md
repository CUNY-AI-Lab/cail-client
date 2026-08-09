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
import { createCailClient } from "@cuny-ai-lab/cail-client";

const cail = createCailClient({
  baseUrl: CAIL_API_BASE,
  app: "alt-text",
});
```

`baseUrl` is an absolute HTTPS URL without credentials, a query, or a
fragment. Local HTTP is available only for `localhost`, `127.0.0.1`, or
`[::1]` with `allowInsecureLoopback: true`. The app is a lowercase slug.

Credentials can be passed as a key string shorthand or an explicit kind:

```ts
await cail.run({ model: selectedModel, input: { prompt: "Describe this image." } }, apiKey);
await cail.run({ model: selectedModel, input: { prompt: "Describe this image." } }, {
  kind: "jwt",
  token: identityJwt,
});
```

Key credentials send `Authorization: Bearer …`; JWT credentials send only
`X-CAIL-Identity-JWT`. Authenticated calls include `X-CAIL-App`, strip caller
authorization headers, use `credentials: "omit"`, reject redirects, and make
one fetch attempt. Successful `Response` objects are returned by reference.

## OpenAI-compatible chat

`chatCompletions()` posts the supplied JSON object to
`/v1/chat/completions`. Unknown provider fields pass through unchanged, and a
streaming response remains a live Web `Response`.

For an SDK that accepts a custom fetch function, use `chatFetch()`:

```ts
const fetchChat = cail.chatFetch({ kind: "key", token: apiKey });
const response = await fetchChat(`${CAIL_API_BASE}/v1/chat/completions`, {
  method: "POST",
  body: JSON.stringify({ model: selectedModel, messages }),
});
```

The adapter serves only that configured POST endpoint. It never retries. By
default it throws a `CailError` for Gateway-declared non-retryable responses
and quota exhaustion; `nonRetryableErrorMode: "return"` leaves those responses
for an SDK that understands `X-Should-Retry: false`.

## CAIL extensions

`run()` sends `{ model, input }` to `POST /v1/run` and returns the raw response.
`getCatalog()` sends credential-free `GET /v1/catalog`; its optional modality
is `text`, `image`, or `all`. `getCatalogSnapshot()` validates the enriched
catalog. `getQuota()` sends authenticated `GET /quota` and validates the
Cloudflare-managed estimate (`microdollar` values, percentages, window
metadata, and calculation time).

```ts
const catalog = await cail.getCatalogSnapshot({ modality: "all" });
const quota = await cail.getQuota(apiKey);
```

## Errors

Non-success Gateway responses become `CailError` values with `code`, `type`,
`param`, `status`, and scalar `extras`. A valid CAIL envelope keeps its
message. Malformed or non-JSON bodies produce a generic safe message; raw
bodies, tokens, and transport causes are not copied into the message or JSON
representation.

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
bun pm pack --dry-run --ignore-scripts
```

`bun run check` formats tracked sources, typechecks, runs tests, builds the
package into the ignored `dist/` directory, and checks the package contents.
The publish workflow runs the same check and publishes the resulting tarball
to GitHub Packages.

## License

MIT. See [LICENSE](LICENSE).
