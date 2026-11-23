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

test('the same user cannot add a second post to one place', async () => {
  await expect(handle({
    method: 'POST',
    path: '/posts',
    query: new URLSearchParams(),
    body: {
      locationId: 'place-1',
      summary: 'もう一度',
      genres: ['景色'],
      price: '無料',
      parking: '専用駐車場あり',
    },
    user: { id: 'user' },
  }, {
    ...unusedStore(),
    listPosts: async () => [samplePost('post-1', 'place-1', 'user')],
  })).rejects.toMatchObject({ status: 409 });
});

test('another user can still post at that place', async () => {
  const result = await handle({
    method: 'POST',
    path: '/posts',
    query: new URLSearchParams(),
    body: {
      locationId: 'place-1',
      summary: '別の人の体験',
      genres: ['食事'],
      price: '無料',
      parking: '専用駐車場あり',
    },
    user: { id: 'other' },
  }, {
    ...unusedStore(),
    listPosts: async () => [samplePost('post-1', 'place-1', 'user')],
    createPost: async () => ({
      location: place('place-1', '港の丘', 35.69, 139.77, ['食事']),
      post: samplePost('post-2', 'place-1', 'other'),
    }),
  });

  expect(result.status).toBe(201);
  expect((result.body as { post: PostItem }).post.userId).toBe('other');
});

test('my posts require a login and come back newest first', async () => {
  await expect(handle({
    method: 'GET',
    path: '/users/me/posts',
    query: new URLSearchParams(),
    body: undefined,
    user: null,
  }, unusedStore())).rejects.toMatchObject({ status: 401 });

  const older = samplePost('post-1', 'place-1', 'user');
  const newer = { ...samplePost('post-2', 'place-2', 'user'), createdAt: '2026-02-01T00:00:00.000Z' };
  const result = await handle({
    method: 'GET',
    path: '/users/me/posts',
    query: new URLSearchParams(),
    body: undefined,
    user: { id: 'user' },
  }, {
    ...unusedStore(),
    listMyPosts: async (userId) => {
      expect(userId).toBe('user');
      return [
        { post: newer, location: place('place-2', '新しい丘', 35.7, 139.8, ['景色']) },
        { post: older, location: null },
      ];
    },
  });

  expect(result.status).toBe(200);
  const posts = (result.body as { posts: Array<{ post: PostItem; location: { name: string } | null }> }).posts;
  expect(posts.map((entry) => entry.post.id)).toEqual(['post-2', 'post-1']);
  expect(posts[0].location?.name).toBe('新しい丘');
  expect(posts[1].location).toBeNull();
});

test('editing a post updates that post', async () => {
  const result = await handle({
    method: 'PATCH',
    path: '/posts/post-1',
    query: new URLSearchParams(),
    body: {
      locationId: 'place-1',
      summary: '書き直した',
      genres: ['景色'],
      price: '無料',
      parking: '専用駐車場あり',
    },
    user: { id: 'user' },
  }, {
    ...unusedStore(),
    updatePost: async () => ({
      location: place('place-1', '港の丘', 35.69, 139.77, ['景色']),
      post: { ...samplePost('post-1', 'place-1', 'user'), summary: '書き直した' },
    }),
  });

  expect(result.status).toBe(200);
  expect((result.body as { post: PostItem }).post.summary).toBe('書き直した');
});

function samplePost(id: string, locationId: string, userId: string): PostItem {
  return {
    id,
    locationId,
    userId,
    summary: '丘から港が見える',
    body: '',
    photos: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

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
    listMyPosts: fail,
    createPost: fail,
    updatePost: fail,
    putWishlist: fail,
    deleteWishlist: fail,
    listWishlist: fail,
    saveRide: fail,
    updateRide: fail,
  };
}
