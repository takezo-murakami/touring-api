import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandOutput,
  type ScanCommandOutput,
} from '@aws-sdk/lib-dynamodb';

import { config } from './config.js';
import type {
  CreatePostInput,
  Genre,
  LatLng,
  LocationItem,
  Parking,
  PostItem,
  Price,
  RideItem,
  RideStatus,
  SaveRideInput,
} from './domain.js';
import { HttpError } from './errors.js';
import { encodeGeohash, searchPrefixes } from './geo.js';
import type { AppStore, WishlistEntry } from './store.js';

const document = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }), {
  marshallOptions: { removeUndefinedValues: true },
});

export function createDynamoStore(): AppStore {
  return new DynamoStore();
}

class DynamoStore implements AppStore {
  async listCandidates(origin: LatLng, radiusKm: number | null): Promise<LocationItem[]> {
    if (radiusKm === null) {
      return scanLocations();
    }
    const prefixes = searchPrefixes(origin.latitude, origin.longitude, radiusKm);
    if (!prefixes) {
      return scanLocations();
    }
    const groups = await Promise.all(prefixes.map((prefix) => queryPrefix(prefix)));
    const byId = new Map<string, LocationItem>();
    for (const location of groups.flat()) {
      byId.set(location.id, location);
    }
    return [...byId.values()];
  }

  async postsFor(locationIds: string[]): Promise<PostItem[]> {
    const lists = await mapPool(locationIds, 8, (locationId) => this.listPosts(locationId));
    return lists.flat();
  }

  async getLocation(locationId: string): Promise<LocationItem | null> {
    const result = await document.send(new GetCommand({
      TableName: config.contentTable,
      Key: locationKey(locationId),
    }));
    return result.Item ? asLocation(result.Item) : null;
  }

