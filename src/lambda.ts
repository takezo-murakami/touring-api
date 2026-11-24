import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { handle, type ApiRequest } from './app.js';
import { authenticate } from './auth.js';
import { config } from './config.js';
import { createDynamoStore } from './dynamo-store.js';
import { HttpError } from './errors.js';

const store = createDynamoStore();

type HttpApiEvent = {
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; path?: string } };
};

type HttpApiResult = {
  statusCode: number;
  body?: string;
};

export async function handler(event: HttpApiEvent): Promise<HttpApiResult> {
  try {
    const method = event.requestContext?.http?.method ?? 'GET';
    const path = event.rawPath || event.requestContext?.http?.path || '/';
    if (method === 'GET' && path === '/health') {
      return json(200, await health());
    }
    const user = await authenticate(header(event.headers, 'authorization'));
    const result = await handle({
      method,
      path,
      query: new URLSearchParams(event.rawQueryString ?? ''),
      body: readBody(event),
      user,
    } satisfies ApiRequest, store);
    return json(result.status, result.body);
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error(error);
    }
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'サーバーエラー';
    return json(status, { message });
  }
}

async function health() {
  const dynamo = new DynamoDBClient({ region: config.region });
  const result = await dynamo.send(new DescribeTableCommand({ TableName: config.contentTable }));
  return {
    ok: true,
    table: config.contentTable,
    status: result.Table?.TableStatus ?? 'UNKNOWN',
  };
}

function readBody(event: HttpApiEvent): unknown {
  if (!event.body) {
    return undefined;
  }
  const bytes = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body);
  if (bytes.length > 1_000_000) {
    throw new HttpError(413, '本文が大きすぎます');
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON として読めません');
  }
}

function header(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

function json(status: number, body: unknown): HttpApiResult {
  if (body === undefined) {
    return { statusCode: status };
  }
  return { statusCode: status, body: JSON.stringify(body) };
}
