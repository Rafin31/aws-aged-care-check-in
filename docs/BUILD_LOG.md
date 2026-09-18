# Build Log

Narrative record of what was built, why this approach over alternatives, and
what AWS concept it demonstrates. One dated entry per push. Raw material for
the eventual portfolio write-up (Phase 12).

## 2026-08-26 — Phase 1: AWS account foundation

**What was built:** Root account MFA (authenticator app), IAM user
`rafin-admin` in a new `admins` group (`AdministratorAccess` policy attached
to the group, not the user), AWS CLI v2 + `uv` installed locally with a
named profile (`aged-care-check-in`, `ap-southeast-2`) authenticated via
`aws login` browser flow, Bedrock model access confirmed (AWS auto-enables
serverless foundation models on first invoke now — no manual toggle step
exists any more), and a CloudWatch billing alarm (`billing-alarm-5usd`,
threshold >$5, email via SNS topic `billing-alarm-topic`) in `us-east-1`.

**Why this approach:**
- Group-based IAM (`admins` group holding the policy) instead of attaching
  `AdministratorAccess` directly to the user — policy is reusable for any
  future user without re-attaching, standard AWS best practice over
  per-user policy sprawl.
- Root MFA + a separate daily-driver IAM user, rather than using root
  credentials day to day — root has no permission ceiling, so a compromised
  root session is total account loss; an IAM user's blast radius is bounded
  by its policy.
- Billing alarm deliberately created in `us-east-1` even though the
  project's resources live in `ap-southeast-2` — the `EstimatedCharges`
  CloudWatch metric only ever publishes in `us-east-1`, regardless of where
  other resources run.

**AWS concepts demonstrated:** IAM users/groups/policies vs. root account
separation, MFA as an account-level control, CloudWatch billing alarms +
SNS notification topics, Bedrock's shift to zero-touch serverless model
access.

**Push:** `docs: mark Phase 1 AWS account foundation complete` (1c359f4)

## 2026-08-28 — Phase 3: design system wiring

**What was built:** Design tokens from `docs/design/DESIGN_SYSTEM.md` wired
into `web/src/app/globals.css` as the single tokens file (Tailwind v4
`@theme`/`:root`/`.dark` — no `tailwind.config.ts` exists on this shadcn
scaffold, so the CSS file is the mechanism). Replaced the scaffold's
generic neutral/oklch palette and Geist fonts with the sage/teal/ink/
accent/signal-alert palette and Fraunces (display)/Inter (body)/IBM Plex
Mono (data) fonts. Added a dark palette in the same file's `.dark` block —
same hue family, prepared for a future theme toggle, not activated yet. A
throwaway proof page (swatches, type samples, vitals-strip card mocks,
focus ring, dark-mode preview) confirmed the tokens render correctly, then
was deleted per the phase checklist.

**Why this approach:**
- CSS-file-as-tokens (not `tailwind.config.ts`) because the shadcn
  `base-nova` scaffold already generates Tailwind v4 `@theme inline` +
  `:root` blocks in `globals.css` with no config file — matching the
  existing mechanism instead of introducing a second one, per SOUL.md's
  single-tokens-file rule.
- shadcn's system var names (`--color-primary`, `--color-destructive`,
  etc.) kept as the Tailwind-facing layer, aliased to the design doc's own
  token names (`--bg`, `--primary`, `--signal-alert`, ...) — so `bg-primary`
  works in components while the doc's palette stays the single source
  underneath. `--destructive` and `--signal-alert` point at the same value
  since they mean the same thing in this product (real danger, never
  decorative).
- Dark palette added proactively (per Rafin's request) even though no
  toggle exists yet — same tokens file, same hue family, so activating a
  theme switch later is a mechanism change only, not a re-derivation of
  the palette.

**What it demonstrates:** Tailwind v4's CSS-native token model (`@theme`
inline mapping) vs. the older JS-config approach, and keeping a single
source of truth for design values across light/dark variants.

