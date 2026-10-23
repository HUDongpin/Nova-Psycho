# UI / API contract v1

The authoritative public handlers are in `src/app/api/[...path]/route.ts`; response types used by the client are in `src/components/api.ts`. This contract covers the individual-instrument and growth-triad workflows.

JSON mutations use `Content-Type: application/json` and an `Origin` exactly matching `NOVA_PUBLIC_URL`. Cookie sessions are HTTP-only. Errors are `{error: string, code: string, field?: string}`. Use `?locale=zh-CN` or `?locale=zh-HK` for text; locale does not change the server's `CN`/`HK` region or a user's role. Roles are `admin | staff | parent | student | teacher`.

## Session and account entry

GET `/api/session` returns:

```ts
{
  user: {id, name, role, region} | null,
  region, mode: "demo" | "service",
  authProvider: "local" | "clerk",
  identityState: "signed_out" | "email_unverified" | "profile_required" | "ready",
  demoAccounts: {id, name, role}[], siblingUrl: string | null,
  testAccountLoginEnabled: boolean, sessionMethod?: "test"
}
```

`demoAccounts` is populated only for local authentication in demo mode. A Clerk identity may still need verified email or an application profile; do not infer application access from the presence of a Clerk session alone.

| Method / endpoint | Input and result | Boundary |
|---|---|---|
| POST `/api/auth/demo` | `{accountId}` → `{ok:true}` and cookie | Enabled demo account in this region; unavailable in service mode or with Clerk |
| POST `/api/auth/login` | `{username,password}` → `{ok:true}` and cookie | Local authentication; username rate limit applies |
| POST `/api/auth/register` | `{name,role:'parent'\|'teacher',username,password}` → 201 `{user}` and cookie | Independent local account; does not create a family |
| POST `/api/auth/profile` | `{name,role:'parent'\|'teacher'}` → 201 `{user}` | Verified Clerk identity; creates the application profile |
| POST `/api/auth/link-legacy` | `{username,password}` → `{user}` | Links an eligible existing local account to a verified Clerk identity |
| POST `/api/auth/test-login` | `{username,password}` → `{ok:true}` and test cookie | Only explicitly configured test usernames with Clerk; not a demo-role bypass |
| POST `/api/auth/test-logout` | `{}` → `{ok:true}` | Ends the designated test session |
| POST `/api/auth/logout` | `{}` → `{ok:true}` | Ends the active application/authentication session |

Student entry requires a family invitation or a triad join code. The local independent registration endpoint does not accept the student role. Profile roles and regional membership are checked server-side.

## Growth-triad registration and joining

The bundled growth-triad questionnaires are available in service mode for non-clinical family understanding. The same admission policy applies to family registration/joining, assignment, draft saving, submission, workspace availability and report generation. It recognizes only the `growth-triad` bundle with an exact `id@version` from the application's `triadScales` registry, including its historical versions. An arbitrary bundle label, unknown instrument ID or unknown version does not grant this access.

This operational permission does not change the stored `demo` or `norm.validated` flags, establish clinical norms, or make the questionnaires diagnostic. Existing demo/non-clinical labels remain visible, and the three-party report uses deterministic templates. Unrelated demo or unvalidated instruments retain their service-mode restrictions. Synthetic-test identity and snapshot checks remain separate; ordinary participation does not acquire synthetic provenance.

Parent family input is:

```ts
{
  relationship: string, childName: string, birthDate: "YYYY-MM-DD", grade: string,
  assessment: true, sensitiveData: true, parentReport: boolean
}
```

`relationship` accepts only `母亲`, `父亲`, `祖父母或外祖父母`, or `其他主要照顾者`. `grade` accepts only `学前大班`, `小学一至三年级`, `小学四至六年级`, `初中`, `高中`, or `其他`. These are stable API values; traditional-Chinese labels such as `母親` are display text, not alternate enum values.

The first two purposes are required to participate. `parentReport` is an explicit independent choice; false permits answering but holds reporting. A bare `accepted:true` does not imply consent and is rejected. The server records purpose-specific rows with the current notice version, actor, time and evidence.

