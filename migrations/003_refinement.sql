CREATE TABLE refinement_batches (
 id text PRIMARY KEY, status text NOT NULL DEFAULT 'queued', operations jsonb NOT NULL,
 document_ids jsonb NOT NULL, targets jsonb NOT NULL DEFAULT '[]',
 include_user_fields boolean NOT NULL DEFAULT false, include_user_titles boolean NOT NULL DEFAULT false,
 total integer NOT NULL, processed integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
 unchanged integer NOT NULL DEFAULT 0, budget_cny double precision NOT NULL,
 reserved_cny double precision NOT NULL DEFAULT 0, estimated_cost_cny double precision NOT NULL DEFAULT 0,
 input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
 errors jsonb NOT NULL DEFAULT '[]', warnings jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE refinement_proposals (
 id text PRIMARY KEY, batch_id text NOT NULL REFERENCES refinement_batches(id),
 document_id text NOT NULL REFERENCES documents(id), version_id text NOT NULL REFERENCES document_versions(id),
 field text NOT NULL, current_value jsonb NOT NULL, proposed_value jsonb NOT NULL, accepted_value jsonb,
 confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1), reasoning text NOT NULL DEFAULT '', evidence jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','stale')),
 locked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,document_id,field)
);
CREATE INDEX refinement_proposals_pending ON refinement_proposals(document_id,version_id) WHERE status='pending';
CREATE TABLE refinement_applies (
 id text PRIMARY KEY, batch_id text NOT NULL REFERENCES refinement_batches(id), document_id text NOT NULL REFERENCES documents(id),
 version_id text NOT NULL REFERENCES document_versions(id), before_value jsonb NOT NULL, after_value jsonb NOT NULL,
 example_ids jsonb NOT NULL DEFAULT '[]', applied_at timestamptz NOT NULL DEFAULT now(), rolled_back_at timestamptz
);
CREATE TABLE knowledge_groups (
 id text PRIMARY KEY, name text NOT NULL UNIQUE, description text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'user',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_group_documents (
 group_id text NOT NULL REFERENCES knowledge_groups(id) ON DELETE CASCADE,
 document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(group_id,document_id)
);
CREATE INDEX knowledge_group_documents_document ON knowledge_group_documents(document_id);
CREATE TABLE entity_alias_groups (
 id text PRIMARY KEY, canonical text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE entity_aliases (
 group_id text NOT NULL REFERENCES entity_alias_groups(id) ON DELETE CASCADE,
 alias text NOT NULL UNIQUE, PRIMARY KEY(group_id,alias)
);
CREATE TABLE corpus_analyses (
 id text PRIMARY KEY, status text NOT NULL DEFAULT 'queued', document_ids jsonb NOT NULL,
 total integer NOT NULL, processed integer NOT NULL DEFAULT 0, budget_cny double precision NOT NULL,
 reserved_cny double precision NOT NULL DEFAULT 0, estimated_cost_cny double precision NOT NULL DEFAULT 0,
 input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
 errors jsonb NOT NULL DEFAULT '[]', warnings jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE taxonomy_proposals (
 id text PRIMARY KEY, analysis_id text NOT NULL REFERENCES corpus_analyses(id), kind text NOT NULL,
 name text NOT NULL, description text NOT NULL DEFAULT '', document_ids jsonb NOT NULL,
 canonical text, aliases jsonb NOT NULL DEFAULT '[]', confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 evidence jsonb NOT NULL DEFAULT '[]', version_ids jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','stale')),
 applied_value jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
