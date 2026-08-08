# cail-client

- Owns Web-standard Gateway transport helpers and the current CAIL-native wire shapes exported from `src/index.ts`.
- The public surface covers bounded CAIL error parsing, model-catalog validation, Cloudflare quota estimates, and the buffered `POST /v1/run` extension.
- Validate URLs, app slugs, bearer inputs, bounded JSON, and response envelopes before returning data; make one request attempt.
- Keep `credentials: "omit"`, redirect rejection, and token/body redaction in the transport path.
- Catalog and quota results are snapshots or estimates; Gateway, provider, and accounting systems remain authoritative.
- Callers supply already-authorized credentials and choose official clients for OpenAI-compatible model requests.
- Do not verify or mint identity, authorize callers, route providers, enforce quotas, implement an OpenAI-compatible client, or add silent retry/fallback.
- Keep parsers strict and bounded so malformed or undeclared Gateway responses become safe `CailError` values.

Check with `bun run check`.