| Method / endpoint | Input and result |
|---|---|
| POST `/api/triad/parent` | Local signed-out compatibility entry. Parent family input plus `{parentName,username,password}` → 201 `{familyId,userId,joinCode}` and cookie. With Clerk, register/sign in first and use `/api/triad/family`. |
| POST `/api/triad/family` | Signed-in parent. Parent family input plus `{requestId:uuid}` → 201 `{userId,familyId,joinCode}`. An identical request replay returns the same family; changing family details gives 409 `REQUEST_ID_CONFLICT`, and changing consent choices gives 409 `CONSENT_CHOICE_CONFLICT`. |
| POST `/api/triad/join` | Signed-in student/teacher: `{code}`. New local participant: `{code,role:'student'\|'teacher',name,username,password}`. Verified Clerk student without a profile: `{code,name,role:'student'}`. A signed-in participant or Clerk student receives `{userId,familyId,assessmentId,alreadyMember}`: 201 for a new membership, or 200 with `alreadyMember:true` for an existing signed-in membership. A new local participant receives 201 `{userId}` and a cookie. |

Joining creates or reuses the task for that role and round. An existing account's identity/role cannot be reassigned through this endpoint. Role-specific tasks keep their assigned immutable scale version, including legacy drafts. New triad rounds use the 2.0.0 support-intake role map; unfinished 1.x rounds use the legacy map (parent/child 1.3.0, teacher 1.2.0) for missing roles. Existing assigned tasks keep their exact version. A family-locked transaction resolves both round and version; explicit cross-generation requests receive 409 `TRIAD_GENERATION_MISMATCH`. A later eligible retake uses a new round and new source IDs. The synthetic replay endpoint continues to reproduce the prior versions.

## Workspace and access

GET `/api/workspace?locale=...` returns `{user,region,mode,families,assessments,reports,scales,goals,observations,staff,contentVersions,alerts,staffNotes,summary}`. Arrays are server-scoped, not client-filtered grants.

| Record | Fields relevant to the UI |
|---|---|
| family | `{id,familyName,childName,age,birthDate,grade,region,guardianLabel,assignedTo,assignedName?,canInviteMembers,joinCode?,createdAt,consent,consents?,members:[{id,name,role}]}` |
| assessment | `{id,familyId,childName,respondentId,respondentName,respondentRole,scaleVersionId,scaleTitle,status,phase,createdAt,submittedAt?,reportId,canRespond,canRetryReport,reviewFlags?,statedAge?}` |
| report | `{id,familyId,childName,title,respondentRole,scaleTitle,combined?,createdAt,generationMode:'template'\|'ai',risk,demo,dimensions:[{key,label,raw,max,band}],assessmentId,comparison:{available,previousDate?,changes?,reason?}}` |
| scale | `{id,scaleId,version,title,description,demo,minAge,maxAge,roles,retakeDays,source,rights,status:'active'\|'retired',isDefaultVersion?}` |
| alert | `{id,familyId,childName,createdAt,viewedAt}` for an unresolved safety signal |
| staff note | `{familyId,assessmentId,itemId,label,value}`; only available to authorised staff/admin, never to the parent report or AI |
| goal / observation | Goals have `{id,familyId,title,detail,status,createdAt}`. Observations have `{id,familyId,body,createdAt,authorName}` and are staff/admin-only. |
| staff / contentVersions | `{id,name}[]` and `{id,kind,version,libraryKey?,createdAt}[]`; administrator fields are not exposed to other roles. |

`consent` means participation purposes are active. `consents`, when exposed, contains `{assessment,sensitiveData,parentReport,aiProcessing}`. It does not bundle those permissions. `age` is calculated from the family birth date on the deployment region's local date. `age_mismatch` is a staff review flag, not a diagnosis or automatic safety escalation. `demo` on a scale is `effectiveDemo`: the stored `demo` flag or a norm that is not `validated`. `isDefaultVersion` marks the current assignment ids (`growth-child@2.0.0`, `growth-parent@2.0.0`, `growth-teacher@2.0.0`). Earlier `scale_id@version` rows stay byte-identical.

