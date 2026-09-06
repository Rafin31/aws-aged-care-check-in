import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { ConnectStack } from '../../lib/connect-stack';

test('ConnectStack stores instance ARN, phone number, and bucket name as SSM parameters', () => {
  const app = new cdk.App();
  const stack = new ConnectStack(app, 'TestConnectStack');
  const template = Template.fromStack(stack);

  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/aged-care-checkin/connect/instance-arn',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/aged-care-checkin/connect/source-phone-number',
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/aged-care-checkin/connect/recordings-bucket-name',
  });
});
