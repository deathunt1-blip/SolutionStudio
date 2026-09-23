# Feishu read-only source adapter

`FeishuSourceAdapter` implements the provider-neutral `RemoteSourceAdapter` contract. It discovers an explicitly selected Wiki subtree or spreadsheet; documents leave this boundary as `SourceFile`, and sheets as structured rows with real row positions. Knowledge Core has no dependency on Feishu APIs.

Import the adapter and URL parser from `index.ts`. Credentials belong in the server-side secret store. Constructor transport overrides exist only for local Mock HTTP Server tests and must not come from source configuration. Real requests use the fixed official Open API host.

Use `SourceListing.complete` before removal detection. Use authoritative Docx revisions for fast unchanged checks; legacy native exports expose `meta.metadata.contentFingerprint` to ignore volatile ZIP metadata. `SourceFile.contentHash` always hashes original bytes. Preserve originals and history when a remote resource disappears.

See [setup and protocol references](../../../../docs/FEISHU_SETUP.md) and `tests/feishu-adapter.test.ts`.