For authorised staff/admin only, the workspace also includes `staffIntakeResponses: {familyId,assessmentId,role,submittedAt,sections:[{title,items:[{itemId,label,responses:string[]}]}]}[]`. It contains submitted 2.0.0 answers from families within the existing regional/assignment scope, using the frozen submitted definition and age. Hidden items and drafts are excluded. Parent, student and teacher responses omit this field entirely. This data is neither report content nor AI input.

Unscored short reports carry `resultMode: "support-intake"`, `dimensions: []`, and `comparison: {available:false,reason:"not_scored"}`. Their triad payload adds `supportIntake` with adult-only `concerns`, `supports`, `actions` and the fixed `nextStep`; observations contain `{role,itemId,prompt,responses,period}` in both languages. The existing scored arrays stay empty on these reports, and HTML/PDF omit score/profile/comparison sections. No route is added. The form counts include assent and one optional text question: 25/20/15 ordinarily, at most 26/22/16 with safety follow-ups.

Parents see their own families. Students and teachers see their own assignments and cannot read parent reports. Regional staff can see minimal unresolved alerts; family details require assignment or an unassigned family with an unresolved alert. Viewing an alert preserves that unresolved state. Resolving the alert ends the fallback detail access. Retry and invitation controls use their own server capability checks; seeing an alert is not general mutation authority.

## Family management and consent

| Method / endpoint | Input and result | Authority |
|---|---|---|
| POST `/api/families` | `{familyName,childName,birthDate,grade,guardianLabel,assignedTo?}` → 201 `{id}` | Admin/staff |
| PATCH `/api/families/:id/assignment` | `{assignedTo:staffUuid}` → `{id,assignedTo}` | Admin; enabled same-region staff |
| POST `/api/families/:id/consent` | `{action:'grant'\|'withdraw',scope,guardianName,reference?,confirmWithdraw?}` → `{ok:true}` | Authorised parent/staff/admin; rechecked under the family lock |
| DELETE `/api/families/:id` | `{confirmation:childName}` → `{ok:true}` | Authorised parent/admin; removes family records and access, queues filesystem PDF cleanup, preserves independent accounts |
| POST `/api/families/:id/invites` | `{role:'parent'\|'student'\|'teacher'}` → 201 `{url,expiresAt}` | Admin or assigned staff; UI uses `canInviteMembers` |

Consent `scope` is exactly one of `assessment`, `sensitive_data`, `parent_report`, `ai_processing`. Staff/admin must supply an offline reference. Withdrawing either participation purpose requires `confirmWithdraw:true`. Repeating a current grant or withdrawal is idempotent.

Withdrawals have their own `consent_scope_revocations` evidence. They do not replace the original guardian name, notice version or grant time on legacy combined grants. A genuinely new grant has new evidence. Effective consent reads subtract recorded withdrawals. Granting `parent_report` queues/resumes the held report once; withdrawal blocks reads and is rechecked at final publication.

## Invitations and password recovery

Generated links use URL fragments (`/invite#token=...`, `/recover#token=...`). The UI moves tokens into the dedicated headers for lookup, or the JSON body for acceptance. Legacy query-token lookup remains supported. Never put tokens in application logs or send invitations automatically.

| Method / endpoint | Contract |
|---|---|
| GET `/api/invite` | `X-Invitation-Token` header, or legacy `?token=` → `{familyName,role,region,expiresAt}` |
| POST `/api/invite` | Existing actor: `{token}`; a new local identity supplies `{token,name,username,password}`; A new verified Clerk identity supplies `{token,name}`, with the role determined by the invitation. The single-use invitation determines family and role. Returns `{ok:true}`; local new entry also sets a session. |
| POST `/api/users/:id/recovery` | Admin, local auth only → 201 `{url,expiresAt,name}` for a single-use recovery link |
| GET `/api/recovery` | `X-Recovery-Token` header, or legacy `?token=` → `{name,username,role,region,expiresAt}` |
| POST `/api/recovery` | `{token,password}` → `{ok:true}`. Consumes outstanding local recovery links and revokes the user's sessions; does not create a new session. Clerk accounts use Clerk recovery. |

