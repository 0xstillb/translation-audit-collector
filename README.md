# Translation Audit Collector — MVP 0.1.0 (read-only)

For ChatGPT Web + Notion + Google Drive. This package is an **undeployed development candidate**, not the active Translation Skills Live Audit v0.4.2. It does not change any novel Target, Canon, Operation Log or central owner and never publishes a new Epoch by itself.

## What it does

A small Node 22 HTTP service exposes an MCP **Streamable HTTP** endpoint `POST /mcp` with one tool:

- `verify_chapter({scope: "spirit-c0001"})`: loads exactly the preconfigured Notion Chapter/Source Registry/Target/Operation page IDs and Drive file ID using the **server's own read-only service credentials**, checks current page bindings, current TXT units, current Source/Target revision, and the versioned P1–P8 JSON Operation receipt. Returns `PASS`, `FAIL`, or `UNVERIFIED` with issues. No raw source or target text is accepted from the language model as input.

The service also supports `GET /healthz` without exposing data or secrets. All `/mcp` calls require a configured bearer token. It can issue an HMAC-signed evidence receipt, which protects against subsequent tampering **only when the signing key remains secret and the service itself is trusted**. An HMAC from a self-hosted server is not cryptographic attestation from Notion or Google, nor a guarantee against compromise of the Render deployment. Pin the collector's source version and HTTPS endpoint as your operational trust root and evaluate a live Chapter pilot before treating any `PASS` as production-certified.

**The current active Notion/Core Live Audit v0.4.2 is untouched and still reports `UNVERIFIED` for untrusted caller-provided bundles.** No automatic machine status upgrade or historical rewriting is permitted.

## Tested locally

`npm test`: nine tests cover allowlisted scope, signed positive fixture, unsigned UNVERIFIED, coverage contradiction FAIL, stale Drive revision FAIL, Target normalization UNVERIFIED, source identity FAIL, provider failure UNVERIFIED, and MCP bearer authentication. These are **synthetic tests only**, not real Notion/Drive provenance proof or production certification.

## Deploy to Render

1. Push the content of this folder to a **private GitHub repository** accessible to your Render account. The root `render.yaml` is a Render Blueprint. Choose **New → Blueprint** in Render, connect that GitHub repository and set secret variables in the Render Dashboard. Do not paste credentials into ChatGPT or commit `.env` or account JSON to Git.
2. Create a Notion API integration with **read-only content access** and explicitly grant it access to the novel's relevant pages/databases (Chapter & Boundary, Source Registry, Target, Operation Log). Set `NOTION_TOKEN` in Render. Verify the integration's API capabilities and current Notion API version; page access in ChatGPT's Notion connector does **not** transfer its credentials to Render.
3. Create a dedicated Google Cloud **service account** with Drive API access, share only the source file `ch-0001.txt` (or a tightly scoped source folder) with its service account email as **Viewer**, and base64-encode the JSON key for `GOOGLE_SERVICE_ACCOUNT_JSON_B64`. Alternatively use a delegated Drive OAuth refresh token and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. A Google connection in ChatGPT **does not** give Render a Drive token automatically.
4. Generate **two distinct, strong secrets** for `MCP_BEARER_TOKEN` and `ATTESTATION_SIGNING_SECRET`. Keep them in Render Environment and never in the repository. On Render, set `AUDIT_SCOPE_JSON` to the exact JSON in `.env.example` for chapter 1; expand allowlisted scopes only from authenticated Notion project records after review.
5. Let Render deploy; check the published URL's `GET /healthz` shows `ok:true`. Check the private MCP endpoint by initializing and calling `tools/list` with the bearer header. Then test `verify_chapter({scope:"spirit-c0001"})` and inspect **all** returned findings. If Notion formatting differs from ChatGPT's enhanced-Markdown text, the conservative MVP returns `TARGET_CANONICALIZATION_MISMATCH` / `UNVERIFIED` until an audited canonicalization adapter is implemented and regression-tested; **do not just bypass that check**.
6. Only after actual server endpoint, auth and pilot are verified: copy `plugin-template/mcp.example.json` to `plugin-template/mcp.json`, replace the placeholder URL with the **real verified HTTPS Render URL + `/mcp`**, and remove `mcp.example.json` from the plugin distribution. ZIP the *contents* of `plugin-template/` with `plugin.json`, `mcp.json`, and `skills/translation-audit/SKILL.md` and create private plugin using Plugin Creator. Complete the API-key connection in ChatGPT's UI (it should use `MCP_BEARER_TOKEN`).
7. In ChatGPT Web invoke the plugin's `verify_chapter` tool via `@Translation Audit` or ask for machine verification after the `เกลา` process. Record the actual returned outcome in the original Notion Operation Log using the existing Notion writer, then fetch the log again as read-back. Do not start/modify any other novel during the smoke test.

## Current state and remaining gates

- ✅ Local source and 9/9 synthetic tests.
- ❌ Render hosting not deployed or witnessed from this chat; Render's connected app actions were not exposed as invokable tools in this session.
- ❌ External Notion API integration, Drive service-account OAuth setup, secrets and validated live origin provenance have **not** been configured/checked here.
- ❌ Private `Translation Audit` ChatGPT plugin has **not** been created: creating a remote plugin before a verified endpoint would yield a misleading, nonfunctional placeholder.
- ❌ Real chapter 1 `verify_chapter` has **not** been executed; **Machine Verified is not achieved**.

## Design constraints

Read-only; no user-supplied content in tool inputs; explicit per-chapter allowlist; bearer authentication; strict UTF-8; 15-second upstream timeouts; provider response ID validation; Notion pagination; Drive metadata and raw-content fetch; source-unit boundary checks; receipt/knowledge/lanes/evidence anchors; conservative representation mismatch; no changes to Production Live Audit v0.4.2 or Notion epoch.

### Important deployment and release caveat

The MVP implements the core MCP JSON-RPC 2.0 tool methods over HTTP. It should receive a complete external Streamable HTTP handshake/conformance test before deployment; no deployed ChatGPT plugin compatibility has been established. Its evidence signing uses a **server-held symmetric HMAC**, so it is *not* independent third-party attestation of the provider. For stronger production assurances, move attestation to an independently trusted verifier or KMS-backed asymmetric key and pin the verifier's public key. The host and secrets must be controlled outside the model.
