# Model output budgets

Checked on 2026-10-05. Input context, compaction threshold, reasoning effort,
and output budget are separate settings. This change preserves the configured
1,000,000-token context and 800,000-token compaction threshold.

| Model | Automatic output budget | Evidence |
| --- | ---: | --- |
| Claude Opus 4.7, Opus 4.6, Sonnet 4.6 | 128,000 | Official Claude documentation |
| Claude Opus 5, Opus 5.5, Sonnet 5 | 128,000 | Official Claude documentation |
| Claude Opus 4.5, Sonnet 4.5, Haiku 4.5 | 64,000 | Official Claude documentation |
| GPT-6 Astra, GPT-5.6 Sol/Luna/Terra | 128,000 | Existing compatibility profile; **official maximum not verified in this audit** |
| Other families, including CSU's GLM | Existing defaults retained | Native main agent: 32,000; observer: 32,768, or a smaller declared supplier ceiling |

These are per-request upper bounds, not a target response length or a limit on
the complete multi-turn task. Claude thinking and its visible answer share
`max_tokens`. OpenAI reasoning output shares `max_output_tokens` (Responses)
or `max_completion_tokens` (reasoning Chat Completions).

## Sources and confidence

Claude page bodies were retrieved from the official
[full documentation export](https://platform.claude.com/llms-full.txt), HTTP 200.
The export SHA-256 was
`7c5fe515a695edb4dbd05b04aa155b8b832af3633c73d6c3733b6336875d56e7`.
Its page bodies identify these source URLs:

- [Opus 4.7](https://platform.claude.com/docs/en/models/opus-4-7/overview)
- [Opus 4.6](https://platform.claude.com/docs/en/models/opus-4-6/overview)
- [Sonnet 4.6](https://platform.claude.com/docs/en/models/sonnet-4-6/overview)
- [Opus 4.5](https://platform.claude.com/docs/en/models/opus-4-5/overview)
- [Sonnet 4.5](https://platform.claude.com/docs/en/models/sonnet-4-5/overview)
- [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview)
- [Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview)
- [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)
- [Sonnet 5](https://platform.claude.com/docs/en/models/sonnet-5/overview)

Each overview states its model ID and 64K or 128K maximum output. The Opus 5.5
migration guidance also explicitly spells the maximum as 128,000. Values are
decimal, not 65,536 or 131,072. The batch-only 300,000-token beta is not used
for interactive Agent requests. Individual Claude HTML pages redirected to a
region-unavailable page; that page was not used as evidence.

OpenAI Docs searches and direct retrieval attempts for the configured model
pages at developers.openai.com and platform.openai.com returned 403; the
learn.chatgpt.com requests also failed. No fetched official body established
the GPT-6 Astra or GPT-5.6 Sol/Luna/Terra output maxima. Their inherited
128,000 values remain explicitly `legacy` / unverified in code and UI; they
must not be cited as a newly confirmed OpenAI specification. The existing
profile's older-model estimates are likewise not re-certified by this change.

Gateway identifiers such as `claude-kr-claude-opus-5.5[1M]` keep their exact
wire identity. Only explicit recognized wrappers reference a documented model;
the UI labels this as a reference, not proof of gateway support. `[1M]` never
sets the output budget. A smaller supplier-declared ceiling wins. No gateway
completion was called to probe paid limits.

## Behavior and verification

The main model menu saves an optional output override to the current
conversation's `modelSelection.maxOutputTokens`. Empty or zero means automatic.
Changing models resets it to automatic. Already-running tasks retain their
frozen model settings. The observer has its own `observer.maxOutputTokens`.
Neither control changes context size, reasoning effort or another conversation.

The native OpenCode 1.18.11 runtime has an additional 32,000-token default cap.
Z sets its supported `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` flag before
spawning each isolated kernel to allow its configured model budgets. Individual
`limit.output` values still bound each model. Non-focus automatic budgets keep
their prior native 32,000 cap even in a kernel containing a larger model.
For legacy Claude manual thinking, the native SDK adds the thinking budget
to the completion allowance; Z subtracts it first so the total wire budget
matches the user's selection. Context preflight adds that reservation back.

`test/model-output-limits.e2e.cjs` runs the real native kernel against local
scripted providers to check final Messages, Chat Completions and Responses
fields, including lower manual budgets, exact gateway IDs and non-focus model
preservation. Unit and UI tests cover source confidence, supplier ceilings,
input-context preservation, independent settings, save races and snapshots.