## Assessments and report phases

An answer map contains item IDs and `number | number[] | string` values for single, multiple and text items. The input parser accepts null to clear an answer; null, empty arrays and blank text are removed. It validates item IDs, choices, exclusive choices, length and type. No client-calculated scores are accepted.

| Method / endpoint | Contract |
|---|---|
| POST `/api/assessments` | `{familyId,respondentId,scaleVersionId,locale}` → 201 `{id}` for an eligible authorised member and active version. Retake and pending-task rules apply. |
| GET `/api/assessments/:id` | Own assignment only → `{id,status,childName,scaleTitle,demo,description,surveyJson,draftAnswers,draftRevision,consentRequired,phase,safetyGuidance}`. Triad instruments also include `completionRules`. Present optional fields are `titleEmphasis` and `supplements` (staff-only text that appears when a parent choice is selected). |
| PATCH `/api/assessments/:id` | `{answers,acknowledged:true,revision:number}` → `{ok:true,revision}`. Requires participation consent. Stale revision → 409 `DRAFT_CONFLICT`. |
| POST `/api/assessments/:id/submit` | `{answers,acknowledged:true,revision:number}` → `{id,status,reportId,phase,safetyGuidance}`. Pending submissions freeze server scores/snapshot; replay returns the existing submitted result. An incomplete triad returns 422 `INCOMPLETE_TRIAD` with `completionIssues` and does not publish. |
| POST `/api/assessments/:id/retry-report` | `{}` → `{id,status:'queued'}`. Admin/assigned staff only, with current authority and a retryable failed job. Does not reopen or rescore answers. Use `canRetryReport` from workspace. |

Assessment status is `pending | queued | published | failed`. Phase adds reporting context:

| `phase` | Meaning |
|---|---|
| `waiting` | Other triad roles still need to submit for this round |
| `consent` | Report delivery lacks effective parent-report consent; submissions can already be complete |
| `reporting` | An authorised report job exists |
| `null` | No additional phase applies, including an accessible published report |

Participation consent and parent-report consent are different. A report-consent hold must not be presented as missing answers or active generation. Parents/staff can see the hold reason; students/teachers receive a neutral submitted confirmation. A submission may raise a safety alert before a combined report exists. The child's age-restricted items use family birth-date age, not the stated questionnaire age.

The triad requires three valid role-specific submissions from one pinned round. It publishes one shared parent report automatically; it does not combine different rounds or produce a clinical total score. Terminal report failure marks the associated source assessments failed. Raw-score longitudinal comparison is supported for the same respondent and version in individual-instrument reports; a triad report does not claim that comparison.

## Reports, safety and care

| Method / endpoint | Contract |
|---|---|
| GET `/api/reports/:id?locale=...` | Authorised admin/staff/parent → report summary plus `{html,downloadUrl}` |
| GET `/api/reports/:id/document?locale=...` | Authenticated frozen HTML with its own restrictive CSP; embed with an iframe `src` |
| GET `/api/reports/:id/pdf?locale=...` | Authenticated PDF download, decrypted after region/family/role and parent-report consent checks |
| POST `/api/alerts/:id/viewed` | `{}` → `{ok:true}`; marks seen but keeps the unresolved alert visible |
| POST `/api/alerts/:id/resolved` | `{}` → `{ok:true}`; closes an alert and removes it from the open list |
| POST `/api/goals` | `{familyId,title,detail}` → `{id}`; authorised admin/staff/parent |
| PATCH `/api/goals/:id` | `{status:'active'\|'completed'}` → `{ok:true}` |
| POST `/api/observations` | `{familyId,body}` → `{id}`; authorised staff/admin |

