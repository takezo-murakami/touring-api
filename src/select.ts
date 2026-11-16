import { DISPLAY_LIMIT, type LatLng, type LocationItem, type PostItem } from './domain.js';
import { distanceKm } from './geo.js';

export type NearbyLocation = Omit<LocationItem, 'geohash'> & {
  distanceKm: number;
};

export function selectLocations(input: {
  origin: LatLng;
  radiusKm: number | null;
  genre: LocationItem['genres'][number] | null;
  keyword: string;
  locations: LocationItem[];
  posts: PostItem[];
  limit?: number;
}): NearbyLocation[] {
  const needle = input.keyword.trim().toLowerCase();
  const postsByLocation = new Map<string, PostItem[]>();
  for (const post of input.posts) {
    const list = postsByLocation.get(post.locationId) ?? [];
    list.push(post);
    postsByLocation.set(post.locationId, list);
  }
  const limit = input.limit ?? DISPLAY_LIMIT;
  return input.locations
    .map((location) => ({
      location,
      distance: distanceKm(input.origin, location),
    }))
    .filter(({ location, distance }) => {
      if (input.radiusKm !== null && distance > input.radiusKm) {
        return false;
      }
      if (input.genre && !location.genres.includes(input.genre)) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const related = postsByLocation.get(location.id) ?? [];
      const haystack = [location.name, ...location.genres, ...related.map((post) => `${post.summary} ${post.body}`)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    })
    .sort((left, right) => left.distance - right.distance || left.location.id.localeCompare(right.location.id))
    .slice(0, limit)
    .map(({ location, distance }) => ({
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
      distanceKm: Math.round(distance * 10) / 10,
    }));
}
