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