Alert mutations are rechecked under the family lock. Admins and the assignee can act; same-region staff can handle an unresolved alert on an unassigned family. Another family's assigned staff cannot use regional alert visibility to act. Replays cannot duplicate alerts. A resolved unassigned-family alert no longer grants fallback authority, so do not assume that actor can replay a resolved action indefinitely.

Parent reports exclude child raw free text, situation responses, priorities and staff-only contact text. Approved triggered safety messages and aggregate child observations remain visible. Withdrawing parent-report consent blocks JSON, HTML and PDF endpoints with 409 `GUARDIAN_CONSENT_REQUIRED`; downloaded copies cannot be recalled.

## Administrator versioning

- GET `/api/scales/example` downloads the editable demo definition. POST `/api/scales` `{definition}` creates a validated immutable version. `demo:false` plus `norm.validated:false` is rejected. Rights metadata is required but is not an automatic licensing check.
- PATCH `/api/scales/:id` `{status:'active'|'retired'}` retires/reactivates a version. Retiring stops new assignments; old tasks retain their frozen definition. Reactivation checks current advice references and can fail with `ADVICE_MISMATCH`.
- GET `/api/content/:kind` and POST `/api/content/:kind` `{version,content}` operate on the general `advice` or `template` library. The keyed seeded triad library is separate and is not overwritten by these endpoints.
- Setup installs schema/content changes. Public registration/join requests do not run DDL.

## Operations and frontend requirements

- GET `/api/liveness` → `{ok:true}` without a database check. GET `/api/health` → `{ok,region,mode}` after checking the configured database classification. Neither proves report-worker health.
- GET `/api/ops/status` is admin-only. It returns `{region,mode,checkedAt,jobs:{ready,running,done,failed},oldestReadySeconds,expiredLeases,worker:{mode,state,alive,workerId,heartbeatAgeSeconds,uptimeSeconds,cycles},warnings}`. A continuous worker attempts a heartbeat at the start of a processing cycle when at least 5 seconds have elapsed; a long-running cycle can delay the next heartbeat. Operations status treats a heartbeat older than 60 seconds as stale. Queue mode derives its state from jobs and has null process heartbeat fields. This job-count object does not count paused consent holds.
- Stable warning codes are `worker_never_started`, `worker_stale`, `failed_jobs`, `expired_leases`, `queue_backlog`. Queue mode does not require a resident worker heartbeat.
- GET `/api/audit` is admin-only and returns the newest 500 `{id,action,entity_id,created_at}` records in the actor's region. It does not return raw answers, names or free-text payloads.
- GET `/api/privacy?locale=...` → `{version,title,sections:[{title,body}]}`. The UI must make this notice reachable before consent.

The UI must retain demo labels, loading/empty/error states, field errors and the server-provided capabilities. Do not calculate clinical scores in the browser, fabricate success, expose demo roles in service mode, or turn an alert/phase flag into permission to read or mutate a report.

### Restricted synthetic retake

`POST /api/families/:id/synthetic-retake` is available only to the designated
parent test session in a configured synthetic family. Body:
`{ "previousRoundId": "<uuid>", "locale": "zh-CN" | "zh-HK" }`.
Returns HTTP 201 with `{ roundId, assessmentIds: { parent, student, teacher }, reused }`.
The previous round must have three published, correctly bound sources and one
published synthetic triad report. Required consents remain active. The new tasks
use the same scale versions and preserve historical answers and reports. Duplicate
requests return the same successor (`reused: true`). Ordinary sessions and other
roles receive `SYNTHETIC_RETAKE_DENIED`; incomplete history receives
`SYNTHETIC_RETAKE_NOT_READY`; inconsistent successors receive
`SYNTHETIC_RETAKE_CONFLICT`.

Eligible parent workspaces expose `family.syntheticRetake: { previousRoundId }`.
No capability is exposed for an unfinished latest round. This endpoint does not
change the ordinary `POST /api/assessments` retake interval or email authentication.
