# Professional instrument intake

The 9-item `nova-family-demo@1.0.0` example is fictional demonstration content. The bundled parent / child / teacher `growth-triad` questionnaires have no validated clinical norms; their exact known IDs and versions are available in service mode for non-clinical growth support and communication. This permission also covers known historical versions without changing their stored definitions. Other demo or unvalidated instruments remain blocked from service-mode assignment, collection and publication unless covered by the separately scoped synthetic-testing channel. A service environment still refuses to connect to a database classified as demo.

## Materials required

1. Instrument name, author, official version, and publication or acquisition source.
2. Required operator-supplied rights metadata (`rights.digital`, `rights.commercial`, and a nonempty `rights.reference`), including the electronic/commercial context and translation provenance. The boolean values are recorded, not verified as licensing permission or used as import blockers.
3. The explicit ages of use, the respondent (student / parent / teacher), the applicable regions, and simplified and traditional text. Different translations must not be machine-converted and then treated as the same validated version.
4. Original items, discrete response options, positive and reverse items, item membership per subscale, and aggregation rules.
5. Missing-answer rules, interpretation thresholds, norm source and applicable population, and the recommended retest interval.
6. The parent explanation, action advice, source of basis and preset risk notices for each interpretive band.
7. Standard worked examples: covering at least minimum and maximum scores, boundary scores, reverse items, permitted and non-permitted missing data, and inapplicable age / role / region.

## Configuration order

First create the advice library and report template under the administrator's "Report content", then import the instrument. The advice library holds fixed IDs, bilingual titles and bodies, the source of basis, and the associated dimension IDs. Each instrument band references this content through advice IDs.

The instrument JSON can be obtained from the administrator's "Download example", or exported with the following command (the output contains only original demo content):

```sh
node --import tsx -e "import('./src/domain/demo.ts').then(m=>console.log(JSON.stringify(m.demoScale,null,2)))" > work/demo-scale-example.json
```

Main fields:

| Field | Meaning |
|---|---|
| `id` + `version` | The unique instrument version; any content change must publish a new version |
| `demo` | Whether this is a demo; setting it to false does not by itself make the instrument clinically validated |
| `rights` | Recorded electronic/commercial flags and a reference string for operator notes; the importer no longer blocks on these flags |
| `minAge/maxAge`, `regions`, `roles` | The boundary of who the instrument applies to |
| `norm` | Norm description, source, region, age range and the operator's `validated` attestation; a non-demo definition requires `validated: true` |
| `items` | Bilingual single-choice, multiple-choice or text items; numeric choices, exclusive options, reverse/required flags, optional visibility/age rules and reporting destinations |
| `dimensions` | Item membership, sum or mean aggregation, missing-data ceiling, prorating, interpretive bands |
| `riskRules` | Fixed bilingual notices triggered by specific items and response values |
| `retakeDays` | The minimum retest interval for the same respondent and instrument version |

The engine rejects duplicate item numbers, unknown item references, out-of-range responses, duplicate or out-of-range bands, advice that does not match the dimension, ambiguous partial-mean rules, and arbitrary SQL or code expressions. Where a mean has missing values, or a sum requires proportional adjustment, the relevant items must use the same numeric range. Different roles are never merged into one score, and different versions are never compared directly.

Only raw-score rules are currently supported. If an instrument needs T-scores, age-banded norm lookup, special weighting or another complex algorithm, implement that algorithm as a new deterministic scoring capability and check it item by item against the official manual's worked examples. Do not substitute a simpler sum.

Retiring a version does not delete historical records; tasks already assigned but not completed can still be submitted. When publishing a new advice library, the system preserves the advice references needed by active instruments and incomplete tasks. Reactivating an old instrument re-checks compatibility.

## Candidate resources identified

- SDQ: electronic versions require prior authorisation, see https://sdqinfo.org/.
- RCADS: Chinese versions, electronic use and commercial distribution must be checked against https://rcads.ucla.edu/permissions.
- PSC / PSC-17 and SCORE-15: listed as candidates pending verification; no items are pre-loaded and no commercial licence is claimed.

Subsequent literature and mainland China / Hong Kong applicability checks use the EdUHK Library at https://www.lib.eduhk.hk/ together with instrument developer bodies, journal articles and other reputable sources. Merely accessing a library portal or obtaining a Chinese-language form does not constitute completed reliability, validity or norm verification. No login credentials may enter configuration, code, logs or delegated messages.

## Preparation status (2026-09-16)

Background notes live under `work/scale-intake-20260916/` (no copyrighted item text, licences or credentials). The operator obtains questionnaires independently; Nova does not require questionnaire-vendor product partnerships.

**Import policy:** `parseScale` rejects a non-demo instrument unless `norm.validated` is true. An unvalidated imported definition must be labelled demo. Service mode separately rejects demo and unvalidated content at assignment, draft, submission and report generation, with the exact known `growth-triad` versions and scoped synthetic-testing channel as exceptions. A `growth-triad` bundle label alone does not admit an unknown ID or version, and permission to use a known questionnaire is not evidence of clinical validation. Changing an old row's demo flag is not an upgrade path. Publish a new immutable version and retain old tasks on their original definitions.

`rights.digital`, `rights.commercial` and `rights.reference` remain required operator-managed metadata; the importer does not independently verify permissions or make the two booleans import blockers. A norm flag likewise records an attestation and does not establish psychometric validity by itself. Structural scoring rules, bilingual text and age/region gates continue to apply.

Setup installs the triad advice/template under its own stable `growth-triad` library key. General administrator-managed content is kept separate. The public content API edits the general library; it is not an endpoint for overwriting seeded triad content. Normal signup and join requests do not run schema migrations.
