ALTER TABLE project_assets ALTER COLUMN input_id DROP NOT NULL;
ALTER TABLE project_assets DROP CONSTRAINT project_assets_input_id_fkey;
ALTER TABLE project_assets ADD CONSTRAINT project_assets_input_id_fkey FOREIGN KEY (input_id) REFERENCES project_inputs(id) ON DELETE SET NULL;
ALTER TABLE project_assets ADD COLUMN retired_at timestamptz;
CREATE INDEX project_assets_active ON project_assets(project_id) WHERE retired_at IS NULL;
