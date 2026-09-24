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
    // The contact flow itself can't hand this Lambda a finished
    // recording location — recordings only finalize in S3 after the
    // call disconnects, which is after the flow's last block runs. So
    // this Lambda is triggered by Connect's own "DISCONNECTED" contact
    // event on EventBridge instead (wired below), and looks the
    // recording up itself via DescribeContact once the call has
    // actually ended.
    callCompletedFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['connect:DescribeContact'], resources: [instanceArn] }),
    );

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
    // Haiku 4.5 is cross-region-inference-only (no direct on-demand model
    // ARN) — the Lambda's IAM role needs InvokeModel on both the
    // inference profile itself and the underlying foundation model, since
    // the profile fans the call out to whichever region has capacity.
    analyzeResponseFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0`,
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
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

    // Amazon Connect publishes this automatically whenever any call on
    // the instance ends — filtered to this instance so calls from other
    // Connect instances on the account's event bus (there shouldn't be
    // any, but the bus is account-wide) don't trigger a wasted lookup.
    new events.Rule(this, 'CallDisconnectedRule', {
      eventPattern: {
        source: ['aws.connect'],
        detailType: ['Amazon Connect Contact Event'],
        detail: { eventType: ['DISCONNECTED'], instanceArn: [instanceArn] },
      },
      targets: [new events_targets.LambdaFunction(callCompletedFn)],
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
      // startTranscriptionJob itself has no resource-level IAM permission
      // (hence the '*' above) but the job needs its own S3 read/write on
      // the recordings bucket to fetch the call recording and write the
      // transcript back out — added as a separate least-privilege
      // statement rather than widening iamResources.
      additionalIamStatements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [props.recordingsBucket.arnForObjects('*')],
        }),
      ],
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
