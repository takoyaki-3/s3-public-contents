import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

export class S3PublicContentsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'UploadBucket', {
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE, s3.HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // CloudFrontディストリビューション
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // Lambda関数(署名付きURL発行)用のIAMロール
    const signUrlLambdaRole = new iam.Role(this, 'SignUrlLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // S3バケットへのGetObjectとPutObjectの権限を付与
    signUrlLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [bucket.arnForObjects('*')],
    }));

    // Add this to both Lambda roles
    const lambdaLogPolicy = new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents'
      ],
      resources: ['arn:aws:logs:*:*:*']
    });

    signUrlLambdaRole.addToPolicy(lambdaLogPolicy);

    // Lambda関数(署名付きURL発行)
    const signUrlLambda = new lambda.Function(this, 'SignUrlLambda', {
      runtime: lambda.Runtime.NODEJS_16_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const s3 = new AWS.S3();
        const bucketName = process.env.BUCKET_NAME;

        exports.handler = async (event) => {
          console.log('Received event:', JSON.stringify(event, null, 2));
          const body = JSON.parse(event.body);
          const key = body.key;
          const expires = body.expires; // 有効期限をeventから取得
          const fileType = body.fileType; // ファイルタイプをeventから取得

          // Validate key parameter
          if (!key || key.trim() === '') {
            console.error('Invalid or missing key parameter');
            return {
              statusCode: 400,
              headers: {
                'Access-Control-Allow-Origin': '*'
              },
              body: '{"message":"Missing or empty key parameter"}'
            };
          }

          const params = {
            Bucket: bucketName,
            Key: key,
            ContentType: fileType,
          };

          if (expires !== 'unlimited') {
            params.Expires = parseInt(expires);
          }

          try {
            const uploadURL = await s3.getSignedUrlPromise('putObject', params);
            return {
              statusCode: 200,
              headers: {
                'Access-Control-Allow-Origin': '*',
              },
              body: JSON.stringify({
                uploadURL: uploadURL,
                key: key,
              }),
            };
          } catch (error) {
            console.error('Error generating signed URL:', error);
            return {
              statusCode: 500,
              headers: {
                'Access-Control-Allow-Origin': '*'
              },
              body: '{"message":"Failed to generate signed URL"}'
            };
          }
        };
      `),
      role: signUrlLambdaRole,
      environment: {
        BUCKET_NAME: bucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30), // タイムアウトを30秒に設定
    });
    bucket.grantReadWrite(signUrlLambda);

    // API Gateway
    const api = new apigateway.RestApi(this, 'UploadApi', {
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['*'],
      },
    });

    const uploadResource = api.root.addResource('upload');
    uploadResource.addMethod('POST', new apigateway.LambdaIntegration(signUrlLambda, {
      proxy: true,
      integrationResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': "'*'",
          },
        },
        {
          statusCode: '500',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': "'*'",
          },
        },
      ],
      requestTemplates: {
        'application/json': `{
          "key": "$input.params('key')",
          "expires": "$input.params('expires')"
        }`,
      },
    }), {
      methodResponses: [
        {
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: '500',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
      ],
    });

    // Lambda関数(ファイル削除バッチ)用のIAMロール
    const deleteFileLambdaRole = new iam.Role(this, 'DeleteFileLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // S3バケットへのListBucketとDeleteObjectの権限を付与
    deleteFileLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:DeleteObject'],
      resources: [bucket.bucketArn, bucket.arnForObjects('*')],
    }));
    deleteFileLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [bucket.arnForObjects('*')],
    }));

    deleteFileLambdaRole.addToPolicy(lambdaLogPolicy);

    // Lambda関数(ファイル削除バッチ)
    const deleteFileLambda = new lambda.Function(this, 'DeleteFileLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const s3 = new AWS.S3();
        const bucketName = process.env.BUCKET_NAME;

        exports.handler = async (event) => {
          const now = new Date();
          const expirationDate = new Date(now.setDate(now.getDate() - 1)); // 1日前

          const listParams = {
            Bucket: bucketName,
          };

          const listedObjects = await s3.listObjectsV2(listParams).promise();

          if (!listedObjects.Contents) {
            return;
          }

          const deleteObjects = listedObjects.Contents
            .filter(object => object.LastModified < expirationDate)
            .map(object => ({ Key: object.Key }));

          if (deleteObjects.length === 0) {
            return;
          }

          const deleteParams = {
            Bucket: bucketName,
            Delete: {
              Objects: deleteObjects,
              Quiet: false
            }
          };

          await s3.deleteObjects(deleteParams).promise();

          console.log(\`Deleted \${deleteObjects.length} objects\`);
        };
      `),
      role: deleteFileLambdaRole,
      environment: {
        BUCKET_NAME: bucket.bucketName,
      }
    });

    // CloudWatch Events Rule (毎日実行)
    const rule = new events.Rule(this, 'DeleteFileRule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '0' }), // 毎日0時
    });

    rule.addTarget(new targets.LambdaFunction(deleteFileLambda));

    // CloudFrontのドメイン名を出力
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.domainName,
    });
  }
}
