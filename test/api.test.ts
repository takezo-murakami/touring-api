import { handle } from '../src/app';
import { parseCreatePost, parseNearby, radiusKmFor } from '../src/domain';
import { HttpError } from '../src/errors';
import { encodeGeohash, searchPrefixes } from '../src/geo';
import { selectLocations } from '../src/select';
import type { LocationItem, PostItem } from '../src/domain';
import type { AppStore } from '../src/store';

test('geohash matches the known vector', () => {
  expect(encodeGeohash(57.64911, 10.40744)).toBe('u4pruyd');
});

test('a short radius stays on the geohash index and a long one scans', () => {
  expect(radiusKmFor('1')).toBe(30);
  expect(radiusKmFor('all')).toBeNull();
  expect(searchPrefixes(35.68, 139.76, 50)?.length).toBeGreaterThan(0);
  expect(searchPrefixes(35.68, 139.76, 400)).toBeNull();
});

test('nearby keeps places inside the radius, genre, and keyword', () => {
  const locations = [
    place('near', '港の丘', 35.69, 139.77, ['景色']),
    place('food', 'ラーメン屋', 35.7, 139.78, ['食事']),
    place('far', '遠い峠', 40, 140, ['走り']),
  ];
  const posts: PostItem[] = [
    {
      id: 'post-1',
      locationId: 'food',
      userId: 'user',
      summary: '朝のラーメン',
      body: '',
      photos: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const selected = selectLocations({
    origin: { latitude: 35.68, longitude: 139.76 },
    radiusKm: 50,
    genre: '食事',
    keyword: 'ラーメン',
    locations,
    posts,
  });
  expect(selected.map((item) => item.id)).toEqual(['food']);
});

test('nearby returns the speed used to cut the radius', async () => {
  const result = await handle({
    method: 'GET',
    path: '/locations/nearby',
    query: new URLSearchParams({ lat: '35.68', lng: '139.76', hours: '1' }),
    body: undefined,
    user: null,
  }, {
    ...unusedStore(),
    listCandidates: async () => [place('near', '港の丘', 35.681, 139.767, ['景色'])],
  });

  expect(result.status).toBe(200);
  const body = result.body as { averageSpeedKmh: number; locations: Array<Record<string, unknown>> };
  expect(body.averageSpeedKmh).toBe(30);
  expect(body.locations[0]).not.toHaveProperty('averageSpeedKmh');
  expect(body.locations[0].distanceKm).toEqual(expect.any(Number));
});

test('nearby tells the client which speed drew the radius', async () => {
  const result = await handle({
    method: 'GET',
    path: '/locations/nearby',
    query: new URLSearchParams({ lat: '35.68', lng: '139.76', hours: '1' }),
    body: undefined,
    user: null,
  }, {
    ...unusedStore(),
    listCandidates: async () => [place('near', '丘', 35.681, 139.767, ['景色'])],
    postsFor: async () => [],
  });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ averageSpeedKmh: 30 });
});

test('missing hours is rejected before the store is called', async () => {
  await expect(handle({
    method: 'GET',
    path: '/locations/nearby',
    query: new URLSearchParams({ lat: '35', lng: '139' }),
    body: undefined,
    user: null,
  }, unusedStore())).rejects.toMatchObject({ status: 400 });
});

test('creating a post requires a login and a summary', async () => {
  await expect(handle({
    method: 'POST',
    path: '/posts',
    query: new URLSearchParams(),
    body: { summary: '丘から港が見える', genres: ['景色'], price: '無料', parking: '専用駐車場あり', latitude: 35, longitude: 139 },
    user: null,
  }, unusedStore())).rejects.toMatchObject({ status: 401 });

  expect(() => parseCreatePost({ summary: '  ', genres: ['景色'], price: '無料', parking: '専用駐車場あり' })).toThrow(HttpError);
  expect(parseNearby(new URLSearchParams({ lat: '35.0', lng: '139.0', hours: 'all' })).radiusKm).toBeNull();
});

function place(id: string, name: string, latitude: number, longitude: number, genres: LocationItem['genres']): LocationItem {
  return {
    id,
    name,
    latitude,
    longitude,
    genres,
    price: 'わからない',
    parking: '不明',
    postCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    geohash: 'xn76',
  };
}

function unusedStore(): AppStore {
  const fail = () => Promise.reject(new Error('store should not be called'));
  return {
    listCandidates: fail,
    postsFor: fail,
    getLocation: fail,
    listPosts: fail,
    createPost: fail,
    putWishlist: fail,
    deleteWishlist: fail,
    listWishlist: fail,
    saveRide: fail,
    updateRide: fail,
  };
}
