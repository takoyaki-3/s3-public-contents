import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as path from 'path';

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

    // Lambda関数(署名付きURL発行)
    const signUrlLambda = new lambda.Function(this, 'SignUrlLambda', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/sign-url')),
      environment: {
        BUCKET_NAME: bucket.bucketName,
      },
      timeout: cdk.Duration.seconds(3),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
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

    // CloudFrontのドメイン名を出力
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.domainName,
    });
  }
}