**Push:** `web: wire design system tokens, add dark palette`

## 2026-09-10 — Phase 6 (Tasks 4-7): callback-tokens table + first 3 lambdas

**What was built:** `CheckinWorkflowStack`'s `CallbackTokensTable`
(DynamoDB, PK=`callbackId`, TTL on `expiresAt`) — the bridge table that
lets an async AWS event (a call ending, a Transcribe job finishing) resume
the correct paused Step Functions execution. Plus the first three of six
check-in workflow lambdas, each with its own least-privilege IAM role and
a Zod schema at the input boundary: `start-checkin` (invokes Connect's
`StartOutboundVoiceContactCommand`), `call-completed` (called by the
contact flow when the call ends, resumes the first `waitForTaskToken`
pause via `SendTaskSuccess`), `register-transcription-callback` (stores
the second pause's task token, keyed by the Transcribe job name that will
eventually complete and call back).

**Why this approach:** Two separate `waitForTaskToken` pauses instead of
polling — Step Functions can freeze an execution indefinitely without
burning compute or Lambda invocations while waiting on a phone call or a
transcription job, and each pause's completion event is what actually
resumes it. `CallbackTokensTable` is deliberately separate from the
`CheckIns` history table (transient token bookkeeping vs. permanent
history — different access pattern, TTL'd so a stuck token from an
abandoned call can't accumulate forever).

**AWS concepts demonstrated:** Step Functions' task-token callback
pattern for long-running async work, DynamoDB TTL for self-cleaning
transient state, Zod validation at every Lambda boundary treating both
external events and the DynamoDB row as untrusted input.

**Push:** `feat: add register-transcription-callback lambda` (9af2bd8),
plus `033cdfc`, `ae76694`, `cf7d3b1`.

## 2026-09-18 — Phase 6 (Tasks 8-12): remaining lambdas + state machine wiring

**What was built:** The last three lambdas —
`transcribe-completed` (fetches the Transcribe output JSON from S3, pulls
the plain-text transcript, resumes the second pause), `analyze-response`
(first real Bedrock usage — Claude Haiku 4.5, prompted for structured JSON
distress/sentiment analysis, validated with Zod before trusting any field
of the model's reply), `send-alert` (publishes to SNS, email-only). Then
`checkin-workflow-stack.ts`'s full Step Functions state machine wiring all
six lambdas + the raw `StartTranscriptionJob`/`WriteCheckinResult` SDK
calls into one chain, ending in a `Choice` state that routes to
`send-alert` when `distressDetected` is true or the person didn't respond
at all, otherwise straight to logging the result.

**Why this approach:**
- `analyze-response`'s system prompt lives in its own `prompt.ts` file
  (not inlined in the handler) so wording can be tuned without touching
  invocation logic — added after Rafin asked for the no-answer and
  non-verbal-distress (moaning/groaning) cases to be handled explicitly
  rather than left to the model's default judgment.
- Claude 3 Haiku (the originally-planned model) was retired from the
  Bedrock catalog between the Sept 6 plan and this build — switched to
  Claude Haiku 4.5's cross-region inference profile instead, full
  reasoning in
  [`docs/decisions/0001-bedrock-model-haiku-4-5-cross-region.md`](decisions/0001-bedrock-model-haiku-4-5-cross-region.md).
- The Transcribe job's S3 access uses `CallAwsService`'s
  `additionalIamStatements` rather than the plan's placeholder grant call,
  which doesn't exist on that construct — see
  `docs/TROUBLESHOOTING.md`.

**AWS concepts demonstrated:** Amazon Bedrock's `InvokeModel` API and
cross-region inference profiles, Step Functions `Choice` states for
branching business logic, least-privilege IAM scoped per Lambda (no shared
roles), treating a foundation model's output as untrusted input requiring
runtime validation just like any external API response.

**Push:** not yet pushed — commits so far: `ad46d85`, `4f4aafa`, `4e06d5f`,
`db95169`, plus the state machine wiring commit pending as of this entry.
