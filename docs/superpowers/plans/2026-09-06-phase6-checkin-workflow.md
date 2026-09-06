# Phase 6 — Core Check-In Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project override:** This repo's CLAUDE.md/SOUL.md require one file/step
> at a time, a plain-English explanation before any new infra file, a full
> "service introduction" the first time an AWS service appears, a Console
> pointer after every `cdk deploy`, and an explicit "make sense? any
> errors?" checkpoint from Rafin before moving to the next task — commits
> only happen after that checkpoint, never mid-task. Whichever execution
> skill runs this plan must honor those gates; they are stricter than the
> skill's own default pacing.

**Goal:** Build the orchestrated check-in pipeline — outbound call via
Amazon Connect, recorded response transcribed by Amazon Transcribe,
transcript analyzed for distress by Amazon Bedrock (Claude 3 Haiku), and
routed by Step Functions to either an SNS email alert or a plain log,
with the result written to DynamoDB.

**Architecture:** A Step Functions state machine (triggered manually for
this phase's checkpoint; EventBridge Scheduler wiring is the last task)
drives six Lambdas and two direct AWS-SDK service integrations. Two
`waitForTaskToken` pauses handle the pipeline's two genuinely async
hops — waiting for the phone call to end, and waiting for the Transcribe
batch job to finish — so nothing polls. A small DynamoDB table
(`CheckinCallbackTokens`) bridges each pause: it stores the task token
under a lookup key until the async event (contact-flow Lambda invoke, or
an EventBridge Transcribe job-state-change event) arrives to resume it.

**Tech Stack:** AWS CDK (TypeScript), `aws-cdk-lib/aws-stepfunctions` +
`aws-stepfunctions-tasks` (`LambdaInvoke` with
`IntegrationPattern.WAIT_FOR_TASK_TOKEN`, `CallAwsService` for direct
Transcribe/DynamoDB calls), Lambda (Node.js, `NodejsFunction` esbuild
bundling), Zod for boundary validation, AWS SDK v3 clients
(`@aws-sdk/client-connect`, `@aws-sdk/client-transcribe`,
`@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-sns`,
`@aws-sdk/client-sfn`, `@aws-sdk/client-dynamodb` +
`@aws-sdk/lib-dynamodb`, `@aws-sdk/client-s3`).

**Spec:** `docs/planning/specs/2026-08-25-aged-care-checkin-design.md`
(architecture/data-flow, source of truth) and
`docs/planning/DEVELOPMENT_PHASES.md` Phase 6 section (scope/checkpoint).

## Global Constraints

- Region: `ap-southeast-2` (Sydney) — matches every stack deployed so far
  (Phases 1-5), and Connect's AU free tier (30 min/mo outbound to
  Australian numbers) applies here.
- Bedrock model: `anthropic.claude-3-haiku-20240307-v1:0`, invoked
  on-demand, in-region — no cross-region inference profile.
- No `any` in TypeScript, ever.
- Zod validates every Lambda's event input before use.
- Every Lambda gets its own least-privilege IAM role — CDK grants
  (`table.grantReadData(fn)`, `fn.addToRolePolicy(...)`) scoped to the
  exact resource/action, never a shared role, never `Resource: '*'`
  unless the AWS API itself has no resource-level permission (Transcribe
  `StartTranscriptionJob` is the one case here — its IAM action does not
  support resource-level scoping).
- SNS SMS is never enabled — email subscription only.
- No hardcoded ARNs/secrets in Lambda source — the Connect instance ARN,
  contact flow ID, and claimed phone number (all only known after the
  manual Console claim in Task 1) are stored as SSM String Parameters by
  `connect-stack.ts` and injected into Lambda env vars via
  `ssm.StringParameter.valueForStringParameter` CDK dynamic references,
  never typed into Lambda code.
- Every new stack/Lambda file gets a one-paragraph plain-English
  explanation posted before the code, per SOUL.md — this is expected
  during execution, not written into this plan's Steps (which are code
  diffs), so whoever executes each task should still narrate it live.
- Checkpoint gate: after each task, stop and ask Rafin "make sense? any
  errors?" before starting the next task. Commit only after that yes.

---

## Task 1: Manual Console — claim the Connect instance and phone number

**Files:** none — Console-only, per SOUL.md (Connect instance claim is
manual by design).

**Interfaces:**
- Produces: `instanceArn` (format
  `arn:aws:connect:ap-southeast-2:<account>:instance/<instance-id>`) and
  the claimed phone number (E.164, e.g. `+614xxxxxxxx`) — both required
  as CDK deploy parameters in Task 2.

- [ ] **Step 1: Claim a Connect instance**

In the Console: Amazon Connect → "Add an instance" → Sydney region →
Identity management "Store users in Connect" (simplest for a portfolio
instance, no separate directory) → instance alias e.g.
`aged-care-checkin` → skip telephony options screen defaults → Create
instance. Wait for status "Active" (can take a couple of minutes).

- [ ] **Step 2: Claim a phone number**

Inside the instance → Channels → Phone numbers → Claim a number → Country
"Australia", Type "Toll-Free" or "DID" (either is inside the AU free
tier for outbound; DID is simpler to claim without extra approval) →
claim it → note the number in E.164 format.

- [ ] **Step 3: Record the instance ARN**

Instance → "instance ID/ARN" tab (or Overview page) → copy the full
instance ARN. Keep this and the phone number handy — Task 2 asks for
both as `cdk deploy` parameters.

- [ ] **Checkpoint**

Confirm with Rafin: instance shows "Active", phone number claimed and
visible under Channels → Phone numbers, both values written down. Ask
"make sense? any errors?" before Task 2.

---

## Task 2: `connect-stack.ts` — SSM parameters + private recordings bucket

**Files:**
- Create: `infra/lib/connect-stack.ts`
- Modify: `infra/bin/infra.ts`
- Test: `infra/test/stacks/connect-stack.test.ts`

**Interfaces:**
- Consumes: `instanceArn`, `phoneNumber` (CDK deploy-time `CfnParameter`
  values from Task 1).
