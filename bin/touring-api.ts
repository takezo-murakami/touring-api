#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { TouringApiStack } from '../lib/touring-api-stack';

const app = new cdk.App();
const stage = app.node.tryGetContext('stage') ?? 'dev';

new TouringApiStack(app, `TouringApi-${stage}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-northeast-1',
  },
  description: 'Cognito, DynamoDB, the photo bucket, and the HTTP API.',
  tags: {
    Project: 'touring-app',
    Stage: String(stage),
  },
});
