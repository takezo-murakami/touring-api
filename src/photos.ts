import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { config } from './config.js';
import { HttpError } from './errors.js';

const s3 = new S3Client({ region: config.region });

const OWNED_KEY =
  /^photos\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.jpg$/;

export function isOwnedPhotoKey(userId: string, value: string) {
  return value.startsWith(`photos/${userId}/`) && OWNED_KEY.test(value);
}

export function acceptedPhotos(userId: string, photos: string[], previous: string[] = []) {
  for (const photo of photos) {
    if (isOwnedPhotoKey(userId, photo) || previous.includes(photo)) {
      continue;
    }
    throw new HttpError(400, '写真はアップロードしたものを送ってください');
  }
  return photos;
}

export async function createUpload(userId: string, contentType: unknown) {
  if (contentType !== 'image/jpeg') {
    throw new HttpError(400, '写真はJPEGで送ってください');
  }
  const key = `photos/${userId}/${randomUUID()}.jpg`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.photosBucket,
      Key: key,
      ContentType: 'image/jpeg',
    }),
    { expiresIn: 300 },
  );
  return { key, uploadUrl };
}

export async function deleteStoredPhotos(userId: string, photos: string[]) {
  const keys = photos.filter((photo) => isOwnedPhotoKey(userId, photo));
  await Promise.all(keys.map(async (key) => {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: config.photosBucket, Key: key }));
    } catch {
      return;
    }
  }));
}

export async function displayPhotoUrl(value: string) {
  if (!OWNED_KEY.test(value)) {
    return value;
  }
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: config.photosBucket, Key: value }),
    { expiresIn: 60 * 60 },
  );
}
