import ngeohash from 'ngeohash';

const PREFIX_PRECISION = 4;
const FULL_PRECISION = 7;
const MAX_CELLS = 32;

export function encodeGeohash(latitude: number, longitude: number): string {
  return ngeohash.encode(latitude, longitude, FULL_PRECISION);
}

export function geohashPrefix(latitude: number, longitude: number): string {
  return encodeGeohash(latitude, longitude).slice(0, PREFIX_PRECISION);
}

export function searchPrefixes(latitude: number, longitude: number, radiusKm: number): string[] | null {
  const latitudeDelta = radiusKm / 110.574;
  const cosine = Math.cos((latitude * Math.PI) / 180);
  const longitudeDelta = radiusKm / (111.32 * Math.max(Math.abs(cosine), 0.01));
  const cells = ngeohash.bboxes(
    latitude - latitudeDelta,
    longitude - longitudeDelta,
    latitude + latitudeDelta,
    longitude + longitudeDelta,
    PREFIX_PRECISION,
  );
  if (cells.length === 0 || cells.length > MAX_CELLS) {
    return null;
  }
  return cells;
}

export function distanceKm(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }) {
  const earthRadiusKm = 6371;
  const latitudeDelta = degreesToRadians(to.latitude - from.latitude);
  const longitudeDelta = degreesToRadians(to.longitude - from.longitude);
  const start = degreesToRadians(from.latitude);
  const end = degreesToRadians(to.latitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(start) * Math.cos(end) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}
