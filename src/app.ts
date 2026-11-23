import type { AuthUser } from './auth.js';
import {
  AVERAGE_SPEED_KMH,
  parseCreatePost,
  parseNearby,
  parseRideAction,
  parseSaveRide,
  type LocationItem,
  type PostItem,
} from './domain.js';
import { HttpError } from './errors.js';
import { acceptedPhotos, createUpload, displayPhotoUrl } from './photos.js';
import { selectLocations } from './select.js';
import type { AppStore } from './store.js';

export type ApiRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  user: AuthUser | null;
};

export type ApiResult = {
  status: number;
  body?: unknown;
};

type Route = {
  method: string;
  pattern: RegExp;
  auth: 'required' | 'optional';
  handle: (request: ApiRequest, store: AppStore, params: string[]) => Promise<ApiResult>;
};

const routes: Route[] = [
  { method: 'GET', pattern: /^\/locations\/nearby$/, auth: 'optional', handle: nearby },
  { method: 'GET', pattern: /^\/locations\/([^/]+)\/posts$/, auth: 'optional', handle: locationPosts },
  { method: 'GET', pattern: /^\/locations\/([^/]+)$/, auth: 'optional', handle: locationDetail },
  { method: 'POST', pattern: /^\/locations\/([^/]+)\/wishlist$/, auth: 'required', handle: addWishlist },
  { method: 'DELETE', pattern: /^\/locations\/([^/]+)\/wishlist$/, auth: 'required', handle: removeWishlist },
  { method: 'GET', pattern: /^\/users\/me\/wishlist$/, auth: 'required', handle: listWishlist },
  { method: 'GET', pattern: /^\/users\/me\/posts$/, auth: 'required', handle: listMyPosts },
  { method: 'POST', pattern: /^\/photos$/, auth: 'required', handle: createPhotoUpload },
  { method: 'POST', pattern: /^\/posts$/, auth: 'required', handle: createPost },
  { method: 'PATCH', pattern: /^\/posts\/([^/]+)$/, auth: 'required', handle: updatePost },
  { method: 'POST', pattern: /^\/rides$/, auth: 'required', handle: createRide },
  { method: 'PATCH', pattern: /^\/rides\/([^/]+)$/, auth: 'required', handle: patchRide },
];

export async function handle(request: ApiRequest, store: AppStore): Promise<ApiResult> {
  const route = routes.find((item) => item.method === request.method && item.pattern.test(request.path));
  if (!route) {
    throw new HttpError(404, '見つかりません');
  }
  if (route.auth === 'required' && !request.user) {
    throw new HttpError(401, 'ログインが必要です');
  }
  const params = route.pattern.exec(request.path)?.slice(1).map((value) => decodeURIComponent(value)) ?? [];
  for (const param of params) {
    if (!param || param.includes('#') || param.length > 80) {
      throw new HttpError(400, 'id が不正です');
    }
  }
  return route.handle(request, store, params);
}

async function nearby(request: ApiRequest, store: AppStore): Promise<ApiResult> {
  const query = parseNearby(request.query);
  const candidates = await store.listCandidates(query.origin, query.radiusKm);
  const ranked = [...candidates].sort(
    (left, right) =>
      distanceOrder(query.origin, left, right) || left.id.localeCompare(right.id),
  );
  const considered = query.keyword ? ranked.slice(0, 300) : ranked;
  const posts = query.keyword ? await store.postsFor(considered.map((location) => location.id)) : [];
  return {
    status: 200,
    body: {
      averageSpeedKmh: AVERAGE_SPEED_KMH,
      locations: selectLocations({
        origin: query.origin,
        radiusKm: query.radiusKm,
        genre: query.genre,
        keyword: query.keyword,
        locations: considered,
        posts,
      }),
    },
  };
}

async function locationDetail(_request: ApiRequest, store: AppStore, params: string[]): Promise<ApiResult> {
  const location = await store.getLocation(params[0]);
  if (!location) {
    throw new HttpError(404, '場所が見つかりません');
  }
  return { status: 200, body: { location: publicLocation(location) } };
}

async function locationPosts(_request: ApiRequest, store: AppStore, params: string[]): Promise<ApiResult> {
  const location = await store.getLocation(params[0]);
  if (!location) {
    throw new HttpError(404, '場所が見つかりません');
  }
  const posts = await store.listPosts(location.id);
  return { status: 200, body: { posts: await Promise.all(posts.map((post) => presentPost(post))) } };
}

