import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { handle, type ApiRequest } from '../app.js';
import { authenticate } from '../auth.js';
import { config } from '../config.js';
import { createDynamoStore } from '../dynamo-store.js';
import { HttpError } from '../errors.js';

const port = Number(process.env.PORT ?? 3000);
const store = createDynamoStore();

const server = createServer(async (request, response) => {
  setCors(response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      await writeHealth(response);
      return;
    }
    const user = await authenticate(request.headers.authorization);
    const result = await handle({
      method: request.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: await readBody(request),
      user,
    } satisfies ApiRequest, store);
    writeResult(response, result.status, result.body);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'サーバーエラー';
    writeResult(response, status, { message });
  }
});

server.listen(port, () => {
  console.log(`listening on ${port} (${config.region})`);
});

async function writeHealth(response: ServerResponse) {
  const { DescribeTableCommand, DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const dynamo = new DynamoDBClient({ region: config.region });
  const result = await dynamo.send(new DescribeTableCommand({ TableName: config.contentTable }));
  writeResult(response, 200, {
    ok: true,
    table: config.contentTable,
    status: result.Table?.TableStatus ?? 'UNKNOWN',
  });
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) {
      throw new HttpError(413, '本文が大きすぎます');
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON として読めません');
  }
}

function writeResult(response: ServerResponse, status: number, body: unknown) {
  if (body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function setCors(response: ServerResponse) {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}
