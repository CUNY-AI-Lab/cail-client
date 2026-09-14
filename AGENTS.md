# cail-client

## Recommended CAIL fleet practice

For the colleague-facing engineering and agent-review defaults, see the [CAIL Fleet Engineering and Review Practice](https://github.com/CUNY-AI-Lab/cail-knowledge-base/pull/27). This is recommended unless this repository's own contract or CI makes a rule mandatory. Use Luna workers for bounded independent tasks and Astra for an independent review of substantial or load-bearing changes; keep one primary owner responsible for the combined result and real-path verification.

- Owns the Web-standard CAIL Gateway transport and the current CAIL-native wire shapes exported from `src/index.ts`.
- The public surface covers key/JWT credential headers, OpenAI-compatible chat (`chatCompletions` and `chatFetch`), `run`, the model catalog, the Cloudflare quota estimate, and safe CAIL errors.
- Key credentials use `Authorization: Bearer`; JWT credentials use `X-CAIL-Identity-JWT`; authenticated calls include the configured `X-CAIL-App`.
- CAIL auth headers are authoritative: strip caller `Authorization`, `Proxy-Authorization`, CAIL authority, and `Cookie` headers at the transport boundary. Preserve unrelated provider/OpenAI extension headers unchanged.
- Preserve caller request bodies and successful streaming `Response` objects. Make one fetch attempt and reject redirects. Do not add provider schema validation, retries, fallback routing, identity minting, authorization, or quota enforcement.
- Errors may preserve a valid Gateway message and scalar CAIL extras, but never raw response bodies, credentials, or transport causes.
- Catalog and quota values are validated Gateway data. They do not claim provider or accounting authority.
- `bun run check` starts with the vendored generic anti-slop profile in
  `tools/oxlint/anti-slop/`. Fix findings at the actual contract or boundary;
  do not add rule suppressions, evasive wrappers, or generic safety comments.
  The profile source and license are recorded in `tools/oxlint/anti-slop/`.
- This package does not depend on Effect, so the profile's Effect-specific
  rules remain disabled.

Check with `bun run check`.