async function addWishlist(request: ApiRequest, store: AppStore, params: string[]): Promise<ApiResult> {
  const entry = await store.putWishlist(request.user!.id, params[0]);
  return { status: 200, body: entry };
}

async function removeWishlist(request: ApiRequest, store: AppStore, params: string[]): Promise<ApiResult> {
  await store.deleteWishlist(request.user!.id, params[0]);
  return { status: 204 };
}

async function listMyPosts(request: ApiRequest, store: AppStore): Promise<ApiResult> {
  const entries = await store.listMyPosts(request.user!.id);
  return {
    status: 200,
    body: {
      posts: await Promise.all(entries.map(async (entry) => ({
        post: await presentPost(entry.post),
        location: entry.location ? publicLocation(entry.location) : null,
      }))),
    },
  };
}

async function listWishlist(request: ApiRequest, store: AppStore): Promise<ApiResult> {
  const entries = await store.listWishlist(request.user!.id);
  return {
    status: 200,
    body: {
      entries: entries.map((entry) => ({
        locationId: entry.locationId,
        savedAt: entry.savedAt,
        location: entry.location ? publicLocation(entry.location) : null,
      })),
    },
  };
}

async function createPhotoUpload(request: ApiRequest): Promise<ApiResult> {
  const body = request.body;
  const contentType = body && typeof body === 'object' && 'contentType' in body
    ? (body as { contentType: unknown }).contentType
    : undefined;
  return { status: 200, body: await createUpload(request.user!.id, contentType) };
}

async function createPost(request: ApiRequest, store: AppStore): Promise<ApiResult> {
  const input = parseCreatePost(request.body);
  acceptedPhotos(request.user!.id, input.photos);
  if (input.locationId) {
    const posts = await store.listPosts(input.locationId);
    if (posts.some((post) => post.userId === request.user!.id)) {
      throw new HttpError(409, 'この場所には、すでにあなたの投稿があります');
    }
  }
  const created = await store.createPost(request.user!.id, input);
  return {
    status: 201,
    body: {
      location: publicLocation(created.location),
      post: await presentPost(created.post),
    },
  };
}

async function updatePost(request: ApiRequest, store: AppStore, params: string[]): Promise<ApiResult> {
  const input = parseCreatePost(request.body);
  if (!input.locationId) {
    throw new HttpError(400, 'locationId が必要です');
  }
  const updated = await store.updatePost(request.user!.id, params[0], input);
  return {
    status: 200,
    body: {
      location: publicLocation(updated.location),
      post: await presentPost(updated.post),
    },
  };
}

async function createRide(request: ApiRequest, store: AppStore): Promise<ApiResult> {
  const input = parseSaveRide(request.body);
  const saved = await store.saveRide(request.user!.id, input);
  return { status: saved.created ? 201 : 200, body: { ride: publicRide(saved.ride) } };
}

async function patchRide(request: ApiRequest, store: AppStore, params: string[]): Promise<ApiResult> {
  const action = parseRideAction(request.body);
  const ride = await store.updateRide(request.user!.id, params[0], action);
  if (!ride) {
    return { status: 204 };
  }
  return { status: 200, body: { ride: publicRide(ride) } };
}

function publicLocation(location: LocationItem) {
  return {
    id: location.id,
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    genres: location.genres,
    price: location.price,
    parking: location.parking,
    postCount: location.postCount,
    createdAt: location.createdAt,
    featureId: location.featureId,
  };
}

function publicPost(post: PostItem) {
  return {
    id: post.id,
    locationId: post.locationId,
    userId: post.userId,
    summary: post.summary,
    body: post.body,
    photos: post.photos,
    photoCount: post.photos.length,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

async function presentPost(post: PostItem) {
  const body = publicPost(post);
  return {
    ...body,
    photoUrls: await Promise.all(body.photos.map((photo) => displayPhotoUrl(photo))),
  };
}

function publicRide(ride: { id: string; locationId: string; status: string; detectedAt: string | null; createdAt: string; visibility: 'private' }) {
  return {
    id: ride.id,
    locationId: ride.locationId,
    status: ride.status,
    detectedAt: ride.detectedAt,
    createdAt: ride.createdAt,
    visibility: ride.visibility,
  };
}

function distanceOrder(origin: { latitude: number; longitude: number }, left: LocationItem, right: LocationItem) {
  const leftDistance = (left.latitude - origin.latitude) ** 2 + (left.longitude - origin.longitude) ** 2;
  const rightDistance = (right.latitude - origin.latitude) ** 2 + (right.longitude - origin.longitude) ** 2;
  return leftDistance - rightDistance;
}