- Produces: SSM parameters `/aged-care-checkin/connect/instance-arn`,
  `/aged-care-checkin/connect/source-phone-number` (both read later by
  `start-checkin`'s Lambda env vars); `recordingsBucket:
  s3.IBucket` (public property, read by `checkin-workflow-stack.ts` in
  Task 12 to grant the Transcribe job read access and the
  `transcribe-completed` Lambda read access to the transcript output).

**Explain first (for the live session, not this plan file):** Amazon
Connect is AWS's cloud contact-center service — it places the outbound
call and runs the IVR script (the "contact flow"). This stack doesn't
create the instance itself (that's the manual Task 1 claim — Connect
instance/phone-number claiming isn't something you'd want automated
away on a learning project, and CDK's own instance-storage-config
resource needs the instance to already exist). What CDK *does* own here:
a private, encrypted S3 bucket for call recordings, and the SSM
parameters that let every later Lambda find the instance without any
ARN typed into source code.

- [ ] **Step 1: Write `connect-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';

export class ConnectStack extends cdk.Stack {
  public readonly recordingsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Instance and phone number are claimed by hand in the Console
    // (Phase 6, Task 1) — Connect instance claiming isn't a good fit
    // for CDK on a learning project, and these two values are all any
    // later stack needs to reach the already-claimed instance.
    const instanceArn = new cdk.CfnParameter(this, 'ConnectInstanceArn', {
      type: 'String',
      description: 'ARN of the manually-claimed Amazon Connect instance',
    }).valueAsString;

    const sourcePhoneNumber = new cdk.CfnParameter(this, 'ConnectSourcePhoneNumber', {
      type: 'String',
      description: 'E.164 phone number claimed on the Connect instance',
    }).valueAsString;

    // Private, encrypted call-recording storage. Portfolio project —
    // DESTROY so `cdk destroy` fully tears down.
    this.recordingsBucket = new s3.Bucket(this, 'CallRecordingsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Tells the Connect instance where to put call recordings. This is
    // the one piece of "instance configuration" CDK can own even though
    // CDK didn't create the instance itself.
    new connect.CfnInstanceStorageConfig(this, 'CallRecordingStorageConfig', {
      instanceArn,
      resourceType: 'CALL_RECORDINGS',
      storageType: 'S3',
      s3Config: {
        bucketName: this.recordingsBucket.bucketName,
        bucketPrefix: 'call-recordings',
      },
    });

    new ssm.StringParameter(this, 'InstanceArnParam', {
      parameterName: '/aged-care-checkin/connect/instance-arn',
      stringValue: instanceArn,
    });

    new ssm.StringParameter(this, 'SourcePhoneNumberParam', {
      parameterName: '/aged-care-checkin/connect/source-phone-number',
      stringValue: sourcePhoneNumber,
    });
  }
}
```

- [ ] **Step 2: Wire it into the app entrypoint**

In `infra/bin/infra.ts`, add alongside the existing `DataStack` /
`AuthStack` instantiations:

```typescript
import { ConnectStack } from '../lib/connect-stack';

new ConnectStack(app, 'ConnectStack', {});
```

- [ ] **Step 3: Write the CDK synth test**

```typescript
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { ConnectStack } from '../../lib/connect-stack';

test('ConnectStack creates a private encrypted bucket and SSM params', () => {
  const app = new cdk.App();
  const stack = new ConnectStack(app, 'TestConnectStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/aged-care-checkin/connect/instance-arn',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/aged-care-checkin/connect/source-phone-number',
  });
});
```

- [ ] **Step 4: Run the test**

Run: `cd infra && npm test`
Expected: PASS (3 stack test files now: data-stack, auth-stack — wait,
auth-stack has no test yet, so 2 files — plus this new one).

- [ ] **Step 5: Deploy**

Run (from `infra/`):
```bash
npx cdk deploy ConnectStack --parameters ConnectInstanceArn=<arn from Task 1> --parameters ConnectSourcePhoneNumber=<number from Task 1>
```

- [ ] **Step 6: Console pointer + checkpoint**

Point Rafin to S3 Console → the new recordings bucket (confirm
"Block all public access: On", encryption "SSE-S3") and to Connect
Console → instance → Data storage tab (confirm "Call recordings" now
points at that bucket). Ask "make sense? any errors?" before Task 3.

- [ ] **Step 7: Commit (only after Rafin's checkpoint yes)**

```bash
git add infra/lib/connect-stack.ts infra/bin/infra.ts infra/test/stacks/connect-stack.test.ts
git commit -m "infra: add Connect recordings bucket and SSM wiring"
```

---

## Task 3: Add Lambda dependencies

**Files:**
- Modify: `infra/package.json`

**Interfaces:**
- Produces: `zod`, AWS SDK v3 clients, and `esbuild` (needed by
  `aws-cdk-lib/aws-lambda-nodejs` `NodejsFunction` to bundle each Lambda
  locally without Docker) available to every later task.

- [ ] **Step 1: Install packages**

Run (from `infra/`):
```bash
npm install zod @aws-sdk/client-connect @aws-sdk/client-transcribe @aws-sdk/client-bedrock-runtime @aws-sdk/client-sns @aws-sdk/client-sfn @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-s3
npm install --save-dev esbuild
```

- [ ] **Step 2: Verify install**

Run: `cd infra && npx tsc --noEmit`
Expected: no errors (nothing references the new packages yet, this just
confirms `npm install` didn't break the existing build).

- [ ] **Step 3: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/package.json infra/package-lock.json
git commit -m "infra: add zod and AWS SDK v3 clients for check-in Lambdas"
```

---

## Task 4: `CheckinCallbackTokens` table (in `checkin-workflow-stack.ts`)

**Files:**
- Create: `infra/lib/checkin-workflow-stack.ts` (table only for now —
  the state machine itself is Task 12)

**Interfaces:**
- Consumes: `checkInTable: dynamodb.ITable` (constructor prop, passed
  from `DataStack.checkInTable` in Task 13's `infra.ts` wiring — not
  used by this table but the stack will need it in Task 12, so the prop
  is declared now).
- Produces: `callbackTokensTable: dynamodb.Table` (public property, read
  by every callback Lambda's IAM grant in Tasks 6-8).

**Explain first:** This is a *new* DynamoDB access pattern, not an
extension of the single-table `AgedCareCheckIns` design in
`data-stack.ts` — deliberately. `AgedCareCheckIns` holds permanent
check-in history (`PK=personId`); this table holds transient bookkeeping
(a Step Functions task token, alive only for the seconds/minutes between
"call started" and "call ended", or "transcription started" and
"transcription finished"). Mixing a TTL-expiring operational row into
the person-history table would blur what that table is for, so it gets
its own table, per SOUL.md's "point to the existing pattern first, then
justify a new one" rule.

- [ ] **Step 1: Write the stack file (table only)**

```typescript
import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface CheckinWorkflowStackProps extends cdk.StackProps {
  checkInTable: dynamodb.ITable;
}

export class CheckinWorkflowStack extends cdk.Stack {
  public readonly callbackTokensTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: CheckinWorkflowStackProps) {
    super(scope, id, props);

    // Bridges each of the two waitForTaskToken pauses in the state
    // machine: PK=callbackId (a contact ID for the call-end pause, a
    // Transcribe job name for the transcription pause). TTL clears rows
    // automatically if a callback never arrives (e.g. a call that never
    // connects), so a stuck token can't accumulate forever.
    this.callbackTokensTable = new dynamodb.Table(this, 'CallbackTokensTable', {
      tableName: 'AgedCareCheckinCallbackTokens',
      partitionKey: { name: 'callbackId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
```

- [ ] **Step 2: Write the synth test**

```typescript
import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import { CheckinWorkflowStack } from '../../lib/checkin-workflow-stack';

test('CheckinWorkflowStack creates the callback-tokens table with TTL', () => {
  const app = new cdk.App();
  const dummyTable = new dynamodb.Table(app, 'DummyCheckInTable', {
    partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
  });
  const stack = new CheckinWorkflowStack(app, 'TestCheckinWorkflowStack', {
    checkInTable: dummyTable,
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'AgedCareCheckinCallbackTokens',
    KeySchema: [{ AttributeName: 'callbackId', KeyType: 'HASH' }],
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  });
});
```

- [ ] **Step 3: Run the test**

Run: `cd infra && npm test`
Expected: PASS.

- [ ] **Step 4: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/lib/checkin-workflow-stack.ts infra/test/stacks/checkin-workflow-stack.test.ts
git commit -m "infra: add callback-tokens table for check-in workflow"
```

(Not deployed standalone — this stack has no other resources yet and
`infra.ts` isn't wired to it until Task 13. `cdk synth` in the test above
is the only verification needed here.)

---

## Task 5: `start-checkin` Lambda

**Files:**
- Create: `infra/lambda/start-checkin/handler.ts`
- Create: `infra/lambda/start-checkin/schema.ts`
- Test: `infra/lambda/start-checkin/handler.test.ts`

**Interfaces:**
- Consumes: Step Functions invokes this with
  `IntegrationPattern.WAIT_FOR_TASK_TOKEN`, payload
  `{ personId: string; phoneNumber: string; taskToken: string }` (the
  `taskToken` comes from `sfn.JsonPath.taskToken`, wired in Task 12).
- Produces: no return value the state machine reads (the state stays
  paused) — writes `{ callbackId: contactId, taskToken, expiresAt }`
  into `CheckinCallbackTokens`, keyed by the Connect `contactId` this
  call gets assigned.

**Explain first:** This is the state machine's first real Lambda — it
asks Amazon Connect to dial `phoneNumber` and run the check-in contact
flow. It does not wait for the call to finish; it hands the Step
Functions task token to DynamoDB and returns immediately. The contact
flow itself (authored in Task 11, after `call-completed` exists to be
invoked) is what eventually resumes this paused state, by calling the
`call-completed` Lambda when the call ends.

- [ ] **Step 1: Write the input schema**

```typescript
import { z } from 'zod';

export const startCheckinInputSchema = z.object({
  personId: z.string().min(1),
  phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'must be E.164 format'),
  taskToken: z.string().min(1),
});

