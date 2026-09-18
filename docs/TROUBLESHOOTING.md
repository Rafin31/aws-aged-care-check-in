# Troubleshooting Log

Every fixed problem gets an entry here: title, why it happened, how it was
fixed. Per CLAUDE.md checkpoint/error-handling rules.

## IAM user denied access to Billing console

**Why:** AWS gates the Billing and Cost Management console behind a
root-only account setting (`IAM User and Role Access to Billing
Information`), separate from IAM policies. The `rafin-admin` IAM user had
`AdministratorAccess` attached but still got "You need permissions" when
opening Billing preferences — that policy doesn't cover billing visibility
by default.

**How fixed:** Signed in as root -> account menu -> **Account** -> **IAM
User and Role Access to Billing Information** -> **Edit** -> checked
**Activate IAM Access** -> **Update**. Signed back into `rafin-admin`;
Billing preferences and the CloudWatch billing alarm setup then worked
normally.

## Claude 3 Haiku retired from Bedrock model catalog mid-build

**Why:** Phase 6's Sept 6 brainstorm locked
`anthropic.claude-3-haiku-20240307-v1:0` as the model for
`analyze-response`. By the time Task 9 was actually built (2026-09-18),
searching "haiku" in the Bedrock Model catalog returned only Claude Haiku
4.5 — the full Anthropic list (13 models) confirmed the whole Claude 3.x
generation had been dropped from the catalog. Also found the old "Model
access" manual-approval Console page itself has been retired — models now
auto-enable account-wide on first invoke.

**How fixed:** Switched to Claude Haiku 4.5. Its model detail page
confirmed it's Cross-region-inference-only, so it can't be called by a
plain model ID — needs the inference profile ID instead
(`global.anthropic.claude-haiku-4-5-20251001-v1:0`, copied directly from
the Console, not guessed — an initial screenshot briefly grabbed the wrong
family, `claude-opus-4-5-...`, by mistake, caught before it went into the
code). Full reasoning and the resulting IAM change logged in
[`docs/decisions/0001-bedrock-model-haiku-4-5-cross-region.md`](decisions/0001-bedrock-model-haiku-4-5-cross-region.md).

## Phase 6 plan's `CallAwsService` S3-grant placeholder didn't compile

**Why:** The Sept 6 plan's Task 12 code for granting the Transcribe job
S3 read/write access was written as a placeholder
(`props.recordingsBucket.grantReadWrite(startTranscriptionJob)`) with a
note flagging it as unverified against the installed `aws-cdk-lib`
version. `CallAwsService` (the construct used for the raw
`startTranscriptionJob` SDK call) has no `grantReadWrite`/grantable
principal surface at all — confirmed by reading its `.d.ts` in
`node_modules`, not by guessing.

**How fixed:** Used the construct's actual supported extension point,
`additionalIamStatements`, to add a scoped `s3:GetObject`/`s3:PutObject`
statement on the recordings bucket's objects, alongside the wildcard
resource the `transcribe:startTranscriptionJob` action itself requires
(that action has no resource-level IAM support). `npx tsc --noEmit` and
the full `npm test` suite (13 tests, all stacks) both pass with this
approach.
