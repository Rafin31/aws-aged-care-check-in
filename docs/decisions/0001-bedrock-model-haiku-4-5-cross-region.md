# ADR 0001: Bedrock model switched from Claude 3 Haiku to Claude Haiku 4.5 (cross-region inference)

**Date:** 2026-09-18
**Status:** Accepted

## Context

The Sept 6 2026 brainstorm for Phase 6 locked the Bedrock model choice as
`anthropic.claude-3-haiku-20240307-v1:0`, on-demand, single-region
(`ap-southeast-2`), specifically to avoid the extra IAM complexity of a
cross-region inference profile that Claude Haiku 4.5 would have required at
the time.

While building Task 9 (`analyze-response` lambda), the Bedrock Model
catalog no longer listed Claude 3 Haiku at all — searching "haiku" returned
only Claude Haiku 4.5, and the full Anthropic provider list (13 models)
confirmed the entire Claude 3.x generation had been retired from the
catalog. AWS also retired the old "Model access" manual-approval Console
page in the same period — models now auto-enable account-wide on first
invoke, so that part of the original plan is also moot.

Checked Claude Haiku 4.5's model detail page: **Inference type =
Cross-region inference**, with the note "This model can only be used
through an inference profile" — there is no direct on-demand invoke option
for this model at all. The cross-region complexity the original decision
was trying to avoid is now unavoidable for any current Haiku-tier model.

## Decision

Use Claude Haiku 4.5 via its inference profile ID
`global.anthropic.claude-haiku-4-5-20251001-v1:0` (confirmed from the
Bedrock Console model detail page, not guessed).

`analyze-response`'s Lambda IAM role grants `bedrock:InvokeModel` on two
resources, not one:
- the inference profile ARN
  (`arn:aws:bedrock:<region>:<account>:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0`)
- the underlying foundation-model ARN, region-wildcarded
  (`arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`)

because a cross-region profile can route the actual inference call to any
region in its group, and Bedrock requires the caller to hold `InvokeModel`
on whichever concrete model ARN it lands on, not just the profile.

## Consequences

- **Cost:** Haiku 4.5 is priced higher than the originally-planned Claude 3
  Haiku — confirmed actual rate from AWS's pricing page: $1.00 / 1M input
  tokens, $5.00 / 1M output tokens. Per check-in call (~300 input tokens,
  ~100 output tokens) this is roughly $0.001 — still negligible against the
  $100 Free Tier credit, but a real per-call charge (Bedrock has no free
  tier bucket at all, confirmed with Rafin before proceeding per CLAUDE.md's
  cost hard rule).
- **IAM:** the Lambda role is slightly more complex than the original plan
  (two resource ARNs instead of one) — documented above so the pattern
  doesn't need re-deriving later.
- No change to the workflow's shape (still one `LambdaInvoke` task in the
  state machine) — this is an internal implementation swap inside
  `analyze-response`, not an architecture change to the Phase 0 diagram.
