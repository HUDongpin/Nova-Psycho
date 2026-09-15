# Live AI regional verification

**Status: not yet performed.** The constrained narrative adapter has never been exercised against a real Model Studio (Bailian) workspace, because no credentials have been supplied. This document separates the assumptions that were verified against the official documentation from those that still require a live API key.

## Why this could not be completed from this repository

- No `NOVA_AI_*` credentials exist in the repository or in the local region environment files; `NOVA_AI_ENABLED=false` in both.
- Project policy forbids transmitting real data to live AI, or provisioning infrastructure, merely to test the application.
- The adapter is unit-tested against a stubbed fetcher. That proves the constraints hold when the provider misbehaves, but it cannot prove the provider honours the request contract in the first place.

## Confirmed against official documentation

| Assumption in the code | Finding | Status |
|---|---|---|
| Endpoint host is `llm-<workspaceId>.<region>.maas.aliyuncs.com` | Beijing is documented as `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`. The Hong Kong migration example uses `llm-xxx.cn-hongkong.maas.aliyuncs.com`, confirming that the `llm-` prefix is the business-space ID form. | Confirmed — the allowlist regex matches both regions |
| Path is `/compatible-mode/v1` | Documented for both regions | Confirmed |
| `response_format: {type:"json_object"}` is accepted | Supported. It additionally requires the literal word "JSON" in a system or user message, otherwise the call errors. | Confirmed — the system prompt already contains "JSON" |
| The correct parameter name is `max_tokens` | Documented name; `max_completion_tokens` is not used by this API | Confirmed, but see hazard 1 |
| The reply shape is `choices[0].message.content` | Documented response shape | Confirmed |

Sources: [OpenAI compatibility](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope), [structured output](https://help.aliyun.com/zh/model-studio/qwen-structured-output), [regional access domains](https://help.aliyun.com/zh/model-studio/hong-kong-china-global).

## Hazards found, and how they were addressed

1. **A token cap combined with structured output.** The documentation states that setting `max_tokens` while structured output is enabled can truncate the JSON mid-string, and that reasoning models spend the budget on thinking first. The adapter previously sent `max_tokens: 512`. That is now removed; the 8-second timeout and the 20,000-character size guard bound the response instead. Left in place, this was a plausible route to the AI path silently never engaging.

2. **Thinking models ignore structured output without erroring.** The documentation notes that a model in thinking mode does not error when `response_format: json_object` is set, but that structured output may then fail. Two defences were added: markdown fences are stripped before parsing, and a reply carrying `reasoning_content` with no answer now reports the distinct fallback reason `thinking_model_output` rather than being misreported as a provider outage. A non-thinking model should be selected for this task.

3. **JSON Schema mode is available but deliberately not used.** `response_format: {type:"json_schema", ...}` would enforce the exact output shape and could constrain advice IDs with an enum, removing the need for much of the defensive validation. It is supported by only a subset of models, so adopting it risks a hard `400` on an unsupported model — a permanent silent fallback, which is worse than looser validation. `json_object` is retained for breadth. JSON Schema mode is a sensible future change once the deployed model is fixed.

4. **Fallback reasons were imprecise.** A malformed model reply previously reported `provider_unavailable`, which is indistinguishable from a network outage. Parsing failures now report `invalid_output`, so the conformance harness can separate a provider problem from a model-behaviour problem.

## What a live run still has to establish

None of the following can be settled from documentation:

1. That the workspace accepts the request at all with a real key — authentication and model entitlement.
2. That the deployed model actually honours `response_format`. Fence-stripping only makes the failure survivable; it does not show that the failure does not occur.
3. That the model reliably returns exactly the eligible advice IDs, in a stable order, across repeated calls.
4. Real end-to-end latency against the 8-second timeout budget.
5. **The geographic execution question.** The documentation confirms that the access/storage region and the *service deployment scope* are separate settings. For Hong Kong the deployment scope is either "global (any available node, including inside mainland China and overseas)" or "Hong Kong (in-region inference only)". An approved hostname plus a matching `NOVA_AI_DEPLOYMENT_SCOPE` value therefore does **not** prove in-region inference. This must be confirmed for the actual workspace in the Model Studio console, and the evidence retained. No automated check in this repository can establish it.

## Running the verification

With credentials configured for the region:

```sh
node scripts/run-region.mjs CN ai-conformance
```

The harness builds its snapshot in memory from the fictional demo instrument, imports no database module, refuses to run against an instrument not marked as a demo, inspects the transmitted payload for identity and raw-answer leakage, and prints neither the API key nor response bodies. Evidence is written to `work/qa/ai-conformance.json`.

Exit codes: `0` all checks passed, `1` a check failed, `2` configuration invalid, `3` AI not enabled, `4` the active instrument is not a demo instrument.

Afterwards, replace the status line at the top of this document with the region, model, date and result, and attach the Model Studio console evidence for the deployment scope.
