import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

const stringKey = (name: string): dynamodb.Attribute => ({
  name,
  type: dynamodb.AttributeType.STRING,
});

export class TouringApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const stage = stageName(this);

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `touring-users-${stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      keepOriginal: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      userVerification: {
        emailStyle: cognito.VerificationEmailStyle.CODE,
        emailSubject: 'ツーリングアプリの確認コード',
        emailBody: '確認コードは {####} です。',
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OFF,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.LITE,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient('MobileClient', {
      userPoolClientName: `touring-mobile-${stage}`,
      generateSecret: false,
      disableOAuth: true,
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      preventUserExistenceErrors: true,
    });

    const contentTable = new dynamodb.TableV2(this, 'TouringAppTable', {
      tableName: physicalName('TouringAppTable', stage),
      partitionKey: stringKey('PK'),
      sortKey: stringKey('SK'),
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: stringKey('GSI1PK'),
          sortKey: stringKey('GSI1SK'),
        },
        {
          indexName: 'GSI2',
          partitionKey: stringKey('GSI2PK'),
          sortKey: stringKey('GSI2SK'),
        },
      ],
    });

    const rideHistoryTable = new dynamodb.TableV2(this, 'RideHistoryTable', {
      tableName: physicalName('RideHistoryTable', stage),
      partitionKey: stringKey('PK'),
      sortKey: stringKey('SK'),
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const photosBucket = new s3.Bucket(this, 'PhotosBucket', {
      bucketNamePrefix: `touring-photos-${stage}`,
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      blockedEncryptionTypes: [s3.BlockedEncryptionType.SSE_C],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const apiFunction = new nodejs.NodejsFunction(this, 'ApiFunction', {
      entry: path.join(__dirname, '../src/lambda.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      environment: {
        TOURING_APP_TABLE: contentTable.tableName,
        RIDE_HISTORY_TABLE: rideHistoryTable.tableName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        TOURING_PHOTOS_BUCKET: photosBucket.bucketName,
      },
      bundling: {
        externalModules: [],
      },
    });
    contentTable.grantReadWriteData(apiFunction);
    rideHistoryTable.grantReadWriteData(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:TransactWriteItems'],
      resources: [contentTable.tableArn, `${contentTable.tableArn}/index/*`],
    }));
    photosBucket.grantReadWrite(apiFunction);

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `touring-api-${stage}`,
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', apiFunction),
      corsPreflight: {
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
      },
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'TouringAppTableName', { value: contentTable.tableName });
    new cdk.CfnOutput(this, 'RideHistoryTableName', { value: rideHistoryTable.tableName });
    new cdk.CfnOutput(this, 'PhotosBucketName', { value: photosBucket.bucketName });
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
  }
}

function stageName(scope: Construct): string {
  const stage = scope.node.tryGetContext('stage');
  if (stage === undefined) {
    return 'dev';
  }
  if (typeof stage !== 'string' || !/^[a-z0-9-]+$/.test(stage)) {
    throw new Error('context stage must be a lowercase identifier');
  }
  return stage;
}

function physicalName(specName: string, stage: string): string {
  return stage === 'dev' ? specName : `${specName}-${stage}`;
}
