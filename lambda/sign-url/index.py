import json
import os
import boto3
import requests
import jwt
import time
from datetime import datetime, timedelta
from botocore.exceptions import ClientError

s3 = boto3.client('s3')
bucket_name = os.environ['BUCKET_NAME']
allowed_users = os.environ['ALLOWED_USERS'].split(',')
# FIREBASE_PROJECT_ID = os.environ['FIREBASE_PROJECT_ID']

def handler(event, context):
  """
  署名付きURLを発行するLambda関数ハンドラー
  """
  print('Received event:', json.dumps(event))

  try:
    body = json.loads(event['body'])
    key = body.get('key')
    file_type = body.get('fileType')  # ファイルタイプをeventから取得
    token = event.get('headers', {}).get('Authorization', '').replace('Bearer ', '')

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

    if not token:
      return {
        'statusCode': 401,
        'body': json.dumps({
          'error': 'Missing authentication token'
        })
      }

    try:
      # トークン検証処理をここに実装
      decoded_token = verify_firebase_token(token)
      user_id = decoded_token.get('user_id')

      if user_id in allowed_users:
        pass
      else:
        return {
          'statusCode': 401,
          'body': json.dumps({
            'error': 'User not allowed to upload files'
          })
        }
    except Exception as e:
      return {
        'statusCode': 401,
        'body': json.dumps({
          'error': 'Invalid authentication token',
          'details': str(e)
        })
      }

    # Add upload date prefix to the key
    upload_date = datetime.now().strftime('%Y%m%d')
    key = f"{user_id}/{upload_date}/{key}"

    params = {
      'Bucket': bucket_name,
      'Key': key,
      'ContentType': file_type,
    }

    # 署名付きURLの生成
    signed_url = s3.generate_presigned_url('put_object', Params=params)

    # 成功レスポンス
    return {
      'statusCode': 200,
      'headers': {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      'body': json.dumps({
        'url': signed_url,
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
    # エラーレスポンス
    return {
      'statusCode': 500,
      'headers': {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      'body': json.dumps({
        'error': 'Internal server error',
        'details': str(e)
      })
    }

def verify_firebase_token(token):
  """
  Firebaseトークンを検証する関数
  """
  try:
    # 実際のFirebaseプロジェクトIDを環境変数から取得
    project_id = os.environ.get('FIREBASE_PROJECT_ID')
    if not project_id:
      raise Exception("FIREBASE_PROJECT_ID environment variable is missing")

    # 公開鍵を取得して署名を検証
    jwks_url = f'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
    jwks_client = jwt.PyJWKClient(jwks_url)
    signing_key = jwks_client.get_signing_key_from_jwt(token)

    # トークンの検証
    decoded = jwt.decode(
      token,
      signing_key.key,
      algorithms=["RS256"],
      audience=project_id,
      issuer=f'https://securetoken.google.com/{project_id}'
    )

    # トークンの有効期限確認
    exp = decoded.get('exp', 0)
    if exp < time.time():
      raise Exception("Token expired")

    return decoded
  except Exception as e:
    raise Exception(f"Token validation failed: {str(e)}")
