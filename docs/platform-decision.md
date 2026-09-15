# Platform decision — 2026-09-10

Primary: SurveyJS Form Library (MIT), integrated as a rendering component; Nova owns scoring, data, report publication and longitudinal records.

Explicit user preference: **keep LimeSurvey as a future alternative**, particularly when an existing survey administration product is useful. Revisit current licensing and maintenance before adoption. Do not build a v1 adapter simply to anticipate it.

GitHub API snapshot from the selection discussion:

| Repository | Stars | Last push |
|---|---:|---|
| surveyjs/survey-library | 4867 | 2026-09-09 |
| LimeSurvey/LimeSurvey | 3716 | 2026-09-09 |
| formbricks/formbricks | 12922 | 2026-09-09 |
| wkeyuan/DWSurvey | 2980 | 2025-03-19 |
| bonyren/wzy-xl | 27 | 2026-02-15 |
| KaoriZh/XinmijiPsychologicalAssessmentSystem | 33 | 2022-12-10 |

Survey Creator/PDF Generator/Dashboard have separate commercial licenses; none are included. Nova renders HTML/PDF independently. Formbricks requires separate consideration of AGPL, enterprise components and proprietary/white-label terms. Wzy's repository GPL label and deployment-guide no-resale wording need clarification before branded reuse. No code from these alternative applications was imported.

Sources: [SurveyJS licensing](https://surveyjs.io/licensing), [LimeSurvey assessments](https://www.limesurvey.org/manual/Assessments), [Formbricks licensing](https://formbricks.com/docs/self-hosting/advanced/license), [Wzy deployment guide](https://github.com/bonyren/wzy-xl/blob/master/独立部署源代码指南.md).

Latest user choices supersede earlier planning: automatic parent delivery without per-report human review; both mainland China and Hong Kong included; all development in `/Volumes/Starship/Nova Psycho Helper`.
