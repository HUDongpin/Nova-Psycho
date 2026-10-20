# Live AI regional verification

**Live triad AI and production regional acceptance remain separate from local verification.** The triad implementation is disabled by default and can be tested with synthetic data and a local HTTP mock. Those tests do not establish real-provider behaviour, inference location or production enablement. Record a live result only when its dated evidence identifies the provider, model, region and result.

## Verification boundaries

- Unit and local integration checks verify the allowed request fields, exact advice-ID permutation, template fallback, consent changes and frozen bilingual report output. The independent triad integration test uses an isolated local database, fake credentials and an injected HTTP mock. It rejects other model outbound requests. The existing integration command retains its AI-off restriction.
- A live conformance run uses only in-memory synthetic data and requires separate authorisation and suitable credentials. Project policy forbids transmitting real data to live AI or provisioning infrastructure merely to test the application. Credentials must not appear in evidence, logs or source.
- Production enablement additionally requires the operator's deployment authorisation and evidence for the actual provider's processing arrangements. A local test, a configured region label or an allowlisted URL cannot prove where inference ran.

## Triad request and publication contract

`NOVA_TRIAD_AI_ENABLED` defaults to false and operates independently of the global `NOVA_AI_ENABLED` switch. Both must be true, provider configuration must be valid, and all three same-round submission snapshots must contain AI consent. A later grant cannot change those snapshots. The family must also have a current `ai_processing` grant.

The parent submission's frozen advice library supplies the candidates. Each role's frozen instrument and valid dimension summaries determine applicability. The model receives only age band, role, dimension and domain identifiers, summary values and interpretation direction, plus eligible approved suggestions. Identity, school, grade, raw answers, free text and staff notes are excluded.

Each report-job attempt makes at most one ranking request. The model must return `{"adviceIds":[...]}` containing every candidate exactly once, with no extra keys or prose. The worker uses one saved order for both languages. Fewer than two candidates, a safety risk in any source, missing consent or configuration, malformed output, provider errors and the 8-second timeout all produce template output.

The worker checks the current AI grant again after inference and inside the publication transaction. Withdrawal or replacement discards the AI order and rebuilds unpublished HTML and PDF with the stable library order. No second AI call is made, and a request already sent cannot be recalled. Parent-report withdrawal follows the existing publication hold. Published reports remain immutable; legacy snapshots without triad applicability metadata remain template reports.

Reports show the actual saved mode, either AI-assisted advice ordering or rule-template generation, and the frozen advice-library version. Deterministic scoring, summary prose and safety messages do not become model output.

## Retained Bailian documentation findings

The following records the earlier provider documentation review. Recheck the provider's current contract and the specific workspace's deployment settings before a live or production acceptance decision.

| Assumption in the code | Finding | Status |
|---|---|---|
| Endpoint host is `llm-<workspaceId>.<region>.maas.aliyuncs.com` | Beijing is documented as `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`. The Hong Kong migration example uses `llm-xxx.cn-hongkong.maas.aliyuncs.com`, confirming that the `llm-` prefix is the business-space ID form. | Confirmed — the allowlist regex matches both regions |
| Path is `/compatible-mode/v1` | Documented for both regions | Confirmed |
| Bailian uses a workspace-scoped host rather than the shared domain | The documented Beijing migration is `https://dashscope.aliyuncs.com/compatible-mode/v1` → `https://llm-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`, and `dashscope.aliyuncs.com` stops receiving new features after 2026-09-30 | Confirmed in the retained review. The shared and trial Bailian domains are rejected; a Beijing business-space host is accepted. Covered by `tests/config.test.ts` |
| Beijing supports a single deployment scope | The official region table states Beijing and Singapore each support one scope and require no selection | Confirmed — removes the Hong Kong scope ambiguity for a mainland deployment |
| `response_format: {type:"json_object"}` is accepted | Supported. It additionally requires the literal word "JSON" in a system or user message, otherwise the call errors. | Confirmed — the system prompt already contains "JSON" |
| The correct parameter name is `max_tokens` | Documented name; `max_completion_tokens` is not used by this API | Confirmed, but see hazard 1 |
| The reply shape is `choices[0].message.content` | Documented response shape | Confirmed |

