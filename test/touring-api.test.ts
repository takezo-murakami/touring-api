import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { TouringApiStack } from '../lib/touring-api-stack';

function synthesize(): Template {
  const app = new cdk.App();
  const stack = new TouringApiStack(app, 'Test', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
}

test('content and ride tables follow the Phase1 key design', () => {
  const template = synthesize();

  template.resourceCountIs('AWS::DynamoDB::GlobalTable', 2);

  template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    TableName: 'TouringAppTable',
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: Match.arrayWith([
      Match.objectLike({
        IndexName: 'GSI1',
        KeySchema: [
          { AttributeName: 'GSI1PK', KeyType: 'HASH' },
          { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
        ],
      }),
      Match.objectLike({
        IndexName: 'GSI2',
        KeySchema: [
          { AttributeName: 'GSI2PK', KeyType: 'HASH' },
          { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
        ],
      }),
    ]),
  });

  template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
    TableName: 'RideHistoryTable',
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: Match.absent(),
  });
});

test('sign-up is email and password, open to anyone', () => {
  const template = synthesize();

  template.hasResourceProperties('AWS::Cognito::UserPool', {
    UserPoolName: 'touring-users-dev',
    UsernameAttributes: ['email'],
    AutoVerifiedAttributes: ['email'],
    UserPoolTier: 'LITE',
    AdminCreateUserConfig: Match.objectLike({
      AllowAdminCreateUserOnly: false,
    }),
    MfaConfiguration: 'OFF',
  });

  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    ClientName: 'touring-mobile-dev',
    GenerateSecret: false,
    ExplicitAuthFlows: [
      'ALLOW_USER_PASSWORD_AUTH',
      'ALLOW_USER_SRP_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ],
    PreventUserExistenceErrors: 'ENABLED',
  });
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    AllowedOAuthFlowsUserPoolClient: false,
    CallbackURLs: Match.absent(),
    SupportedIdentityProviders: ['COGNITO'],
  });
});

test('http api sends every route to the lambda', () => {
  const template = synthesize();

  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Timeout: 15,
    MemorySize: 512,
    Environment: {
      Variables: Match.objectLike({
        TOURING_APP_TABLE: Match.anyValue(),
        RIDE_HISTORY_TABLE: Match.anyValue(),
        COGNITO_USER_POOL_ID: Match.anyValue(),
        COGNITO_CLIENT_ID: Match.anyValue(),
        TOURING_PHOTOS_BUCKET: Match.anyValue(),
        META_APP_ID: Match.anyValue(),
        META_APP_SECRET: Match.anyValue(),
        META_CONFIG_ID: Match.anyValue(),
        INSTAGRAM_REDIRECT_URI: Match.anyValue(),
        APP_LOGIN_REDIRECT: 'touringapp://oauth/instagram',
      }),
    },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    Name: 'touring-api-dev',
    ProtocolType: 'HTTP',
    CorsConfiguration: Match.objectLike({
      AllowOrigins: ['*'],
      AllowHeaders: Match.arrayWith(['authorization', 'content-type']),
    }),
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: '$default',
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'dynamodb:TransactWriteItems',
          Effect: 'Allow',
        }),
        Match.objectLike({
          Action: Match.arrayWith([
            'cognito-idp:AdminGetUser',
            'cognito-idp:AdminCreateUser',
            'cognito-idp:AdminSetUserPassword',
          ]),
          Effect: 'Allow',
        }),
      ]),
    },
  });
});

test('photo bucket is private', () => {
  const template = synthesize();

  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketNamePrefix: 'touring-photos-dev',
    BucketNamespace: 'account-regional',
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});