  async listPosts(locationId: string): Promise<PostItem[]> {
    const items = await queryAll({
      TableName: config.contentTable,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `LOCATION#${locationId}`, ':sk': 'POST#' },
    });
    return items.map(asPost).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listMyPosts(userId: string): Promise<{ post: PostItem; location: LocationItem | null }[]> {
    const items = await queryAll({
      TableName: config.contentTable,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'POST#' },
    });
    const posts = items
      .map(asPost)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const locations = await batchLocations(posts.map((post) => post.locationId));
    return posts.map((post) => ({ post, location: locations.get(post.locationId) ?? null }));
  }

  async createPost(userId: string, input: CreatePostInput): Promise<{ location: LocationItem; post: PostItem }> {
    await ensureUser(userId);
    const now = new Date().toISOString();
    const postId = randomUUID();
    const existing = input.locationId ? await this.getLocation(input.locationId) : null;
    if (input.locationId && !existing) {
      throw new HttpError(404, '場所が見つかりません');
    }
    const locationId = existing?.id ?? randomUUID();
    if (existing) {
      const posts = await this.listPosts(existing.id);
      if (posts.some((post) => post.userId === userId)) {
        throw new HttpError(409, 'この場所には、すでにあなたの投稿があります');
      }
    }
    const latitude = existing?.latitude ?? input.latitude!;
    const longitude = existing?.longitude ?? input.longitude!;
    const locked = Boolean(existing?.featureId);
    const location: LocationItem = {
      id: locationId,
      name: input.name || existing?.name || '（名称未設定）',
      latitude,
      longitude,
      genres: locked ? existing!.genres : input.genres,
      price: locked ? existing!.price : input.price,
      parking: locked ? existing!.parking : input.parking,
      postCount: (existing?.postCount ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      featureId: existing?.featureId,
      geohash: existing?.geohash ?? encodeGeohash(latitude, longitude),
    };
    const post: PostItem = {
      id: postId,
      locationId,
      userId,
      summary: input.summary,
      body: input.body,
      photos: input.photos,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await document.send(new TransactWriteCommand({
        TransactItems: existing
          ? [
              {
                Update: {
                  TableName: config.contentTable,
                  Key: locationKey(locationId),
                  UpdateExpression: locked
                    ? 'ADD postCount :one'
                    : 'SET #name = :name, genre = :genre, price = :price, parking = :parking ADD postCount :one',
                  ConditionExpression: 'attribute_exists(PK)',
                  ExpressionAttributeNames: locked ? undefined : { '#name': 'name' },
                  ExpressionAttributeValues: locked
                    ? { ':one': 1 }
                    : {
                        ':one': 1,
                        ':name': location.name,
                        ':genre': location.genres,
                        ':price': location.price,
                        ':parking': location.parking,
                      },
                },
              },
              { Put: { TableName: config.contentTable, Item: postItem(post), ConditionExpression: 'attribute_not_exists(PK)' } },
              { Put: { TableName: config.contentTable, Item: authorItem(locationId, userId, postId), ConditionExpression: 'attribute_not_exists(PK)' } },
            ]
          : [
              {
                Put: {
                  TableName: config.contentTable,
                  Item: locationItem(location),
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              { Put: { TableName: config.contentTable, Item: postItem(post), ConditionExpression: 'attribute_not_exists(PK)' } },
              { Put: { TableName: config.contentTable, Item: authorItem(locationId, userId, postId), ConditionExpression: 'attribute_not_exists(PK)' } },
            ],
      }));
    } catch (error) {
      if (isCancelled(error)) {
        if (existing) {
          const posts = await this.listPosts(existing.id);
          if (posts.some((post) => post.userId === userId)) {
            throw new HttpError(409, 'この場所には、すでにあなたの投稿があります');
          }
        }
        throw new HttpError(409, '投稿を保存できませんでした');
      }
      throw error;
    }
    return { location, post };
  }

  async updatePost(userId: string, postId: string, input: CreatePostInput): Promise<{ location: LocationItem; post: PostItem }> {
    if (!input.locationId) {
      throw new HttpError(400, 'locationId が必要です');
    }
    const location = await this.getLocation(input.locationId);
    if (!location) {
      throw new HttpError(404, '場所が見つかりません');
    }
    const existing = (await this.listPosts(location.id)).find((post) => post.id === postId && post.userId === userId);
    if (!existing) {
      throw new HttpError(404, '投稿が見つかりません');
    }
    const now = new Date().toISOString();
    const post: PostItem = {
      ...existing,
      summary: input.summary,
      body: input.body,
      photos: input.photos,
      updatedAt: now,
    };
    const locked = Boolean(location.featureId);
    const nextLocation: LocationItem = locked
      ? location
      : {
          ...location,
          name: input.name || location.name,
          genres: input.genres,
          price: input.price,
          parking: input.parking,
        };
    try {
      await document.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: config.contentTable,
              Key: { PK: `LOCATION#${post.locationId}`, SK: `POST#${post.id}` },
              UpdateExpression: 'SET summary = :summary, body = :body, photos = :photos, updatedAt = :updatedAt',
              ConditionExpression: 'userId = :userId',
              ExpressionAttributeValues: {
                ':summary': post.summary,
                ':body': post.body,
                ':photos': post.photos,
                ':updatedAt': post.updatedAt,
                ':userId': userId,
              },
            },
          },
          ...(locked
            ? []
            : [
                {
                  Update: {
                    TableName: config.contentTable,
                    Key: locationKey(location.id),
                    UpdateExpression: 'SET #name = :name, genre = :genre, price = :price, parking = :parking',
                    ConditionExpression: 'attribute_exists(PK)',
                    ExpressionAttributeNames: { '#name': 'name' },
                    ExpressionAttributeValues: {
                      ':name': nextLocation.name,
                      ':genre': nextLocation.genres,
                      ':price': nextLocation.price,
                      ':parking': nextLocation.parking,
                    },
                  },
                },
              ]),
        ],
      }));
    } catch (error) {
      if (isCancelled(error)) {
        throw new HttpError(404, '投稿が見つかりません');
      }
      throw error;
    }
    return { location: nextLocation, post };
  }

  async putWishlist(userId: string, locationId: string): Promise<{ locationId: string; savedAt: string }> {
    const location = await this.getLocation(locationId);
    if (!location) {
      throw new HttpError(404, '場所が見つかりません');
    }
    await ensureUser(userId);
    const key = { PK: `USER#${userId}`, SK: `WISHLIST#${locationId}` };
    const current = await document.send(new GetCommand({ TableName: config.contentTable, Key: key }));
    if (current.Item) {
      return { locationId, savedAt: String(current.Item.createdAt) };
    }
    const savedAt = new Date().toISOString();
    try {
      await document.send(new PutCommand({
        TableName: config.contentTable,
        Item: { ...key, locationId, createdAt: savedAt },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (error) {
      if (!isConditional(error)) {
        throw error;
      }
      const again = await document.send(new GetCommand({ TableName: config.contentTable, Key: key }));
      return { locationId, savedAt: String(again.Item?.createdAt ?? savedAt) };
    }
    return { locationId, savedAt };
  }

  async deleteWishlist(userId: string, locationId: string): Promise<void> {
    await document.send(new DeleteCommand({
      TableName: config.contentTable,
      Key: { PK: `USER#${userId}`, SK: `WISHLIST#${locationId}` },
    }));
  }

  async listWishlist(userId: string): Promise<WishlistEntry[]> {
    const items = await queryAll({
      TableName: config.contentTable,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'WISHLIST#' },
    });
    const entries = items
      .map((item) => ({
        locationId: String(item.locationId),
        savedAt: String(item.createdAt),
      }))
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    const locations = await batchLocations(entries.map((entry) => entry.locationId));
    return entries.map((entry) => ({
      ...entry,
      location: locations.get(entry.locationId) ?? null,
    }));
  }

  async saveRide(userId: string, input: SaveRideInput): Promise<{ ride: RideItem; created: boolean }> {
    const location = await this.getLocation(input.locationId);
    if (!location) {
      throw new HttpError(404, '場所が見つかりません');
    }
    if (input.clientRideId) {
      const existing = await findRideByClientId(userId, input.clientRideId);
      if (existing) {
        return { ride: existing, created: false };
      }
    }
    const createdAt = new Date().toISOString();
    const ride: RideItem = {
      id: createdAt,
      locationId: input.locationId,
      status: input.status,
      detectedAt: input.status === 'arrived' ? input.detectedAt ?? createdAt : null,
      createdAt,
      visibility: 'private',
      clientRideId: input.clientRideId,
    };
    await document.send(new PutCommand({
      TableName: config.rideTable,
      Item: rideItem(userId, ride),
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return { ride, created: true };
  }

  async updateRide(userId: string, rideId: string, action: 'arrive' | 'discard'): Promise<RideItem | null> {
    const key = { PK: `USER#${userId}`, SK: `RIDE#${rideId}` };
    const current = await document.send(new GetCommand({ TableName: config.rideTable, Key: key }));
    if (!current.Item) {
      throw new HttpError(404, '走行記録が見つかりません');
    }
    const ride = asRide(current.Item);
    if (action === 'discard') {
      if (ride.status !== 'unconfirmed') {
        throw new HttpError(409, '未確認の記録だけ破棄できます');
      }
      await document.send(new DeleteCommand({
        TableName: config.rideTable,
        Key: key,
        ConditionExpression: '#status = :unconfirmed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':unconfirmed': 'unconfirmed' },
      }));
      return null;
    }
    if (ride.status === 'arrived') {
      return ride;
    }
    const detectedAt = new Date().toISOString();
    await document.send(new UpdateCommand({
      TableName: config.rideTable,
      Key: key,
      UpdateExpression: 'SET #status = :arrived, detectedAt = :detectedAt',
      ConditionExpression: '#status = :unconfirmed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':arrived': 'arrived', ':unconfirmed': 'unconfirmed', ':detectedAt': detectedAt },
    }));
    return { ...ride, status: 'arrived', detectedAt };
  }
}

function locationKey(locationId: string) {
  return { PK: `LOCATION#${locationId}`, SK: 'META' };
}

function locationItem(location: LocationItem) {
  return {
    ...locationKey(location.id),
    locationId: location.id,
    name: location.name,
    lat: location.latitude,
    lng: location.longitude,
    geohash: location.geohash,
    genre: location.genres,
    price: location.price,
    parking: location.parking,
    postCount: location.postCount,
    createdAt: location.createdAt,
    featureId: location.featureId,
    GSI1PK: location.geohash.slice(0, 4),
    GSI1SK: `LOCATION#${location.id}`,
  };
}

function postItem(post: PostItem) {
  return {
    PK: `LOCATION#${post.locationId}`,
    SK: `POST#${post.id}`,
    postId: post.id,
    locationId: post.locationId,
    userId: post.userId,
    summary: post.summary,
    body: post.body,
    photos: post.photos,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    GSI2PK: `USER#${post.userId}`,
    GSI2SK: `POST#${post.createdAt}#${post.id}`,
  };
}

function authorItem(locationId: string, userId: string, postId: string) {
  return {
    PK: `LOCATION#${locationId}`,
    SK: `AUTHOR#${userId}`,
    userId,
    postId,
  };
}

function rideItem(userId: string, ride: RideItem) {
  return {
    PK: `USER#${userId}`,
    SK: `RIDE#${ride.id}`,
    userId,
    locationId: ride.locationId,
    status: ride.status,
    detectedAt: ride.detectedAt,
    createdAt: ride.createdAt,
    visibility: ride.visibility,
    clientRideId: ride.clientRideId,
  };
}

function asLocation(item: Record<string, unknown>): LocationItem {
  return {
    id: String(item.locationId),
    name: String(item.name),
    latitude: Number(item.lat),
    longitude: Number(item.lng),
    genres: asGenres(item.genre),
    price: item.price as Price,
    parking: item.parking as Parking,
    postCount: Number(item.postCount ?? 0),
    createdAt: String(item.createdAt),
    featureId: item.featureId ? String(item.featureId) : undefined,
    geohash: String(item.geohash ?? ''),
  };
}

function asPost(item: Record<string, unknown>): PostItem {
  const photos = Array.isArray(item.photos) ? item.photos.map((photo) => String(photo)) : [];
  return {
    id: String(item.postId),
    locationId: String(item.locationId),
    userId: String(item.userId),
    summary: String(item.summary ?? ''),
    body: String(item.body ?? ''),
    photos,
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt ?? item.createdAt),
  };
}

function asRide(item: Record<string, unknown>): RideItem {
  const status: RideStatus = item.status === 'arrived' ? 'arrived' : 'unconfirmed';
  return {
    id: String(item.SK).replace(/^RIDE#/, ''),
    locationId: String(item.locationId),
    status,
    detectedAt: item.detectedAt ? String(item.detectedAt) : null,
    createdAt: String(item.createdAt),
    visibility: 'private',
    clientRideId: item.clientRideId ? String(item.clientRideId) : undefined,
  };
}

function asGenres(value: unknown): Genre[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item) as Genre);
}

async function queryPrefix(prefix: string): Promise<LocationItem[]> {
  const items = await queryAll({
    TableName: config.contentTable,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': prefix },
  });
  return items.map(asLocation);
}

async function scanLocations(): Promise<LocationItem[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: ScanCommandOutput['LastEvaluatedKey'];
  do {
    const result: ScanCommandOutput = await document.send(new ScanCommand({
      TableName: config.contentTable,
      FilterExpression: 'SK = :meta AND begins_with(PK, :pk)',
      ExpressionAttributeValues: { ':meta': 'META', ':pk': 'LOCATION#' },
      ExclusiveStartKey: startKey,
    }));
    items.push(...(result.Items ?? []) as Record<string, unknown>[]);
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return items.map(asLocation);
}

async function queryAll(input: {
  TableName: string;
  IndexName?: string;
  KeyConditionExpression: string;
  ExpressionAttributeValues: Record<string, unknown>;
  FilterExpression?: string;
}): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: QueryCommandOutput['LastEvaluatedKey'];
  do {
    const result: QueryCommandOutput = await document.send(new QueryCommand({
      ...input,
      ExclusiveStartKey: startKey,
    }));
    items.push(...(result.Items ?? []) as Record<string, unknown>[]);
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return items;
}

async function batchLocations(locationIds: string[]): Promise<Map<string, LocationItem>> {
  const unique = [...new Set(locationIds)];
  const locations = new Map<string, LocationItem>();
  for (let index = 0; index < unique.length; index += 100) {
    let keys = unique.slice(index, index + 100).map((locationId) => locationKey(locationId));
    while (keys.length > 0) {
      const result = await document.send(new BatchGetCommand({
        RequestItems: { [config.contentTable]: { Keys: keys } },
      }));
      for (const item of result.Responses?.[config.contentTable] ?? []) {
        const location = asLocation(item as Record<string, unknown>);
        locations.set(location.id, location);
      }
      keys = (result.UnprocessedKeys?.[config.contentTable]?.Keys ?? []) as typeof keys;
    }
  }
  return locations;
}

async function ensureUser(userId: string) {
  try {
    await document.send(new PutCommand({
      TableName: config.contentTable,
      Item: {
        PK: `USER#${userId}`,
        SK: 'META',
        displayName: '',
        profileText: '',
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (error) {
    if (!isConditional(error)) {
      throw error;
    }
  }
}

async function findRideByClientId(userId: string, clientRideId: string): Promise<RideItem | null> {
  const items = await queryAll({
    TableName: config.rideTable,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    FilterExpression: 'clientRideId = :ride',
    ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':sk': 'RIDE#', ':ride': clientRideId },
  });
  return items[0] ? asRide(items[0]) : null;
}

async function mapPool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return results;
}

function isConditional(error: unknown) {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

function isCancelled(error: unknown) {
  return error instanceof Error && error.name === 'TransactionCanceledException';
}
