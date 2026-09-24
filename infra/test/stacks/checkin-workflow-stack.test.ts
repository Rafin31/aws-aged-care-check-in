import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CheckinWorkflowStack } from '../../lib/checkin-workflow-stack';

function buildTestStack() {
  const app = new cdk.App();
  const dummyStack = new cdk.Stack(app, 'DummyCheckInStack');
  const dummyTable = new dynamodb.Table(dummyStack, 'DummyCheckInTable', {
    partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
  });
  const dummyBucket = new s3.Bucket(dummyStack, 'DummyRecordingsBucket');
  const stack = new CheckinWorkflowStack(app, 'TestCheckinWorkflowStack', {
    checkInTable: dummyTable,
    recordingsBucket: dummyBucket,
    alertEmailAddress: 'carer@example.com',
  });
  return Template.fromStack(stack);
}

test('CheckinWorkflowStack creates the callback-tokens table with TTL', () => {
  const template = buildTestStack();

  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TableName: 'AgedCareCheckinCallbackTokens',
    KeySchema: [{ AttributeName: 'callbackId', KeyType: 'HASH' }],
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  });
});

test('CheckinWorkflowStack creates a state machine with the retry-free happy path', () => {
  const template = buildTestStack();

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
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      source: ['aws.connect'],
      'detail-type': ['Amazon Connect Contact Event'],
      detail: { eventType: ['DISCONNECTED'] },
    },
  });
});

test('CheckinWorkflowStack grants call-completed DescribeContact instead of Connect invoke', () => {
  const template = buildTestStack();

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 'connect:DescribeContact' }),
      ]),
    },
  });
});
