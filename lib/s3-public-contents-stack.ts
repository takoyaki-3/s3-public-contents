import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as path from 'path';
import * as cr from 'aws-cdk-lib/custom-resources';

const prefix = 's3-public-contents';

export class S3PublicContentsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Creating a bucket for storing layer packages
    const layerBucket = new s3.Bucket(this, 'LayerBucket', {
      bucketName: `${prefix}-layer-bucket-${this.stackName}`.toLowerCase(),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const bucket = new s3.Bucket(this, 'UploadBucket', {
      bucketName: `${prefix}-upload-bucket-${this.stackName}`.toLowerCase(),
      websiteIndexDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
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
        origin: new origins.S3StaticWebsiteOrigin(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // Create a Lambda function to build layers
    const buildLayerLambda = new lambda.Function(this, 'BuildLayerLambda', {
      functionName: `${prefix}-build-layer-${this.stackName}`,
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../build-layer-lambda')),
      architecture: lambda.Architecture.ARM_64, // Recommended for pip binary compatibility
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
    });

    // Grant the Lambda permissions to write to the layer bucket
    layerBucket.grantWrite(buildLayerLambda);

    // Create a custom resource provider
    const buildLayerProvider = new cr.Provider(this, 'BuildLayerProvider', {
      onEventHandler: buildLayerLambda,
    });

    // Function to create a Python layer using the custom resource
    const createPythonLayer = (id: string, description: string, packageName: string): lambda.LayerVersion => {
      // Create a custom resource to build the layer
      const buildResource = new cdk.CustomResource(this, `Build${id}Resource`, {
        serviceToken: buildLayerProvider.serviceToken,
        resourceType: 'Custom::BuildSingleLayer',
        properties: {
          PackageName: packageName,
          OutputBucket: layerBucket.bucketName,
        },
      });

      // Get the S3 key from the custom resource response
      const builtZipKey = buildResource.getAttString('OutputKey');

      // Create a layer version from the S3 object
      return new lambda.LayerVersion(this, id, {
        code: lambda.Code.fromBucket(layerBucket, builtZipKey),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_9, lambda.Runtime.PYTHON_3_13],
        description: description,
      });
    };

    // 各種レイヤーの作成
    const requestsLayer = createPythonLayer(
      'RequestsLayer',
      'Layer containing the requests library',
      'requests==2.32.3'
    );

    const jwtLayer = createPythonLayer(
      'JwtLayer',
      'Layer containing the PyJWT library',
      'PyJWT==2.10.1'
    );

    const cryptographyLayer = createPythonLayer(
      'CryptographyLayer',
      'Layer containing the cryptography library',
      'cryptography==44.0.2'
    );

    // Lambda関数（署名付きURL発行）
    // Create the Lambda code directory and files
    const signUrlLambdaCode = new lambda.AssetCode(path.join(__dirname, '../lambda/sign-url'));

    // Lambda関数（署名付きURL発行）
    const signUrlLambda = new lambda.Function(this, 'SignUrlLambda', {
      functionName: `${prefix}-sign-url-${this.stackName}`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: signUrlLambdaCode,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        ALLOWED_USERS: process.env.ALLOWED_USERS || '',
        FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
      },
      timeout: cdk.Duration.seconds(3),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      layers: [requestsLayer, jwtLayer, cryptographyLayer],
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

    // 出力値の定義
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.domainName,
      exportName: `${this.stackName}-CloudFrontDomain`,
    });
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      exportName: `${this.stackName}-ApiUrl`,
    });
    new cdk.CfnOutput(this, 'BucketURL', {
      value: `${bucket.bucketName}.s3.amazonaws.com`,
      exportName: `${this.stackName}-BucketURL`,
    });
  }
}
