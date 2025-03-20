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
# FIREBASE_PROJECT_ID = os.environ['FIREBASE_PROJECT_ID']

def handler(event, context):
  """
  署名付きURLを発行するLambda関数ハンドラー
  """
  print('Received event:', json.dumps(event, indent=2))

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

    # Add upload date prefix to the key
    upload_date = datetime.now().strftime('%Y%m%d')
    key = f"{upload_date}/{key}"

    # Firebaseトークン検証（オプション）
    if token:
      try:
        # トークン検証処理をここに実装
        decoded_token = verify_firebase_token(token)
        user_id = decoded_token.get('user_id')
      except Exception as e:
        return {
          'statusCode': 401,
          'body': json.dumps({
            'error': 'Invalid authentication token',
            'details': str(e)
          })
        }
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
  # 注: 本番環境では適切なFirebase Admin SDK実装に置き換えるべき
  try:
    # トークンの検証（簡易実装）
    decoded = jwt.decode(token, options={"verify_signature": False})

    # # Firebaseプロジェクトの検証
    # if decoded.get('aud') != FIREBASE_PROJECT_ID:
    #     raise Exception("Invalid Firebase project")

    # トークンの有効期限確認
    exp = decoded.get('exp', 0)
    if exp < time.time():
      raise Exception("Token expired")

    return decoded
  except Exception as e:
    raise Exception(f"Token validation failed: {str(e)}")
