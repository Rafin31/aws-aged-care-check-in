import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class ConnectStack extends cdk.Stack {
  public readonly recordingsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The Connect instance, phone number, and call-recordings bucket are
    // all claimed/created by hand in the Console (Phase 6, Task 1) —
    // Connect instance setup isn't a good fit for CDK on a learning
    // project, and Connect creates its own recordings bucket
    // automatically when the instance is set up. This stack's only job
    // is recording those already-created values as SSM parameters, so
    // no Lambda ever needs an ARN typed into its source code.
    const instanceArn = new cdk.CfnParameter(this, 'ConnectInstanceArn', {
      type: 'String',
      description: 'ARN of the manually-claimed Amazon Connect instance',
    }).valueAsString;

    const sourcePhoneNumber = new cdk.CfnParameter(this, 'ConnectSourcePhoneNumber', {
      type: 'String',
      description: 'E.164 phone number claimed on the Connect instance',
    }).valueAsString;

    const recordingsBucketName = new cdk.CfnParameter(this, 'RecordingsBucketName', {
      type: 'String',
      description: 'Name of the S3 bucket Connect auto-created for call recordings',
    }).valueAsString;

    this.recordingsBucket = s3.Bucket.fromBucketName(this, 'CallRecordingsBucket', recordingsBucketName);

    new ssm.StringParameter(this, 'InstanceArnParam', {
      parameterName: '/aged-care-checkin/connect/instance-arn',
      stringValue: instanceArn,
    });

    new ssm.StringParameter(this, 'SourcePhoneNumberParam', {
      parameterName: '/aged-care-checkin/connect/source-phone-number',
      stringValue: sourcePhoneNumber,
    });

    new ssm.StringParameter(this, 'RecordingsBucketNameParam', {
      parameterName: '/aged-care-checkin/connect/recordings-bucket-name',
      stringValue: recordingsBucketName,
    });
  }
}
