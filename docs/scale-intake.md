# Professional instrument intake

The current example, `nova-family-demo@1.0.0`, is fictional and is not a professional psychological instrument. A service environment refuses to create, collect or publish demo-instrument tasks, and refuses to connect to a database classified as demo.

## Materials required

1. Instrument name, author, official version, and publication or acquisition source.
2. The licensing basis for electronic use, commercial use and the Chinese translation; the instrument software's open-source licence does not cover the right to use the instrument's items.
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
| `demo` | Whether this is a demo; setting it to false does not by itself make the instrument validated |
| `rights` | Electronic and commercial usage status, and the reference for the evidence |
| `minAge/maxAge`, `regions`, `roles` | The boundary of who the instrument applies to |
| `norm` | Norm description, source, region, age range and a verified flag |
| `items` | Bilingual items, optional observer wording, discrete numeric options, reverse and required flags |
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
