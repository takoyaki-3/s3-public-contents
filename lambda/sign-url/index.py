import json
import os
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
bucket_name = os.environ['BUCKET_NAME']

def handler(event, context):
  print('Received event:', json.dumps(event, indent=2))

  try:
    body = json.loads(event['body'])
    key = body.get('key')
    expires = body.get('expires')  # 有効期限をeventから取得
    file_type = body.get('fileType')  # ファイルタイプをeventから取得

    # Validate key parameter
    if not key or key.strip() == '':
      print('Invalid or missing key parameter')
      return {
        'statusCode': 400,
        'headers': {
          'Access-Control-Allow-Origin': '*'
        },
        'body': json.dumps({'message': 'Missing or empty key parameter'})
      }

    params = {
      'Bucket': bucket_name,
      'Key': key,
      'ContentType': file_type,
    }

    if expires != 'unlimited':
      params['Expires'] = int(expires)

    upload_url = s3.generate_presigned_url('put_object', Params=params)
    return {
      'statusCode': 200,
      'headers': {
        'Access-Control-Allow-Origin': '*',
      },
      'body': json.dumps({
        'uploadURL': upload_url,
        'key': key,
      }),
    }
  except ClientError as e:
    print('Error generating signed URL:', e)
    return {
      'statusCode': 500,
      'headers': {
        'Access-Control-Allow-Origin': '*'
      },
      'body': json.dumps({'message': 'Failed to generate signed URL'})
    }
  except Exception as e:
    print('Unexpected error:', e)
    return {
      'statusCode': 500,
      'headers': {
        'Access-Control-Allow-Origin': '*'
      },
      'body': json.dumps({'message': 'An unexpected error occurred'})
    }
