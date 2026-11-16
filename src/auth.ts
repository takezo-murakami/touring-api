import { CognitoJwtVerifier } from 'aws-jwt-verify';

import { config } from './config.js';
import { HttpError } from './errors.js';

export type AuthUser = {
  id: string;
};

const verifier = CognitoJwtVerifier.create({
  userPoolId: config.userPoolId,
  tokenUse: 'id',
  clientId: config.clientId,
});

export async function authenticate(authorization: string | undefined): Promise<AuthUser | null> {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) {
    throw new HttpError(401, 'Bearer トークンを送ってください');
  }
  try {
    const payload = await verifier.verify(match[1]);
    return { id: payload.sub };
  } catch {
    throw new HttpError(401, 'トークンが無効です');
  }
}
