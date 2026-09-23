-- Soft retrieval metadata is deliberately independent from authority and product facts.
CREATE TABLE document_enrichments (
 document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 version_id text NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
 tags jsonb NOT NULL DEFAULT '{}', quality text NOT NULL DEFAULT 'normal' CHECK(quality IN ('normal','good','preferred')),
 model text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_sections (
 id text PRIMARY KEY, document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 version_id text NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE, section_order integer NOT NULL,
 title text NOT NULL, heading_path jsonb NOT NULL DEFAULT '[]', level integer NOT NULL,
 text text NOT NULL, summary text NOT NULL DEFAULT '', section_role text NOT NULL DEFAULT 'other',
 tags jsonb NOT NULL DEFAULT '{}', reusable boolean NOT NULL DEFAULT true,
 quality text NOT NULL DEFAULT 'normal' CHECK(quality IN ('normal','good','preferred')),
 blueprint jsonb NOT NULL DEFAULT '{}', search_vector tsvector,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(version_id,section_order)
);
CREATE INDEX knowledge_sections_current ON knowledge_sections(document_id,version_id,section_role);
CREATE INDEX knowledge_sections_fts ON knowledge_sections USING gin(search_vector);
CREATE TABLE knowledge_enrichment_batches (
 id text PRIMARY KEY, status text NOT NULL DEFAULT 'queued', total integer NOT NULL,
 budget_cny double precision, reserved_cny double precision NOT NULL DEFAULT 0,
 estimated_cost_cny double precision NOT NULL DEFAULT 0, input_tokens bigint NOT NULL DEFAULT 0,
 output_tokens bigint NOT NULL DEFAULT 0, model text NOT NULL DEFAULT 'kimi-k3',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_enrichment_items (
 id text PRIMARY KEY, batch_id text NOT NULL REFERENCES knowledge_enrichment_batches(id) ON DELETE CASCADE,
 document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 version_id text NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'queued', section_count integer NOT NULL DEFAULT 0,
 error text, input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
 reserved_cny double precision NOT NULL DEFAULT 0, estimated_cost_cny double precision NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,document_id)
);
CREATE UNIQUE INDEX knowledge_enrichment_pending ON knowledge_enrichment_items(document_id) WHERE status IN ('queued','running');
CREATE TABLE knowledge_tag_registry (
 dimension text NOT NULL, value text NOT NULL, label text NOT NULL,
 PRIMARY KEY(dimension,value)
);
CREATE TABLE knowledge_tag_aliases (
 dimension text NOT NULL, alias text NOT NULL, canonical text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(dimension,alias)
);
CREATE TABLE knowledge_alias_suggestions (
 id text PRIMARY KEY, dimension text NOT NULL, canonical text NOT NULL, aliases jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
 confidence double precision NOT NULL DEFAULT 0, reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
