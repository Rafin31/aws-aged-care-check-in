import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import { CheckinWorkflowStack } from '../../lib/checkin-workflow-stack';

test('CheckinWorkflowStack creates the callback-tokens table with TTL', () => {
  const app = new cdk.App();
  const dummyStack = new cdk.Stack(app, 'DummyCheckInStack');
  const dummyTable = new dynamodb.Table(dummyStack, 'DummyCheckInTable', {
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
