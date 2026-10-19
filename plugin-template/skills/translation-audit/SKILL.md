---
name: translation-audit
# Limit scope to the collector, no write unless explicitly authorized elsewhere.
description: Use after translating or polishing a Notion-backed novel chapter when current machine evidence, coverage and origin attestation must be verified by an external read-only collector.
---

# Translation Audit

- Read the current `เกลา`/`แปล` Command Owner and Light Novel Translation Core from Notion before the chapter workflow. Those owners remain authoritative for literary fidelity, coverage, Canon and Reveal.
- Call the remote MCP tool `verify_chapter` with only a scope key from the allowlisted novel/chapter registry. Do not provide Source/Target text in tool arguments or pretend the model supplied proof of origin.
- Report separate `status` (PASS, FAIL, UNVERIFIED), `origin_status`, exact `findings`, Source/Target revision and a signed attestation only if present. Never change `UNVERIFIED` into `PASS`, never equate a clean structural result with literary quality, and never claim a separate reviewer.
- If no remote tool is connected, the hosting credentials are missing, the source is stale or receipt canonicalization differs, explain the exact blocker and retain UNVERIFIED. Do not modify any novel prose to improve the machine verdict.
- Save evidence to the existing per-invocation Operation Log only through the authorized Notion writer workflow and verify Notion read-back. This collector itself is read-only and must not modify the Chapter/Target/Knowledge.
