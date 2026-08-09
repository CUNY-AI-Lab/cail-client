# cail-client

- Owns the Web-standard CAIL Gateway transport and the current CAIL-native wire shapes exported from `src/index.ts`.
- The public surface covers key/JWT credential headers, OpenAI-compatible chat (`chatCompletions` and `chatFetch`), `run`, the model catalog, the Cloudflare quota estimate, and safe CAIL errors.
- Key credentials use `Authorization: Bearer`; JWT credentials use `X-CAIL-Identity-JWT`; authenticated calls include the configured `X-CAIL-App`.
- CAIL auth headers are authoritative: strip caller `Authorization`, `Proxy-Authorization`, CAIL authority, and `Cookie` headers at the transport boundary. Preserve unrelated provider/OpenAI extension headers unchanged.
- Preserve caller request bodies and successful streaming `Response` objects. Make one fetch attempt and reject redirects. Do not add provider schema validation, retries, fallback routing, identity minting, authorization, or quota enforcement.
- Errors may preserve a valid Gateway message and scalar CAIL extras, but never raw response bodies, credentials, or transport causes.
- Catalog and quota values are validated Gateway data. They do not claim provider or accounting authority.

Check with `bun run check`.
