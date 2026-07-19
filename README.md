# `@cuny-ai-lab/cail-client`

A small Web-standard client for CAIL's OpenAI-compatible model endpoint. It
runs in Cloudflare Workers, browsers, Bun, and Node 20 or newer.

CAIL applications can supply either:

- a signed CAIL identity JWT; or
- a native LiteLLM virtual key created for a user.

The client recognizes an RS256 identity JWT, exchanges it at
`/cail/auth/exchange`, caches the resulting short-lived LiteLLM key, and sends
only that key to `/v1`. Opaque keys are sent directly. LiteLLM and PostgreSQL
remain the sole authority for keys, model access, spend, and budgets.

`X-CAIL-App` selects the JWT audience and provides low-cardinality application
attribution. It is not user identity. Responses remain untouched, including
standard OpenAI errors, SSE streams, usage, and cancellation.

## Model calls

```ts
import { createCailClient } from "@cuny-ai-lab/cail-client";

const cail = createCailClient({
  baseUrl: "https://models.ailab.gc.cuny.edu/v1",
  app: "agent-studio",
});

const response = await cail.chatCompletions(
  {
    model: "cail/default",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
  },
  identityJwtOrVirtualKey,
  { signal: request.signal },
);

return response;
```

Any endpoint beneath the configured `/v1` base is available:

```ts
await cail.request(
  "images/generations",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "cail/image",
      prompt: "A woodcut of the Graduate Center",
    }),
  },
  identityJwtOrVirtualKey,
);
```

OpenAI-compatible SDKs can use the fetch adapter:

```ts
const provider = createOpenAICompatible({
  name: "cail",
  baseURL: "https://models.ailab.gc.cuny.edu/v1",
  apiKey: "replaced-by-cail-client",
  fetch: cail.openAIFetch(identityJwtOrVirtualKey),
});
```

The adapter accepts URLs only at or below the configured `/v1` base, replaces
SDK-supplied authorization and application headers, never follows redirects,
and leaves request and response bodies unbuffered.

## Personal keys

An authenticated application can expose LiteLLM's native personal-key
lifecycle without receiving the LiteLLM master key:

```ts
const created = await cail.createPersonalKey(identityJwt, "My notebook");
const listed = await cail.listPersonalKeys(identityJwt);
const revoked = await cail.revokePersonalKey(identityJwt, keyId);
```

The create response contains the plaintext `sk-...` value once. Listing returns
only the key ID and metadata. A personal key can call allowed model routes but
cannot call LiteLLM administration APIs.

## Security boundary

The identity adapter verifies the signed CAIL JWT and derives the LiteLLM user
from its canonical `cail-<32 lowercase hex>` subject. It never accepts a
caller-supplied subject. Model requests are authenticated by LiteLLM's native
virtual-key mechanism, and spend follows the key owner even if a caller sends a
different OpenAI `user` field.

The client requires HTTPS. Plain HTTP can be enabled only for an exact loopback
host during local tests.
