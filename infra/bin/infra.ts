#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { DataStack } from '../lib/data-stack';
import { AuthStack } from '../lib/auth-stack';
import { ConnectStack } from '../lib/connect-stack';
import { CheckinWorkflowStack } from '../lib/checkin-workflow-stack';

const app = new cdk.App();

const dataStack = new DataStack(app, 'DataStack', {});
new AuthStack(app, 'AuthStack', {});
const connectStack = new ConnectStack(app, 'ConnectStack', {});
new CheckinWorkflowStack(app, 'CheckinWorkflowStack', {
  checkInTable: dataStack.checkInTable,
  recordingsBucket: connectStack.recordingsBucket,
  alertEmailAddress: process.env.ALERT_EMAIL_ADDRESS ?? '',
});
