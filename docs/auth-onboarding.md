# Email registration and family enrollment

The approved workflow separates accounts from family access. Parents and teachers can register before they have a family. Students still need a valid family invitation and guardian consent. Clerk authenticates email accounts; Nova assigns local roles and authorizes every family, assessment and report operation.

## Design decision

Use Clerk session verification at the existing server identity boundary, then map the verified issuer and subject to a Nova UUID. Do not exchange a Clerk login for an independently valid 12-hour Nova cookie. The latter creates a second revocation lifecycle and can leave a valid Nova session after Clerk sign-out. Local authentication remains the default configuration; the dedicated Clerk development environment has been verified separately, without changing production configuration. A failed Clerk request never falls back to local authentication.

The local `Actor` remains `{ id, name, role, region }`. A verified identity without a local profile is a separate onboarding state. Self-registration cannot select `admin` or `staff`. An existing role is not changed by selecting a different entry or changing provider metadata. Unmapped students obtain a local profile only inside an authorized family enrollment transaction.

Family membership does not own the account lifecycle. Deleting a family removes its records and membership; it must not delete an independently registered adult or terminate sessions that still access other families.

## Implementation contract

| Route | Contract |
| --- | --- |
| `GET /api/session` | Existing response plus `authProvider` and `identityState: signed_out / email_unverified / profile_required / ready`. GET never creates a profile. |
| `POST /api/auth/register` | Local mode, `{name, role:parent\|teacher, username, password}`; creates an independent account and local session. |
| `POST /api/auth/profile` | Clerk session and verified email, `{name, role:parent\|teacher}`; idempotently creates/returns a Nova profile. |
| `POST /api/auth/link-legacy` | Verified Clerk email plus valid old `{username,password}`; links to the original Nova UUID. No matching by display name or email alone. |
| `POST /api/triad/family` | Authenticated parent, `{requestId,relationship,childName,birthDate,grade,accepted:true}`; creates family, consent and parent assessment. The request ID prevents duplicate creation on retry. |
| `POST /api/triad/join` | Existing teacher/student `{code}` reuses the authenticated UUID. A new Clerk student supplies `{code,name,role:student}` and is created only after the invitation/consent checks. Existing local student onboarding remains available. |
| `POST /api/invite` | Existing actor supplies `{token}`. A verified Clerk identity without a profile supplies `{token,name}` and the server invitation determines its role. Same-user repeat acceptance returns the existing relationship. |
| `POST /api/auth/logout` | Ends the configured authentication session after the existing draft-save workflow succeeds. |

The shared family-code parser accepts the documented eight-character body and normalizes permitted case/separators. Invalid format, missing/expired code, occupied role and taken username have distinct stable errors. An optional field name allows inline feedback without exposing submitted values or provider/database details.

## Ownership and sequence

1. Read the relevant pstack principles and existing identity/enrollment paths. Completed before implementation. The prior investigation and user approval provide the product design; no repeat design approval is needed.
2. Compare direct Clerk verification with a local-session exchange. Two independent reviews select direct verification, while retaining short-token revocation limits as a verification item.
3. Preserve the initial uncommitted working files under `work/qa/email-registration-20261009/baseline`.
4. Authentication owner implements the provider adapter, local identity mapping, schema and authentication tests. Enrollment owner implements code validation, family creation/join, invitations and account preservation. UI owner implements email authentication, onboarding and multi-family entry. Root owns dependency installation, route composition, HTTP errors, layout/proxy wiring and real runtime verification.
5. Each owner writes regression coverage for the relevant security or lifecycle behavior before declaring the implementation ready. Shared files have one owner; cross-file contracts above are fixed before edits.
6. Run the relevant tests, full test suite, typecheck, isolated build and configured integration checks. Review the real desktop/mobile browser flows and protected document access. Report any unrelated pre-existing integration failure separately.
7. Verify Clerk using a development instance with synthetic accounts. Test addresses and the official test code establish provider-flow behavior, not actual email delivery. Real mailbox delivery uses an explicitly supplied test mailbox.
8. No commits, pushes or deployment are part of this implementation. PR/shipping steps of the generic playbook are skipped for that scope reason.

Throughput checkpoint: provider access blocks live Clerk verification only; identity, enrollment and UI implementation proceed independently. SQL schema, API composition and frontend files each have one owner. Root verifies the combined behavior instead of treating agent summaries or mocked SQL as acceptance.

## Acceptance evidence

