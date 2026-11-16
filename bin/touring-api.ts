#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { TouringApiStack } from '../lib/touring-api-stack';

const app = new cdk.App();
const stage = app.node.tryGetContext('stage') ?? 'dev';

new TouringApiStack(app, `TouringApi-${stage}`, {
  // This user can create the data stores, but not the IAM roles CDK bootstrap adds.
  synthesizer: new cdk.LegacyStackSynthesizer(),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-northeast-1',
  },
  description: 'Phase1 foundation: Cognito, DynamoDB, and the photo bucket.',
  tags: {
    Project: 'touring-app',
    Stage: String(stage),
  },
});
