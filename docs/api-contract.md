# UI / API contract v1

All JSON mutations send `Content-Type: application/json`. Cookie sessions are HTTP-only. Errors use `{error: string, code: string}`. Use `?locale=zh-CN` or `?locale=zh-HK`; locale never changes region. Region is `CN` or `HK`, role `admin|staff|parent|student|teacher`.

## Session
- GET `/api/session` -> `{user: {id,name,role,region}|null,region,mode:'demo'|'service',demoAccounts:[{id,name,role}],siblingUrl:string|null}`. Demo accounts are synthetic and only exposed in demo mode.
- POST `/api/auth/demo` `{accountId}` -> `{ok:true}` and cookie.
- POST `/api/auth/login` `{username,password}` -> `{ok:true}` and cookie.
- POST `/api/auth/logout` `{}` -> `{ok:true}`.

## Workspace
GET `/api/workspace?locale=...` -> `{user,region,mode,families,assessments,reports,scales,goals,observations,staff,contentVersions,summary}`.
- family: `{id,familyName,childName,age,birthDate,grade,region,guardianLabel,assignedTo,createdAt,consent:boolean,members:[{id,name,role}]}`
- assessment: `{id,familyId,childName,respondentId,respondentName,respondentRole,scaleVersionId,scaleTitle,status:'pending'|'queued'|'published'|'failed',createdAt,submittedAt,reportId:string|null,canRespond:boolean}`
- report: `{id,familyId,childName,title,respondentRole,scaleTitle,createdAt,generationMode:'template'|'ai',risk:boolean,demo:boolean,dimensions:[{key,label,raw:number|null,max:number,band:string}],assessmentId,comparison:{available:boolean,previousDate?:string,changes?:[{key,label,delta:number}],reason?:string}}`
- scale: `{id,scaleId,version,title,description,demo,minAge,maxAge,roles,retakeDays,source,rights,status:'active'|'retired'}`
- goal: `{id,familyId,title,detail,status:'active'|'completed',createdAt}`
- observation: `{id,familyId,body,createdAt,authorName}`. Only admin/staff see observations; never place them in AI payloads.
- staff: `{id,name}`[]; contentVersions: `{id,kind,version,createdAt}`[]; summary counts derive from scoped records.

POST `/api/families` `{familyName,childName,birthDate,grade,guardianLabel,assignedTo?}` -> `{id}` (admin/staff).
POST `/api/families/:id/consent` `{accepted:true,guardianName:string,reference?:string}` -> `{ok:true}`. Parent can provide online consent. Staff/admin must include a signed-offline-consent reference; record method explicitly.
DELETE `/api/families/:id` `{confirmation:childName}` -> `{ok:true}` (parent/admin; revoke data and related private files).
POST `/api/families/:id/invites` `{role:'parent'|'student'|'teacher'}` -> `{url,expiresAt}` (admin/staff). Show copyable invitation URL; never auto-send email.
GET `/api/invite?token=...` -> `{familyName,role,region,expiresAt}`.
POST `/api/invite` `{token,name,username,password}` -> `{ok:true}` and cookie. Minimum password 12 characters.

## Assessments
POST `/api/assessments` `{familyId,respondentId,scaleVersionId,locale}` -> `{id}` (admin/staff/parent for linked family). Respondent must belong to family and role supported. Enforce retake interval per same person/scale version; synthetic seeds supply older baselines.
GET `/api/assessments/:id?locale=...` -> `{id,status,childName,scaleTitle,demo,description,surveyJson,draftAnswers,draftRevision:number,consentRequired:boolean}`. Only the assigned respondent can read their questionnaire/answers.
PATCH `/api/assessments/:id` `{answers:Record<string,number>,acknowledged:true,revision:number}` -> `{ok:true,revision:number}` saves draft after explicit respondent assent; the first assent timestamp is retained. The expected revision must match the last successful read/save; stale writes fail409 DRAFT_CONFLICT, and must not be automatically retried with stale answers. Do not enable questionnaire input or autosave before assent.
POST `/api/assessments/:id/submit` `{answers:Record<string,number>,acknowledged:true,revision:number}` -> `{id,status:'queued'|'published',reportId}`. No client scores accepted. Stale pending drafts fail409 DRAFT_CONFLICT; repeated already-submitted calls return the existing result. Poll workspace to find published report. For student/teacher show submitted state; parent report access is separately authorized.
POST `/api/assessments/:id/retry-report` `{}` -> `{id,status:'queued'}`. Admin/staff only. Re-queues a failed report job; does not reopen answers or re-score on the client. Parents, students and teachers cannot retry. The workspace UI shows this control only to admin/staff on `failed` tasks, disables it while the request is pending, surfaces the server error text, then shows queued feedback and refreshes.

## Reports and care
GET `/api/reports/:id?locale=...` -> report record plus `{html:string,downloadUrl:string}`. HTML is a full safe document from server templates. Display via iframe src `/api/reports/:id/document?locale=...` (server auth protected).
GET `/api/reports/:id/document?locale=...` -> authenticated HTML.
GET `/api/reports/:id/pdf?locale=...` -> authenticated PDF download.
POST `/api/goals` `{familyId,title,detail}` -> `{id}` (admin/staff/parent).
PATCH `/api/goals/:id` `{status:'active'|'completed'}` -> `{ok:true}`.
POST `/api/observations` `{familyId,body}` -> `{id}` (staff/admin).

## Admin versioning
GET `/api/scales/example` -> editable full demo scale JSON as download, admin only.
POST `/api/scales` `{definition:object}` -> `{id}` validates new immutable version (admin).
PATCH `/api/scales/:id` `{status:'active'|'retired'}` -> `{ok:true}` (admin). Retire stops new assignments; existing assessments/reports keep the frozen version. Reactivation is admin-only and uses the same PATCH with `{status:'active'}`. The server validates current advice references; incompatible advice fails (for example `ADVICE_MISMATCH`) and the UI must show that error after a confirmation step. Staff, parents, students and teachers have no reactivation control.
GET `/api/content/:kind` where kind `advice|template` -> `{id,version,content}` (admin).
POST `/api/content/:kind` `{version,content:object}` -> `{id}` immutable version (admin).

The frontend must show demo labels, empty/error/loading states, visible field labels and real actions. No browser-only scoring or fake success messages. Privacy notice available at `/api/privacy?locale=...` -> `{version,title,sections:[{title,body}]}`. In service mode never expose demo login buttons or role switching.
