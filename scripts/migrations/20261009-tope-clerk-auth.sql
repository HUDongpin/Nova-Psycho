-- Clerk authentication additions for the existing TopE production database.
-- HK/service prevents initializing or reclassifying another database by mistake.
-- No account data, sessions, questionnaire content or report payloads are changed.
-- Back up and verify the target first; run with an error-stopping client.

BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

DO $guard$
DECLARE total integer; matched integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(807001, 9) THEN
    RAISE EXCEPTION 'Another registration-schema migration is active';
  END IF;
  IF to_regclass('public.deployment_settings') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.families') IS NULL
     OR to_regclass('public.invitations') IS NULL THEN
    RAISE EXCEPTION 'Refusing an uninitialized or unrelated database';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE singleton AND region='HK' AND mode='service')
    INTO total, matched FROM public.deployment_settings;
  IF total <> 1 OR matched <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one HK/service deployment marker';
  END IF;
END $guard$;

ALTER TABLE public.users ALTER COLUMN username DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.external_identities (
  provider text NOT NULL CHECK (provider='clerk'),
  issuer text NOT NULL,
  subject text NOT NULL,
  region text NOT NULL CHECK (region IN ('CN','HK')),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider,issuer,subject,region),
  UNIQUE (user_id,provider)
);

CREATE TABLE IF NOT EXISTS public.clerk_session_revocations (
  issuer text NOT NULL,
  session_id_hash text NOT NULL,
  region text NOT NULL CHECK (region IN ('CN','HK')),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer,session_id_hash,region)
);

ALTER TABLE public.families ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id);
ALTER TABLE public.families ADD COLUMN IF NOT EXISTS creation_request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS family_creation_request
  ON public.families(created_by,creation_request_id)
  WHERE creation_request_id IS NOT NULL;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS accepted_by uuid REFERENCES public.users(id);

-- Fail inside the transaction if an earlier partial deployment used conflicting
-- field types, nullability or key shapes. No existing row is rewritten to fit.
DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('users','username','text','YES'),
      ('external_identities','provider','text','NO'),
      ('external_identities','issuer','text','NO'),
      ('external_identities','subject','text','NO'),
      ('external_identities','region','text','NO'),
      ('external_identities','user_id','uuid','NO'),
      ('external_identities','email_verified_at','timestamptz','NO'),
      ('external_identities','created_at','timestamptz','NO'),
      ('clerk_session_revocations','issuer','text','NO'),
      ('clerk_session_revocations','session_id_hash','text','NO'),
      ('clerk_session_revocations','region','text','NO'),
      ('clerk_session_revocations','revoked_at','timestamptz','NO'),
      ('families','created_by','uuid','YES'),
      ('families','creation_request_id','uuid','YES'),
      ('invitations','accepted_by','uuid','YES')
    ) AS expected(table_name,column_name,udt_name,is_nullable)
    LEFT JOIN information_schema.columns actual
      ON actual.table_schema='public'
      AND actual.table_name=expected.table_name AND actual.column_name=expected.column_name
    WHERE actual.udt_name IS DISTINCT FROM expected.udt_name
       OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
  ) THEN RAISE EXCEPTION 'Registration schema field mismatch'; END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('users','UNIQUE (username)'),
      ('external_identities','PRIMARY KEY (provider, issuer, subject, region)'),
      ('external_identities','UNIQUE (user_id, provider)'),
      ('external_identities','FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'),
      ('clerk_session_revocations','PRIMARY KEY (issuer, session_id_hash, region)'),
      ('families','FOREIGN KEY (created_by) REFERENCES users(id)'),
      ('invitations','FOREIGN KEY (accepted_by) REFERENCES users(id)')
    ) AS expected(table_name,definition)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_constraint actual
      WHERE actual.conrelid=to_regclass('public.' || expected.table_name)
        AND actual.convalidated
        AND pg_get_constraintdef(actual.oid)=expected.definition
    )
  ) THEN RAISE EXCEPTION 'Registration schema key mismatch'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid=to_regclass('public.family_creation_request')
      AND i.indrelid='public.families'::regclass AND i.indisunique AND i.indisvalid
      AND pg_get_indexdef(i.indexrelid,1,true)='created_by'
      AND pg_get_indexdef(i.indexrelid,2,true)='creation_request_id'
      AND i.indnkeyatts=2
      AND pg_get_expr(i.indpred,i.indrelid)='(creation_request_id IS NOT NULL)'
  ) THEN RAISE EXCEPTION 'Family request index mismatch'; END IF;
END $verify$;

COMMIT;
