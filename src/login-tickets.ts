import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { config } from './config.js';
import { sessionFromItem, type IssuedSession } from './instagram-login.js';

const TICKET_TTL_MS = 2 * 60 * 1000;

const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function saveLoginTicket(session: IssuedSession): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await document.send(new PutCommand({
    TableName: config.contentTable,
    Item: {
      PK: `IGTICKET#${id}`,
      SK: 'IGTICKET',
      expiresAt: Date.now() + TICKET_TTL_MS,
      idToken: session.idToken,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      email: session.email,
      instagramId: session.instagramId,
      instagramUsername: session.instagramUsername,
      instagramPictureUrl: session.instagramPictureUrl,
    },
  }));
  return id;
}

export async function takeLoginTicket(id: string): Promise<IssuedSession | null> {
  const result = await document.send(new DeleteCommand({
    TableName: config.contentTable,
    Key: { PK: `IGTICKET#${id}`, SK: 'IGTICKET' },
    ReturnValues: 'ALL_OLD',
  }));
  return sessionFromItem(result.Attributes as Record<string, unknown> | undefined);
}