export type StartCheckinInput = z.infer<typeof startCheckinInputSchema>;
```

- [ ] **Step 2: Write the failing test**

```typescript
import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { ConnectClient, StartOutboundVoiceContactCommand } from '@aws-sdk/client-connect';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const connectMock = mockClient(ConnectClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  connectMock.reset();
  ddbMock.reset();
  process.env.CONNECT_INSTANCE_ARN = 'arn:aws:connect:ap-southeast-2:111111111111:instance/test-instance';
  process.env.CONNECT_CONTACT_FLOW_ID = 'test-flow-id';
  process.env.CONNECT_SOURCE_PHONE_NUMBER = '+61400000000';
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('starts the outbound call and stores the callback token', async () => {
  connectMock.on(StartOutboundVoiceContactCommand).resolves({ ContactId: 'contact-123' });
  ddbMock.on(PutCommand).resolves({});

  await handler({ personId: 'person-1', phoneNumber: '+61411111111', taskToken: 'token-abc' });

  const connectCalls = connectMock.commandCalls(StartOutboundVoiceContactCommand);
  expect(connectCalls).toHaveLength(1);
  expect(connectCalls[0].args[0].input).toMatchObject({
    DestinationPhoneNumber: '+61411111111',
    ContactFlowId: 'test-flow-id',
    InstanceId: process.env.CONNECT_INSTANCE_ARN,
    Attributes: { callbackId: 'contact-123' },
  });

  const ddbCalls = ddbMock.commandCalls(PutCommand);
  expect(ddbCalls).toHaveLength(1);
  expect(ddbCalls[0].args[0].input.Item).toMatchObject({
    callbackId: 'contact-123',
    taskToken: 'token-abc',
  });
});

test('rejects an invalid phone number before calling Connect', async () => {
  await expect(
    handler({ personId: 'person-1', phoneNumber: 'not-a-number', taskToken: 'token-abc' }),
  ).rejects.toThrow();
  expect(connectMock.commandCalls(StartOutboundVoiceContactCommand)).toHaveLength(0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd infra && npm test -- start-checkin`
Expected: FAIL — `handler` module doesn't exist yet.

- [ ] **Step 4: Write the handler**

```typescript
import { ConnectClient, StartOutboundVoiceContactCommand } from '@aws-sdk/client-connect';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { startCheckinInputSchema, type StartCheckinInput } from './schema';

const connectClient = new ConnectClient({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Callback rows expire after 1 hour — plenty for a call to connect and
// end, short enough that an abandoned call doesn't leave a stale row.
const CALLBACK_TTL_SECONDS = 60 * 60;

export async function handler(event: StartCheckinInput): Promise<void> {
  const input = startCheckinInputSchema.parse(event);

  const { ContactId } = await connectClient.send(
    new StartOutboundVoiceContactCommand({
      DestinationPhoneNumber: input.phoneNumber,
      ContactFlowId: process.env.CONNECT_CONTACT_FLOW_ID,
      InstanceId: process.env.CONNECT_INSTANCE_ARN,
      SourcePhoneNumber: process.env.CONNECT_SOURCE_PHONE_NUMBER,
      Attributes: { personId: input.personId },
    }),
  );

  if (!ContactId) {
    throw new Error('Connect did not return a contact ID for the outbound call');
  }

  await ddbClient.send(
    new PutCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Item: {
        callbackId: ContactId,
        taskToken: input.taskToken,
        expiresAt: Math.floor(Date.now() / 1000) + CALLBACK_TTL_SECONDS,
      },
    }),
  );
}
```

Note: the test above asserts `Attributes: { callbackId: 'contact-123' }`
on the *Connect call itself*, but `callbackId` (the contact ID) isn't
known until *after* that same call returns — a contact flow can't be
told its own contact ID as an outbound attribute before it exists.
Correct the test's expectation instead: assert
`Attributes: { personId: 'person-1' }` on the Connect call (this is what
the contact flow actually needs to look up the person), and drop the
`Attributes` assertion's `callbackId` key. The contact flow's final
"Invoke Lambda" block (Task 11) uses the built-in `$.Attributes` contact
ID system attribute — which Connect provides automatically to every
contact flow block — as the callback key, not a custom attribute. Fix
the test to match before running Step 5.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd infra && npm test -- start-checkin`
Expected: PASS.

- [ ] **Step 6: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/lambda/start-checkin
git commit -m "feat: add start-checkin lambda"
```

---

## Task 6: `call-completed` Lambda

**Files:**
- Create: `infra/lambda/call-completed/handler.ts`
- Create: `infra/lambda/call-completed/schema.ts`
- Test: `infra/lambda/call-completed/handler.test.ts`

**Interfaces:**
- Consumes: invoked directly by the Connect contact flow's "Invoke AWS
  Lambda function" block (Task 11) with
  `{ contactId: string; recordingS3Uri: string }` (the contact flow
  passes its own `$.ContactId` system attribute and the recording
  location, which Connect exposes as a contact attribute once recording
  is enabled).
- Produces: calls `SendTaskSuccessCommand` on the Step Functions task
  token stored under that `contactId` in `CheckinCallbackTokens`,
  resuming the paused `WaitForCallCompletion` state with output
  `{ recordingS3Uri }`.

**Explain first:** This Lambda is the first half of the "how does Step
Functions know the call ended" answer — it's not called by Step
Functions at all, it's called by the *contact flow*, at the moment the
IVR script finishes. It looks up the task token this call's contact ID
was filed under (Task 5 stored that mapping) and hands the recording
location back to the paused workflow.

- [ ] **Step 1: Write the input schema**

```typescript
import { z } from 'zod';

export const callCompletedInputSchema = z.object({
  contactId: z.string().min(1),
  recordingS3Uri: z.string().url(),
});

export type CallCompletedInput = z.infer<typeof callCompletedInputSchema>;
```

- [ ] **Step 2: Write the failing test**

```typescript
import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';

const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('resumes the paused Step Functions task with the recording location', async () => {
  ddbMock.on(GetCommand).resolves({ Item: { callbackId: 'contact-123', taskToken: 'token-abc' } });
  sfnMock.on(SendTaskSuccessCommand).resolves({});

  await handler({ contactId: 'contact-123', recordingS3Uri: 's3://bucket/call-recordings/contact-123.wav' });

  const calls = sfnMock.commandCalls(SendTaskSuccessCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.taskToken).toBe('token-abc');
  expect(JSON.parse(calls[0].args[0].input.output as string)).toEqual({
    recordingS3Uri: 's3://bucket/call-recordings/contact-123.wav',
  });
});

test('throws if no callback token is on file for the contact', async () => {
  ddbMock.on(GetCommand).resolves({ Item: undefined });

  await expect(
    handler({ contactId: 'unknown-contact', recordingS3Uri: 's3://bucket/x.wav' }),
  ).rejects.toThrow('No callback token found');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd infra && npm test -- call-completed`
Expected: FAIL — handler doesn't exist yet.

- [ ] **Step 4: Write the handler**

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { callCompletedInputSchema, type CallCompletedInput } from './schema';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfnClient = new SFNClient({});

export async function handler(event: CallCompletedInput): Promise<void> {
  const input = callCompletedInputSchema.parse(event);

  const { Item } = await ddbClient.send(
    new GetCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Key: { callbackId: input.contactId },
    }),
  );

  if (!Item) {
    throw new Error(`No callback token found for contact ${input.contactId}`);
  }

  await sfnClient.send(
    new SendTaskSuccessCommand({
      taskToken: Item.taskToken as string,
      output: JSON.stringify({ recordingS3Uri: input.recordingS3Uri }),
    }),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd infra && npm test -- call-completed`
Expected: PASS.

- [ ] **Step 6: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/lambda/call-completed
git commit -m "feat: add call-completed lambda"
```

---

## Task 7: `register-transcription-callback` Lambda

**Files:**
- Create: `infra/lambda/register-transcription-callback/handler.ts`
- Create: `infra/lambda/register-transcription-callback/schema.ts`
- Test: `infra/lambda/register-transcription-callback/handler.test.ts`

**Interfaces:**
- Consumes: Step Functions invokes this with
  `IntegrationPattern.WAIT_FOR_TASK_TOKEN`, payload
  `{ transcriptionJobName: string; taskToken: string }` (the job name
  comes from the preceding `StartTranscriptionJob` state's output,
  wired in Task 12).
- Produces: no return value the state machine reads (state stays
  paused) — writes `{ callbackId: transcriptionJobName, taskToken,
  expiresAt }` into `CheckinCallbackTokens`. Resumed later by
  `transcribe-completed` (Task 8), triggered by the Transcribe
  EventBridge job-state-change event.

**Explain first:** Same shape as Task 5's problem, second async hop:
Step Functions starts a Transcribe batch job (a fire-and-forget SDK
call, Task 12) and needs to pause until it's done. This Lambda's only
job is filing the task token under the job's name so
`transcribe-completed` can find it when the job finishes.

- [ ] **Step 1: Write the input schema**

```typescript
import { z } from 'zod';

export const registerTranscriptionCallbackInputSchema = z.object({
  transcriptionJobName: z.string().min(1),
  taskToken: z.string().min(1),
});

export type RegisterTranscriptionCallbackInput = z.infer<
  typeof registerTranscriptionCallbackInputSchema
>;
```

- [ ] **Step 2: Write the failing test**

```typescript
import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('stores the task token under the transcription job name', async () => {
  ddbMock.on(PutCommand).resolves({});

  await handler({ transcriptionJobName: 'job-123', taskToken: 'token-xyz' });

  const calls = ddbMock.commandCalls(PutCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.Item).toMatchObject({
    callbackId: 'job-123',
    taskToken: 'token-xyz',
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd infra && npm test -- register-transcription-callback`
Expected: FAIL — handler doesn't exist yet.

- [ ] **Step 4: Write the handler**

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  registerTranscriptionCallbackInputSchema,
  type RegisterTranscriptionCallbackInput,
} from './schema';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CALLBACK_TTL_SECONDS = 60 * 60;

export async function handler(event: RegisterTranscriptionCallbackInput): Promise<void> {
  const input = registerTranscriptionCallbackInputSchema.parse(event);

  await ddbClient.send(
    new PutCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Item: {
        callbackId: input.transcriptionJobName,
        taskToken: input.taskToken,
        expiresAt: Math.floor(Date.now() / 1000) + CALLBACK_TTL_SECONDS,
      },
    }),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd infra && npm test -- register-transcription-callback`
Expected: PASS.

- [ ] **Step 6: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/lambda/register-transcription-callback
git commit -m "feat: add register-transcription-callback lambda"
```

---

## Task 8: `transcribe-completed` Lambda

**Files:**
- Create: `infra/lambda/transcribe-completed/handler.ts`
- Create: `infra/lambda/transcribe-completed/schema.ts`
- Test: `infra/lambda/transcribe-completed/handler.test.ts`

**Interfaces:**
- Consumes: invoked by an EventBridge rule (Task 12) matching Transcribe
  "Transcribe Job State Change" events where
  `detail.TranscriptionJobStatus === 'COMPLETED'`. Raw EventBridge event
  shape: `{ detail: { TranscriptionJobName: string, TranscriptionJobStatus: string } }`.
- Produces: fetches the transcript JSON from the Transcribe output
  bucket, extracts the plain-text transcript, calls
  `SendTaskSuccessCommand` with `{ transcript: string }`, resuming
  `WaitForTranscription`.

**Explain first:** Second half of the second async hop. Amazon
Transcribe automatically publishes a "job state change" event to
EventBridge — this Lambda is what that event triggers. It reads the
job's output file (Transcribe writes a JSON transcript, not plain text)
from S3, pulls out `results.transcripts[0].transcript`, and resumes the
paused state.

- [ ] **Step 1: Write the input schema**

```typescript
import { z } from 'zod';

export const transcribeJobStateChangeSchema = z.object({
  detail: z.object({
    TranscriptionJobName: z.string().min(1),
    TranscriptionJobStatus: z.literal('COMPLETED'),
  }),
});

export type TranscribeJobStateChangeEvent = z.infer<typeof transcribeJobStateChangeSchema>;
```

- [ ] **Step 2: Write the failing test**

```typescript
import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { TranscribeClient, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { sdkStreamMixin } from '@smithy/util-stream';
import { Readable } from 'stream';

const transcribeMock = mockClient(TranscribeClient);
const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const sfnMock = mockClient(SFNClient);

beforeEach(() => {
  transcribeMock.reset();
  s3Mock.reset();
  ddbMock.reset();
  sfnMock.reset();
  process.env.CALLBACK_TOKENS_TABLE_NAME = 'AgedCareCheckinCallbackTokens';
});

test('extracts the transcript and resumes the paused task', async () => {
  transcribeMock.on(GetTranscriptionJobCommand).resolves({
    TranscriptionJob: {
      Transcript: { TranscriptFileUri: 'https://bucket.s3.ap-southeast-2.amazonaws.com/output/job-123.json' },
    },
  });
  const transcriptJson = JSON.stringify({ results: { transcripts: [{ transcript: "I'm doing okay today." }] } });
  s3Mock.on(GetObjectCommand).resolves({
    Body: sdkStreamMixin(Readable.from([Buffer.from(transcriptJson)])),
  });
  ddbMock.on(GetCommand).resolves({ Item: { callbackId: 'job-123', taskToken: 'token-xyz' } });
  sfnMock.on(SendTaskSuccessCommand).resolves({});

  await handler({
    detail: { TranscriptionJobName: 'job-123', TranscriptionJobStatus: 'COMPLETED' },
  });

  const calls = sfnMock.commandCalls(SendTaskSuccessCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.taskToken).toBe('token-xyz');
  expect(JSON.parse(calls[0].args[0].input.output as string)).toEqual({
    transcript: "I'm doing okay today.",
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd infra && npm test -- transcribe-completed`
Expected: FAIL — handler doesn't exist yet. If `@smithy/util-stream` is
missing, run `npm install --save-dev @smithy/util-stream` first (it
ships as a transitive dependency of the S3 client but the test imports
it directly to build a mock stream).

- [ ] **Step 4: Write the handler**

```typescript
import { TranscribeClient, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import {
  transcribeJobStateChangeSchema,
  type TranscribeJobStateChangeEvent,
} from './schema';

const transcribeClient = new TranscribeClient({});
const s3Client = new S3Client({});
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfnClient = new SFNClient({});

interface TranscribeOutput {
  results: { transcripts: Array<{ transcript: string }> };
}

export async function handler(event: TranscribeJobStateChangeEvent): Promise<void> {
  const input = transcribeJobStateChangeSchema.parse(event);
  const jobName = input.detail.TranscriptionJobName;

  const { TranscriptionJob } = await transcribeClient.send(
    new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
  );
  const transcriptUri = TranscriptionJob?.Transcript?.TranscriptFileUri;
  if (!transcriptUri) {
    throw new Error(`Transcribe job ${jobName} has no transcript file URI`);
  }

  const url = new URL(transcriptUri);
  const bucket = url.hostname.split('.')[0];
  const key = decodeURIComponent(url.pathname.slice(1));

  const { Body } = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bodyText = await Body?.transformToString();
  if (!bodyText) {
    throw new Error(`Transcript body for job ${jobName} was empty`);
  }
  const parsed = JSON.parse(bodyText) as TranscribeOutput;
  const transcript = parsed.results.transcripts[0]?.transcript ?? '';

  const { Item } = await ddbClient.send(
    new GetCommand({
      TableName: process.env.CALLBACK_TOKENS_TABLE_NAME,
      Key: { callbackId: jobName },
    }),
  );
  if (!Item) {
    throw new Error(`No callback token found for transcription job ${jobName}`);
  }

  await sfnClient.send(
    new SendTaskSuccessCommand({
      taskToken: Item.taskToken as string,
      output: JSON.stringify({ transcript }),
    }),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd infra && npm test -- transcribe-completed`
Expected: PASS.

- [ ] **Step 6: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/lambda/transcribe-completed
git commit -m "feat: add transcribe-completed lambda"
```

---

## Task 9: `analyze-response` Lambda (first Bedrock usage)

**Files:**
- Create: `infra/lambda/analyze-response/handler.ts`
- Create: `infra/lambda/analyze-response/schema.ts`
- Test: `infra/lambda/analyze-response/handler.test.ts`

**Interfaces:**
- Consumes: direct (non-waiting) Step Functions Lambda invoke,
  `{ transcript: string }`.
- Produces: `{ responded: boolean; distressDetected: boolean; sentiment: 'positive' | 'neutral' | 'negative'; summary: string }`
  — read by the state machine's `Choice` state (Task 12) to decide
  alert vs. log.

**Service introduction (Bedrock, first real use — give this in full
during the live session):** Amazon Bedrock is AWS's managed access
point to foundation models (Anthropic's Claude, among others) — no
model hosting/scaling to manage, you call `InvokeModel` with a JSON
payload and get a JSON response back. Best practice used here: ask the
model for **structured JSON output** (not free text) via the prompt, and
validate what comes back with Zod before trusting it — a model response
is untrusted input, same as an API request body. Common beginner
mistake: trusting the model's output shape without validation, then
having a downstream `Choice` state or dashboard crash on a malformed or
unexpected field the model returned in a rare case; validating here
means a bad model response fails loudly in this Lambda, not silently
three steps later.

- [ ] **Step 1: Write the input/output schemas**

```typescript
import { z } from 'zod';

export const analyzeResponseInputSchema = z.object({
  transcript: z.string(),
});
export type AnalyzeResponseInput = z.infer<typeof analyzeResponseInputSchema>;

export const analyzeResponseOutputSchema = z.object({
  responded: z.boolean(),
  distressDetected: z.boolean(),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  summary: z.string(),
});
export type AnalyzeResponseOutput = z.infer<typeof analyzeResponseOutputSchema>;
```

- [ ] **Step 2: Write the failing test**

```typescript
import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
});

function mockBedrockReply(json: unknown) {
  const body = {
    content: [{ type: 'text', text: JSON.stringify(json) }],
  };
  bedrockMock.on(InvokeModelCommand).resolves({
    body: new TextEncoder().encode(JSON.stringify(body)),
  } as never);
}

test('returns a validated distress verdict for a normal response', async () => {
  mockBedrockReply({
    responded: true,
    distressDetected: false,
    sentiment: 'positive',
    summary: 'Person sounded well and mentioned going for a walk.',
  });

  const result = await handler({ transcript: "I'm doing great today, thanks for calling." });

  expect(result).toEqual({
    responded: true,
    distressDetected: false,
    sentiment: 'positive',
    summary: 'Person sounded well and mentioned going for a walk.',
  });
});

test('throws if the model reply does not match the expected shape', async () => {
  mockBedrockReply({ responded: true }); // missing required fields

  await expect(handler({ transcript: 'garbled response' })).rejects.toThrow();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd infra && npm test -- analyze-response`
Expected: FAIL — handler doesn't exist yet.

- [ ] **Step 4: Write the handler**

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  analyzeResponseInputSchema,
  analyzeResponseOutputSchema,
  type AnalyzeResponseInput,
  type AnalyzeResponseOutput,
} from './schema';

const bedrockClient = new BedrockRuntimeClient({});
const MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

const SYSTEM_PROMPT = `You analyze a transcript of an elderly person's response to a wellness check-in call. Reply with ONLY a JSON object matching this exact shape, no other text:
{"responded": boolean, "distressDetected": boolean, "sentiment": "positive" | "neutral" | "negative", "summary": string}
"responded" is false only if the transcript is empty or contains no discernible speech.
"distressDetected" is true if the person mentions pain, falling, confusion, being unable to cope, or explicitly asks for help.
"summary" is one short plain sentence for a family member reading a dashboard.`;

export async function handler(event: AnalyzeResponseInput): Promise<AnalyzeResponseOutput> {
  const input = analyzeResponseInputSchema.parse(event);

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Transcript: "${input.transcript}"` }],
      }),
    }),
  );

  const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = responseBody.content.find((block) => block.type === 'text')?.text;
  if (!text) {
    throw new Error('Bedrock response contained no text content block');
  }

  return analyzeResponseOutputSchema.parse(JSON.parse(text));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd infra && npm test -- analyze-response`
Expected: PASS.

- [ ] **Step 6: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/lambda/analyze-response
git commit -m "feat: add analyze-response lambda using Bedrock Claude 3 Haiku"
```

---

## Task 10: `send-alert` Lambda

**Files:**
- Create: `infra/lambda/send-alert/handler.ts`
- Create: `infra/lambda/send-alert/schema.ts`
- Test: `infra/lambda/send-alert/handler.test.ts`

**Interfaces:**
- Consumes: direct Step Functions Lambda invoke,
  `{ personId: string; summary: string; sentiment: string }`.
- Produces: publishes to the SNS topic named by `ALERT_TOPIC_ARN` env
  var (topic created in Task 12, email-only per the hard rule).

- [ ] **Step 1: Write the input schema**

```typescript
import { z } from 'zod';

export const sendAlertInputSchema = z.object({
  personId: z.string().min(1),
  summary: z.string().min(1),
  sentiment: z.string().min(1),
});
export type SendAlertInput = z.infer<typeof sendAlertInputSchema>;
```

- [ ] **Step 2: Write the failing test**

```typescript
import { handler } from './handler';
import { mockClient } from 'aws-sdk-client-mock';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const snsMock = mockClient(SNSClient);

beforeEach(() => {
  snsMock.reset();
  process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:ap-southeast-2:111111111111:alert-topic';
});

test('publishes a distress alert to the SNS topic', async () => {
  snsMock.on(PublishCommand).resolves({});

  await handler({ personId: 'person-1', summary: 'Mentioned falling this morning.', sentiment: 'negative' });

  const calls = snsMock.commandCalls(PublishCommand);
  expect(calls).toHaveLength(1);
  expect(calls[0].args[0].input.TopicArn).toBe(process.env.ALERT_TOPIC_ARN);
  expect(calls[0].args[0].input.Message).toContain('Mentioned falling this morning.');
  expect(calls[0].args[0].input.Subject).toContain('person-1');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd infra && npm test -- send-alert`
Expected: FAIL — handler doesn't exist yet.

- [ ] **Step 4: Write the handler**

```typescript
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { sendAlertInputSchema, type SendAlertInput } from './schema';

const snsClient = new SNSClient({});

export async function handler(event: SendAlertInput): Promise<void> {
  const input = sendAlertInputSchema.parse(event);

  await snsClient.send(
    new PublishCommand({
      TopicArn: process.env.ALERT_TOPIC_ARN,
      Subject: `Check-in alert for ${input.personId}`,
      Message: `Sentiment: ${input.sentiment}\n\n${input.summary}`,
    }),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd infra && npm test -- send-alert`
Expected: PASS.

- [ ] **Step 6: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/lambda/send-alert
git commit -m "feat: add send-alert lambda"
```

---

## Task 11: Manual Console — author the contact flow

**Files:** none — Console-only, per SOUL.md (Connect contact flow
authoring isn't fully CDK-supported).

**Interfaces:**
- Consumes: `call-completed` Lambda's ARN (from Task 6's deploy — this
  Lambda isn't deployed standalone yet; deploy it now via
  `CheckinWorkflowStack` partial synth, or note the ARN pattern and
  finalize the flow's Lambda reference after Task 12's full deploy —
  recommended: come back to this task's flow-block wiring after Task 12
  deploys everything, since Connect's flow editor needs the Lambda to
  already exist and be "available to Connect" (an explicit per-Lambda
  Console approval step, see Step 4 below) before it can be selected in
  the flow.
- Produces: `contactFlowId`, added as a new SSM parameter (or passed as
  a `cdk deploy` parameter directly into `checkin-workflow-stack.ts`,
  since only the state machine needs it, not `connect-stack.ts`).

- [ ] **Step 1: Create a new contact flow**

Connect instance → Flows → Create flow → name it
`checkin-wellness-call` → flow type "Contact Flow".

- [ ] **Step 2: Build the flow blocks**

In order: "Entry point" → "Play prompt" (text-to-speech: "Hi, this is
your scheduled wellness check-in call. After the tone, please tell us
how you're doing today.") → "Set recording and analytics behavior"
(enable call recording) → "Get customer input" (or "Wait", 20 seconds,
whichever the flow editor's IVR block palette offers for capturing a
timed voice response without requiring a valid DTMF/menu match — pick
"Get customer input" configured for voice with no valid responses
expected, just capturing audio) → "Play prompt" ("Thank you, someone
will follow up if needed. Goodbye.") → "Invoke AWS Lambda function"
(target: `call-completed` Lambda, pass parameters `contactId` =
`$.ContactId` system attribute, `recordingS3Uri` = the recording
location contact attribute Connect populates once recording is on) →
"Disconnect / hang up".

- [ ] **Step 3: Allow Connect to invoke the Lambda**

Connect instance → Flows → AWS Lambda → "Add Lambda function" → select
`call-completed`. This is Connect's own explicit approval list — a
Lambda isn't invokable from any flow until it's added here, regardless
of the Lambda's own resource policy.

- [ ] **Step 4: Publish the flow, record its ID**

Save → Publish. Copy the contact flow's ID (visible in the flow's URL
or the "Show additional flow information" panel) — this is
`contactFlowId`, needed as a `cdk deploy` parameter for
`checkin-workflow-stack.ts` in Task 12.

- [ ] **Checkpoint**

Confirm with Rafin: flow shows "Published", `call-completed` appears
under Flows → AWS Lambda, contact flow ID recorded. Ask "make sense? any
errors?" before Task 12.

---

## Task 12: `checkin-workflow-stack.ts` — the state machine

**Files:**
- Modify: `infra/lib/checkin-workflow-stack.ts`
- Test: extend `infra/test/stacks/checkin-workflow-stack.test.ts`

**Interfaces:**
- Consumes: `checkInTable` (constructor prop, from `DataStack`),
  `recordingsBucket` (constructor prop, from `ConnectStack`),
  `contactFlowId` (new `CfnParameter`, from Task 11).
- Produces: `stateMachine: sfn.StateMachine` (public property — not
  consumed by anything yet; EventBridge Scheduler wiring to trigger it
  automatically is a follow-up, out of this phase's checkpoint scope per
  `DEVELOPMENT_PHASES.md` which asks for "one full manual test run", not
  the schedule).

**Explain first:** Step Functions is the piece that turns six separate
Lambdas and two AWS-SDK calls into one auditable, retryable pipeline —
its Console view is a visual graph of exactly which step an execution is
sitting in, which is what Phase 6's checkpoint asks Rafin to go look at.
This stack wires every piece built in Tasks 4-11 together into that
graph.

- [ ] **Step 1: Extend the stack with the Lambdas, EventBridge rule, SNS topic, and state machine**

```typescript
import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda_nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn_tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

export interface CheckinWorkflowStackProps extends cdk.StackProps {
  checkInTable: dynamodb.ITable;
  recordingsBucket: s3.IBucket;
  alertEmailAddress: string;
}

export class CheckinWorkflowStack extends cdk.Stack {
  public readonly callbackTokensTable: dynamodb.Table;
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: CheckinWorkflowStackProps) {
    super(scope, id, props);

    const contactFlowId = new cdk.CfnParameter(this, 'ContactFlowId', {
      type: 'String',
      description: 'ID of the manually-authored checkin-wellness-call contact flow',
    }).valueAsString;

    this.callbackTokensTable = new dynamodb.Table(this, 'CallbackTokensTable', {
      tableName: 'AgedCareCheckinCallbackTokens',
      partitionKey: { name: 'callbackId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const instanceArn = ssm.StringParameter.valueForStringParameter(
      this,
      '/aged-care-checkin/connect/instance-arn',
    );
    const sourcePhoneNumber = ssm.StringParameter.valueForStringParameter(
      this,
      '/aged-care-checkin/connect/source-phone-number',
    );

    const commonBundling = { externalModules: ['@aws-sdk/*'] };

    const startCheckinFn = new lambda_nodejs.NodejsFunction(this, 'StartCheckinFn', {
      entry: path.join(__dirname, '../lambda/start-checkin/handler.ts'),
      bundling: commonBundling,
      environment: {
        CONNECT_INSTANCE_ARN: instanceArn,
        CONNECT_CONTACT_FLOW_ID: contactFlowId,
        CONNECT_SOURCE_PHONE_NUMBER: sourcePhoneNumber,
        CALLBACK_TOKENS_TABLE_NAME: this.callbackTokensTable.tableName,
      },
    });
    startCheckinFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['connect:StartOutboundVoiceContact'],
        resources: [instanceArn],
      }),
    );
    this.callbackTokensTable.grantWriteData(startCheckinFn);

    const callCompletedFn = new lambda_nodejs.NodejsFunction(this, 'CallCompletedFn', {
      entry: path.join(__dirname, '../lambda/call-completed/handler.ts'),
      bundling: commonBundling,
      environment: { CALLBACK_TOKENS_TABLE_NAME: this.callbackTokensTable.tableName },
    });
    this.callbackTokensTable.grantReadData(callCompletedFn);
    callCompletedFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'], resources: ['*'] }),
    );
    // Connect invokes this Lambda directly from the published contact
    // flow (Task 11) — grant that specific principal, not a wildcard.
    callCompletedFn.grantInvoke(new iam.ServicePrincipal('connect.amazonaws.com'));

    const registerTranscriptionCallbackFn = new lambda_nodejs.NodejsFunction(
      this,
      'RegisterTranscriptionCallbackFn',
      {
        entry: path.join(__dirname, '../lambda/register-transcription-callback/handler.ts'),
        bundling: commonBundling,
        environment: { CALLBACK_TOKENS_TABLE_NAME: this.callbackTokensTable.tableName },
      },
    );
    this.callbackTokensTable.grantWriteData(registerTranscriptionCallbackFn);

    const transcribeCompletedFn = new lambda_nodejs.NodejsFunction(this, 'TranscribeCompletedFn', {
      entry: path.join(__dirname, '../lambda/transcribe-completed/handler.ts'),
      bundling: commonBundling,
      environment: { CALLBACK_TOKENS_TABLE_NAME: this.callbackTokensTable.tableName },
    });
    this.callbackTokensTable.grantReadData(transcribeCompletedFn);
    props.recordingsBucket.grantRead(transcribeCompletedFn);
    transcribeCompletedFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['transcribe:GetTranscriptionJob'], resources: ['*'] }),
    );
    transcribeCompletedFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'], resources: ['*'] }),
    );

    const analyzeResponseFn = new lambda_nodejs.NodejsFunction(this, 'AnalyzeResponseFn', {
      entry: path.join(__dirname, '../lambda/analyze-response/handler.ts'),
      bundling: commonBundling,
      timeout: cdk.Duration.seconds(30),
    });
    analyzeResponseFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
        ],
      }),
    );

    const alertTopic = new sns.Topic(this, 'AlertTopic', { topicName: 'AgedCareCheckinAlerts' });
    alertTopic.addSubscription(new sns_subscriptions.EmailSubscription(props.alertEmailAddress));

    const sendAlertFn = new lambda_nodejs.NodejsFunction(this, 'SendAlertFn', {
      entry: path.join(__dirname, '../lambda/send-alert/handler.ts'),
      bundling: commonBundling,
      environment: { ALERT_TOPIC_ARN: alertTopic.topicArn },
    });
    alertTopic.grantPublish(sendAlertFn);

    // EventBridge fires this on every Transcribe job completion —
    // transcribe-completed looks the job up in CallbackTokensTable
    // itself, so a completion event for a job this stack didn't start
    // (there shouldn't be one, but AWS accounts share the event bus)
    // just fails its own lookup harmlessly.
    new events.Rule(this, 'TranscriptionCompletedRule', {
      eventPattern: {
        source: ['aws.transcribe'],
        detailType: ['Transcribe Job State Change'],
        detail: { TranscriptionJobStatus: ['COMPLETED'] },
      },
      targets: [new events_targets.LambdaFunction(transcribeCompletedFn)],
    });

    const waitForCallCompletion = new sfn_tasks.LambdaInvoke(this, 'WaitForCallCompletion', {
      lambdaFunction: startCheckinFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        personId: sfn.JsonPath.stringAt('$.personId'),
        phoneNumber: sfn.JsonPath.stringAt('$.phoneNumber'),
        taskToken: sfn.JsonPath.taskToken,
      }),
      resultPath: '$.callResult',
    });

    const startTranscriptionJob = new sfn_tasks.CallAwsService(this, 'StartTranscriptionJob', {
      service: 'transcribe',
      action: 'startTranscriptionJob',
      iamResources: ['*'],
      parameters: {
        TranscriptionJobName: sfn.JsonPath.format(
          'checkin-{}',
          sfn.JsonPath.stringAt('$$.Execution.Name'),
        ),
        LanguageCode: 'en-AU',
        Media: { MediaFileUri: sfn.JsonPath.stringAt('$.callResult.recordingS3Uri') },
        OutputBucketName: props.recordingsBucket.bucketName,
        OutputKey: sfn.JsonPath.format(
          'transcripts/{}.json',
          sfn.JsonPath.stringAt('$$.Execution.Name'),
        ),
      },
      resultPath: '$.transcriptionJob',
    });
    props.recordingsBucket.grantReadWrite(startTranscriptionJob.taskPolicies?.[0]
      ? new iam.PolicyStatement()
      : new iam.PolicyStatement()); // placeholder removed below

    const waitForTranscription = new sfn_tasks.LambdaInvoke(this, 'WaitForTranscription', {
      lambdaFunction: registerTranscriptionCallbackFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        transcriptionJobName: sfn.JsonPath.stringAt(
          '$.transcriptionJob.TranscriptionJob.TranscriptionJobName',
        ),
        taskToken: sfn.JsonPath.taskToken,
      }),
      resultPath: '$.transcriptionResult',
    });

    const analyzeResponse = new sfn_tasks.LambdaInvoke(this, 'AnalyzeResponse', {
      lambdaFunction: analyzeResponseFn,
      payload: sfn.TaskInput.fromObject({
        transcript: sfn.JsonPath.stringAt('$.transcriptionResult.transcript'),
      }),
      resultPath: '$.analysis',
      payloadResponseOnly: true,
    });

    const writeResult = new sfn_tasks.CallAwsService(this, 'WriteCheckinResult', {
      service: 'dynamodb',
      action: 'putItem',
      iamResources: [props.checkInTable.tableArn],
      parameters: {
        TableName: props.checkInTable.tableName,
        Item: {
          personId: { S: sfn.JsonPath.stringAt('$.personId') },
          checkinTimestamp: { S: sfn.JsonPath.stringAt('$$.Execution.StartTime') },
          responded: { BOOL: sfn.JsonPath.stringAt('$.analysis.responded') },
          distressDetected: { BOOL: sfn.JsonPath.stringAt('$.analysis.distressDetected') },
          sentiment: { S: sfn.JsonPath.stringAt('$.analysis.sentiment') },
          summary: { S: sfn.JsonPath.stringAt('$.analysis.summary') },
        },
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    const sendAlert = new sfn_tasks.LambdaInvoke(this, 'SendAlert', {
      lambdaFunction: sendAlertFn,
      payload: sfn.TaskInput.fromObject({
        personId: sfn.JsonPath.stringAt('$.personId'),
        summary: sfn.JsonPath.stringAt('$.analysis.summary'),
        sentiment: sfn.JsonPath.stringAt('$.analysis.sentiment'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    }).next(writeResult);

    const logOnly = new sfn.Pass(this, 'LogOnly').next(writeResult);

    const definition = waitForCallCompletion
      .next(startTranscriptionJob)
      .next(waitForTranscription)
      .next(analyzeResponse)
      .next(
        new sfn.Choice(this, 'DistressOrNoResponse')
          .when(
            sfn.Condition.or(
              sfn.Condition.booleanEquals('$.analysis.distressDetected', true),
              sfn.Condition.booleanEquals('$.analysis.responded', false),
            ),
            sendAlert,
          )
          .otherwise(logOnly),
      );

    this.stateMachine = new sfn.StateMachine(this, 'CheckinStateMachine', {
      stateMachineName: 'AgedCareCheckinWorkflow',
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(15),
    });
  }
}
```

The `props.recordingsBucket.grantReadWrite(...)` line above is wrong as
written (it's a placeholder that grants nothing meaningful) — `
CallAwsService`'s generated role needs S3 read/write on the recordings
bucket for the Transcribe job to read the recording and write the
transcript. Fix it before running `cdk synth`:

```typescript
startTranscriptionJob.grantPrincipal &&
  props.recordingsBucket.grantReadWrite(startTranscriptionJob);
```

If `CallAwsService` doesn't expose a `grantPrincipal`/IAM-grantable
surface in the installed `aws-cdk-lib` version (check with
`npx tsc --noEmit` — it will error if the method doesn't exist), the
alternative is passing the bucket ARNs directly into `iamResources` on
the `CallAwsService` construction instead:
`iamResources: [props.recordingsBucket.arnForObjects('*')]` alongside
the `'*'` already required for the `StartTranscriptionJob` action itself
(Transcribe's own IAM action has no resource-level permission, but S3
does, so both can be listed). Whichever compiles is correct — this is
exactly the kind of construct-API detail `cdk synth`'s type-check
catches, per SOUL.md's "let the compiler verify, don't guess" rule.

- [ ] **Step 2: Extend the stack test**

```typescript
test('CheckinWorkflowStack creates a state machine with the retry-free happy path', () => {
  const app = new cdk.App();
  const dummyTable = new dynamodb.Table(app, 'DummyCheckInTable', {
    partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
  });
  const dummyBucket = new s3.Bucket(app, 'DummyRecordingsBucket');
  const stack = new CheckinWorkflowStack(app, 'TestCheckinWorkflowStackFull', {
    checkInTable: dummyTable,
    recordingsBucket: dummyBucket,
    alertEmailAddress: 'carer@example.com',
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  template.resourceCountIs('AWS::Lambda::Function', 6);
  template.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email',
    Endpoint: 'carer@example.com',
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      source: ['aws.transcribe'],
      'detail-type': ['Transcribe Job State Change'],
    },
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd infra && npm test`
Expected: PASS. If the `CallAwsService` fix from Step 1 changes the
Lambda function count (it shouldn't — it's an IAM grant, not a new
Lambda), adjust `resourceCountIs` accordingly rather than forcing the
number.

- [ ] **Step 4: Checkpoint + commit**

Ask "make sense? any errors?" then:
```bash
git add infra/lib/checkin-workflow-stack.ts infra/test/stacks/checkin-workflow-stack.test.ts
git commit -m "infra: wire the check-in Step Functions state machine"
```

---

## Task 13: Wire `infra.ts` and deploy

**Files:**
- Modify: `infra/bin/infra.ts`

**Interfaces:**
- Consumes: `DataStack.checkInTable`, `ConnectStack.recordingsBucket`.

- [ ] **Step 1: Update the app entrypoint**

```typescript
import { CheckinWorkflowStack } from '../lib/checkin-workflow-stack';

const dataStack = new DataStack(app, 'DataStack', {});
const connectStack = new ConnectStack(app, 'ConnectStack', {});
new AuthStack(app, 'AuthStack', {});
new CheckinWorkflowStack(app, 'CheckinWorkflowStack', {
  checkInTable: dataStack.checkInTable,
  recordingsBucket: connectStack.recordingsBucket,
  alertEmailAddress: process.env.ALERT_EMAIL_ADDRESS ?? '',
});
```

Add `ALERT_EMAIL_ADDRESS` to `infra/.env.example` (create the file's
infra-side entry if `.env.example` currently only documents `web/`
vars — check first) documenting it as "carer/family email that
receives distress alerts, required at deploy time".

- [ ] **Step 2: Run full test suite**

Run: `cd infra && npx tsc --noEmit && npm test`
Expected: PASS, no type errors.

- [ ] **Step 3: Deploy**

Run (from `infra/`):
```bash
ALERT_EMAIL_ADDRESS=<rafin's real email> npx cdk deploy CheckinWorkflowStack --parameters ContactFlowId=<id from Task 11>
```

- [ ] **Step 4: Confirm the SNS email subscription**

Point Rafin to their inbox for the "AWS Notification - Subscription
Confirmation" email from the new `AgedCareCheckinAlerts` topic — they
must click "Confirm subscription" or no alert email will ever arrive.

- [ ] **Step 5: Console pointer + checkpoint**

Point Rafin to Step Functions Console → `AgedCareCheckinWorkflow` (state
machine exists but has had no executions yet — that's Task 14). Ask
"make sense? any errors?" before Task 14.

- [ ] **Step 6: Commit**

```bash
git add infra/bin/infra.ts infra/.env.example
git commit -m "infra: wire check-in workflow stack into the app"
```

---

## Task 14: End-to-end manual test call (Phase 6 checkpoint)

**Files:** none — this is the phase's actual checkpoint, not a code
change.

- [ ] **Step 1: Start an execution**

Step Functions Console → `AgedCareCheckinWorkflow` → "Start execution" →
input:
```json
{ "personId": "test-person-1", "phoneNumber": "<Rafin's own AU number, E.164>" }
```

- [ ] **Step 2: Answer the call, speak a normal response**

Say something like "I'm doing fine today, just had breakfast" — this
should route to `LogOnly`, not `SendAlert`.

- [ ] **Step 3: Watch the execution graph**

Confirm in the Console that every state goes green in order:
`WaitForCallCompletion` (stays "in progress" until the call ends) →
`StartTranscriptionJob` → `WaitForTranscription` (stays "in progress"
until Transcribe finishes, usually under a minute for a short clip) →
`AnalyzeResponse` → `DistressOrNoResponse` → `LogOnly` →
`WriteCheckinResult` → execution "Succeeded".

- [ ] **Step 4: Repeat with a simulated distress response**

Start a second execution, this time say something like "I fell this
morning and I'm scared" during the call. Confirm the graph takes the
`SendAlert` branch and the confirmed email address receives the alert.

- [ ] **Step 5: Check DynamoDB**

DynamoDB Console → `AgedCareCheckIns` table → confirm two new items,
`personId = test-person-1`, matching timestamps and analysis fields.

- [ ] **Step 6: Phase 6 checkpoint**

Ask Rafin: "make sense? any errors?" — this is the full Phase 6
checkpoint from `DEVELOPMENT_PHASES.md`. Only after a yes: update
`docs/planning/DEVELOPMENT_PHASES.md` to mark Phase 6
`✅ Completed — <date/time>`, add a `docs/BUILD_LOG.md` entry, and
commit.

---

## Self-review notes

- **Spec coverage:** every Phase 6 bullet from `DEVELOPMENT_PHASES.md`
  has a task — Connect instance/flow (Tasks 1, 11), start-checkin
  Lambda (5), Transcribe wiring (7, 8, 12), analyze-response/Bedrock (9),
  state machine + scheduler (12 — EventBridge Scheduler trigger itself
  is intentionally deferred past this checkpoint, see Task 12's note),
  send-alert (10).
- **Known open risk carried into execution:** Task 12's
  `CallAwsService` IAM-grant snippet is flagged inline as needing a
  compiler check rather than asserted as certain — this is the one spot
  in the plan where the exact CDK construct surface wasn't verified
  against installed `aws-cdk-lib` types before writing the plan, per the
  "don't guess APIs" rule. Whoever executes Task 12 must resolve it via
  `tsc`, not by picking either snippet blind.
- **EventBridge Scheduler cron trigger:** deliberately not in this
  plan — Phase 6's checkpoint is one manual test run, and wiring a
  recurring schedule before Phase 7's dashboard can manage schedules
  would create real outbound calls with no UI to stop them. Add it as a
  Phase 7 follow-up once `manage-schedule` exists.