- Teacher can register before receiving a family code and remains the same Nova UUID after reload/sign-in.
- Same teacher can join two authorized families; repeated submission does not duplicate users, memberships, tasks or rounds.
- Invalid code is identified beside its field; an unknown code and a different teacher occupying the family are distinguishable without revealing private family data.
- A student cannot create a Nova student profile without a valid invitation and current guardian consent.
- Client role, identity and region spoofing cannot grant staff/admin, another family, or parent-report access.
- A disabled account is refused in both modes; legacy password login cannot bypass Clerk mode.
- Existing accounts require old credential proof for identity linking, and preserve original family/report ownership.
- Logout preserves draft-save behavior and terminates the configured session. External token revocation latency is measured or explicitly bounded, not described as instantaneous without evidence.
- Removing one or the last family does not remove the independently registered teacher account.
- Clerk registration and email verification, incorrect/correct recovery codes, repeat sign-in and password recovery are checked against the real development provider. Real email delivery and mainland/Hong Kong mobile network tests remain separately identified evidence.

## Provider constraints

Clerk's current free plan includes email authentication, but production SMS and MFA are not included. Its identity data is US-hosted without regional residency selection. This implementation does not change the project's data-region commitments or authorize production migration. Family details, child names, answers, reports and care records stay in Nova and are not written to Clerk metadata.

Sources checked on 2026-10-09: [pricing](https://clerk.com/pricing), [security](https://clerk.com/security), [Next.js integration](https://clerk.com/docs/nextjs/getting-started/quickstart), [test emails](https://clerk.com/docs/guides/development/testing/test-emails-and-phones), [migration](https://clerk.com/docs/guides/development/migrating/overview).

## Development setup and current verification boundary

Configure a Clerk **development** instance with email required, email verification enabled, and email code or password sign-in enabled. Keep other identity fields optional/off for this pilot; Chinese display names are entered into Nova after authentication. Use the embedded `/sign-up` and `/sign-in` pages, including Clerk's password-recovery flow.

Store `NOVA_AUTH_PROVIDER=clerk`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` in the local test environment's private file. Never commit or print the values. The optional `NOVA_CLERK_ISSUER` should be omitted unless explicitly set to the exact origin encoded by the publishable key. The configured `NOVA_PUBLIC_URL` is the allowed frontend origin. Apply `scripts/setup.ts` only to the designated synthetic test database before switching modes.

The default `local` configuration remains usable with no Clerk keys. In Clerk mode, local password login, public demo login and local password recovery cannot be used as fallback. Existing local accounts can explicitly link after proving both verified Clerk email control and the old password. New profiles are not public one-click demo accounts, even in a demo-classified database.

2026-10-09 implementation checks: 847 tests passed, TypeScript and an isolated optimized build passed, 12 real HTTP/database onboarding scenarios passed, and 29 dual-region integration scenarios passed. Thirteen additional SQL-only Clerk identity/enrollment checks used synthetic pre-verified principals with HTTP disabled. The standalone production artifact also served its page/assets and completed local teacher registration and an authenticated empty workspace. Browser review covered an empty teacher account, inline bilingual errors, two family questionnaires under one account, and a 390px viewport. Generated bilingual PDF pages were sampled for legibility; this was not a new content or clinical validation.

A dedicated Nova development instance is now configured with required verified email, email-code sign-in and password authentication. Its embedded registration form loads successfully at the local test origin. Development credentials are stored only in a mode-0600 ignored private file. The owner completed real-mailbox registration and email verification. A read-only provider check confirms one verified primary email with password authentication, and Nova created a single teacher UUID without family membership. The real browser then joined two synthetic families, repeated one join without duplicates, preserved the two tasks after refresh, and logged out. SQL confirms one identity mapping, two memberships and two assessments; both Nova local revocation and the provider revoked session were confirmed. Password recovery sent a real code and rejected an incorrect code. The owner then completed the new-password step, signed out and signed in with the new password. The provider reported a new sign-in; the browser, including a subsequent refresh, returned to the same teacher workspace. SQL confirmed the original UUID, two memberships and two assessments were preserved. No production credentials, deployment or user migration were used. Detailed local receipts are in `work/qa/email-registration-20261009/`; the successful broad integration receipt is `work/qa/integration-2026-10-09T07-27-27-498Z-eb7d665d/api-integration-results.json`.

Local Clerk testing uses `next dev --hostname localhost` and a matching `NOVA_PUBLIC_URL=http://localhost:3222`. With this installed Next.js version, a `127.0.0.1` server hostname combined with Clerk middleware can create a self-rewrite proxy loop because Next normalizes the request URL to `localhost`. This is a test-launcher origin setting; no SDK rewrite override is used. The proxy passes the public key and allowed origin dynamically while the SDK reads the secret from its server environment.

The shared locale context now gives Clerk and the Nova shell the same initial language. A new HK browser origin starts in traditional Chinese, while an explicit saved preference takes priority; two first-render regressions cover both languages.

The final optimized build and standalone smoke passed after the locale change, using the local authentication mode. Next-generated test paths were restored and typecheck passed again. Temporary task-owned web and database services were stopped; fixtures and private development configuration remain under `work/qa/email-registration-20261009/`. The consolidated [acceptance record](../work/qa/email-registration-20261009/acceptance.md) distinguishes live development-provider evidence from synthetic SQL checks and untested production/mobile-network concerns.
