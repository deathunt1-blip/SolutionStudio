ALTER TABLE documents ADD COLUMN IF NOT EXISTS canonical_title text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'filename';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS title_confidence double precision;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS title_reasoning text;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS parsed_title text;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS extractive_summary text NOT NULL DEFAULT '';
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS ai_summary text;
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS summary_source text NOT NULL DEFAULT 'extractive';
-- Preserve every existing display name. Existing parser names are repaired only
-- after the user accepts a refinement proposal, never by a startup side effect.
UPDATE documents d SET canonical_title=d.title,
 title_source=CASE WHEN d.title_user THEN 'user' WHEN d.title=v.filename THEN 'filename' ELSE 'parser' END,
 title_confidence=CASE WHEN d.title_user THEN 1 ELSE NULL END
 FROM document_versions v WHERE v.id=d.active_version_id AND d.canonical_title IS NULL;
UPDATE documents SET canonical_title=title WHERE canonical_title IS NULL;
ALTER TABLE documents ALTER COLUMN canonical_title SET NOT NULL;
ALTER TABLE documents ALTER COLUMN canonical_title SET DEFAULT '';
UPDATE document_versions SET parsed_title=parsed_document->>'title',extractive_summary=summary;
