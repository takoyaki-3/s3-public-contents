import json
import os
import boto3
import requests
import firebase_admin
from firebase_admin import auth
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
      print('Missing authentication token')
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
        print('User not allowed to upload files')
        return {
          'statusCode': 401,
          'body': json.dumps({
            'error': 'User not allowed to upload files'
          })
        }
    except Exception as e:
      print('Invalid authentication token:', e)
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
    print('Generated signed URL:', signed_url)
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
    print('Internal server error:', e)
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
  Firebaseトークンを検証する関数 (Firebase Admin SDKを使用)
  """
  try:
    # Firebase Admin SDKの初期化 (初回のみ)
    if not firebase_admin._apps:
      # 環境変数からサービスアカウントキーを取得
      service_account_json = os.environ.get('FIREBASE_SERVICE_ACCOUNT_JSON')
      if service_account_json:
        # JSON文字列から認証情報を生成
        cred = firebase_admin.credentials.Certificate(
          json.loads(service_account_json))
      else:
        # Application Default Credentialsを使用
        cred = firebase_admin.credentials.ApplicationDefault()
      firebase_admin.initialize_app(cred)

    # トークンの検証
    decoded_token = auth.verify_id_token(token)
    print(f"Decoded token: {decoded_token}")
    return decoded_token
  except Exception as e:
    raise Exception(f"Token validation failed: {str(e)}")
