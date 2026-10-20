BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('nova-schema-20261020-consent-workspace'));

-- Preserve existing grant rows. Invalid or duplicate grants abort the migration
-- instead of silently withdrawing consent to make a new constraint pass.
DO $$
BEGIN
  IF (SELECT count(*) FROM deployment_settings) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM deployment_settings
       WHERE region IN ('CN','HK') AND mode IN ('demo','service')
     ) THEN
    RAISE EXCEPTION 'Expected one classified Nova regional database';
  END IF;
  IF EXISTS (
    SELECT 1 FROM consents
    WHERE jsonb_typeof(scopes) <> 'array'
       OR CASE WHEN jsonb_typeof(scopes) = 'array' THEN jsonb_array_length(scopes) < 1 ELSE true END
  ) THEN
    RAISE EXCEPTION 'Review invalid consent scopes before migrating';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS consent_scope_revocations(
  id uuid PRIMARY KEY,
  consent_id uuid NOT NULL REFERENCES consents(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK(scope IN ('assessment','parent_report','sensitive_data','ai_processing')),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  guardian_name text NOT NULL,
  method text NOT NULL CHECK(method IN ('online_guardian','offline_signed','synthetic')),
  reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(consent_id, scope)
);
CREATE INDEX IF NOT EXISTS consent_scope_revocations_family ON consent_scope_revocations(family_id,scope);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='consents'::regclass AND conname='consents_scopes_nonempty'
  ) THEN
    ALTER TABLE consents ADD CONSTRAINT consents_scopes_nonempty
      CHECK(jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes)>=1);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_consent_scope
  ON consents(family_id,(scopes #>> '{0}'))
  WHERE revoked_at IS NULL AND jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes)=1;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_legacy_consent_bundle
  ON consents(family_id)
  WHERE revoked_at IS NULL AND jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes)>1;
DROP INDEX IF EXISTS one_active_family_consent;

ALTER TABLE content_versions ADD COLUMN IF NOT EXISTS library_key text;
ALTER TABLE content_versions ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'staff';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='content_versions'::regclass AND conname='content_versions_origin_check'
  ) THEN
    ALTER TABLE content_versions ADD CONSTRAINT content_versions_origin_check CHECK(origin IN ('seed','staff'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS content_versions_general_version
  ON content_versions(kind,version) WHERE library_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS content_versions_library_version
  ON content_versions(kind,library_key,version) WHERE library_key IS NOT NULL;
ALTER TABLE content_versions DROP CONSTRAINT IF EXISTS content_versions_kind_version_key;

ALTER TABLE staff_alerts ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE staff_alerts ADD COLUMN IF NOT EXISTS resolved_by uuid;
DO $$ DECLARE old_name text;
BEGIN
  SELECT conname INTO old_name FROM pg_constraint
  WHERE conrelid='report_jobs'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%ready%'
    AND pg_get_constraintdef(oid) NOT LIKE '%paused%'
  LIMIT 1;
  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE report_jobs DROP CONSTRAINT %I',old_name);
    ALTER TABLE report_jobs ADD CONSTRAINT report_jobs_state_check
      CHECK(state IN ('ready','running','done','failed','paused'));
  END IF;
END $$;
COMMIT;
