# Feishu connector extension point (P0.5)

The runnable P0 only enables manual ingestion. `MockFeishuAdapter` is an explicit test fixture, not a live connection.

A future live adapter implements `KnowledgeSourceAdapter`. Require explicit folder allowlists and tenant credentials; never enumerate the whole organization. Map file token to `sourceId`, remote revision to `version`, path and modified time to metadata. Export native Docs/Sheets to a supported file format at the connector boundary. Ingestion remains unchanged.

The sync coordinator compares `(source, sourceDocumentId, version, contentHash)`: ingest new, create a version on change, skip unchanged and mark removed items archived only after a successful complete listing. Preserve every original locally. Connector credentials belong in deployment secret storage. Remote deletion must never delete originals or history.