Sources: [OpenAI compatibility](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope), [structured output](https://help.aliyun.com/zh/model-studio/qwen-structured-output), [regional access domains](https://help.aliyun.com/zh/model-studio/hong-kong-china-global).

The configuration also allows the specific DeepSeek Flash endpoint. The generic DeepSeek hostname does not identify a CN or HK inference region. `NOVA_AI_DEPLOYMENT_SCOPE` records a configuration assertion for that endpoint, so actual processing location requires provider-side evidence.

## Hazards found, and how they were addressed

1. **A token cap combined with structured output.** The documentation states that setting `max_tokens` while structured output is enabled can truncate the JSON mid-string, and that reasoning models spend the budget on thinking first. The adapter previously sent `max_tokens: 512`. That is now removed; the 8-second timeout and the 20,000-character size guard bound the response instead. Left in place, this was a plausible route to the AI path silently never engaging.

2. **Thinking models ignore structured output without erroring.** The documentation notes that a model in thinking mode does not error when `response_format: json_object` is set, but that structured output may then fail. Two defences were added: markdown fences are stripped before parsing, and a reply carrying `reasoning_content` with no answer now reports the distinct fallback reason `thinking_model_output` rather than being misreported as a provider outage. A non-thinking model should be selected for this task.

3. **JSON Schema mode is available but deliberately not used.** `response_format: {type:"json_schema", ...}` would enforce the exact output shape and could constrain advice IDs with an enum, removing the need for much of the defensive validation. It is supported by only a subset of models, so adopting it risks a hard `400` on an unsupported model — a permanent silent fallback, which is worse than looser validation. `json_object` is retained for breadth. JSON Schema mode is a sensible future change once the deployed model is fixed.

4. **Fallback reasons were imprecise.** A malformed model reply previously reported `provider_unavailable`, which is indistinguishable from a network outage. Parsing failures now report `invalid_output`, so the conformance harness can separate a provider problem from a model-behaviour problem.

## What a live run still has to establish

None of the following can be settled from documentation:

1. That the workspace accepts the request at all with a real key — authentication and model entitlement.
2. That the deployed model actually honours `response_format`. Fence-stripping only makes the failure survivable; it does not show that the failure does not occur.
3. That the model reliably returns every eligible advice ID exactly once across repeated calls. Different valid rankings are permitted; the published report freezes one accepted order.
4. Real end-to-end latency against the 8-second timeout budget.
5. **The geographic execution question — simpler in Beijing than in Hong Kong.** The documentation confirms that the access/storage region and the *service deployment scope* are separate settings, and that the available scopes differ by region:
   - **Beijing (`cn-beijing`) supports a single deployment scope.** The official region table states that Beijing and Singapore each support only one scope and require no selection, so there is no scope choice to get wrong.
   - **Hong Kong (`cn-hongkong`) supports two**: "global (any available node, including inside mainland China and overseas)" and "Hong Kong (in-region inference only)". There, an approved hostname plus a matching `NOVA_AI_DEPLOYMENT_SCOPE` does **not** prove in-region inference, and the choice must be confirmed for the actual workspace in the Model Studio console.

   This makes Beijing the lower-ambiguity option for a mainland China deployment. In either region, no automated check in this repository can establish which nodes executed a given request.

## Running the verification

Run the independent local triad test without live credentials:

```sh
npm run test:triad-ai
```

The command uses synthetic families in an isolated local database and an injected HTTP mock. Evidence belongs in `work/qa/triad-ai/`. Its result covers application behaviour, browser reports and rendered PDFs only to the extent recorded by that run; it is not live-model or production acceptance.

After separate authorisation for a live run, configure credentials for the region and run:

```sh
node scripts/run-region.mjs CN ai-conformance
```

The harness builds its snapshot in memory from the fictional demo instrument, imports no database module, refuses to run against an instrument not marked as a demo, inspects the transmitted payload for identity and raw-answer leakage, and prints neither the API key nor response bodies. Evidence is written to `work/qa/ai-conformance.json`. A single-instrument run alone does not establish triad conformance.

Exit codes: `0` all checks passed, `1` a check failed, `2` configuration invalid, `3` AI not enabled, `4` the active instrument is not a demo instrument.

Afterwards, record the provider, model, region, date, latency, accepted outputs and fallback reasons. Attach provider evidence for the processing region and deployment scope before enabling triad AI for that production region. Keep both AI switches off until the corresponding acceptance and deployment authorisation are complete. Turning off `NOVA_TRIAD_AI_ENABLED` restores template generation for subsequent triad reports without changing published reports.
