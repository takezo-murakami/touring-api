import { HttpError } from './errors.js';

export const GENRES = ['景色', '食事', '癒し', '走り', '仲間'] as const;
export type Genre = (typeof GENRES)[number];

export const PRICES = ['無料', '〜1000円', '1000〜2000円', '2000〜5000円', '5000円以上', 'わからない'] as const;
export type Price = (typeof PRICES)[number];

export const PARKING = ['専用駐車場あり', '近隣に停めた', '停めにくい', '不明'] as const;
export type Parking = (typeof PARKING)[number];

export const SLIDER_HOURS = [0.5, 1, 2, 3, 4, 6, 8] as const;

export const AVERAGE_SPEED_KMH = 50;
export const DISPLAY_LIMIT = 120;

export type LatLng = {
  latitude: number;
  longitude: number;
};

export type LocationItem = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  genres: Genre[];
  price: Price;
  parking: Parking;
  postCount: number;
  createdAt: string;
  featureId?: string;
  geohash: string;
};

export type PostItem = {
  id: string;
  locationId: string;
  userId: string;
  summary: string;
  body: string;
  photos: string[];
  createdAt: string;
  updatedAt: string;
};

export type RideStatus = 'arrived' | 'unconfirmed';

export type RideItem = {
  id: string;
  locationId: string;
  status: RideStatus;
  detectedAt: string | null;
  createdAt: string;
  visibility: 'private';
  clientRideId?: string;
};

export type NearbyQuery = {
  origin: LatLng;
  radiusKm: number | null;
  genre: Genre | null;
  keyword: string;
};

export type CreatePostInput = {
  locationId?: string;
  latitude?: number;
  longitude?: number;
  name: string;
  summary: string;
  genres: Genre[];
  price: Price;
  parking: Parking;
  body: string;
  photos: string[];
};

export type SaveRideInput = {
  locationId: string;
  status: RideStatus;
  detectedAt: string | null;
  clientRideId?: string;
};

export function radiusKmFor(hours: string): number | null {
  if (hours === 'all') {
    return null;
  }
  const value = Number(hours);
  if (!SLIDER_HOURS.some((stop) => stop === value)) {
    throw new HttpError(400, 'hours は 0.5、1、2、3、4、6、8、all のいずれかです');
  }
  return value * AVERAGE_SPEED_KMH;
}

export function parseNearby(search: URLSearchParams): NearbyQuery {
  const latitude = requiredNumber(search.get('lat'), 'lat', -90, 90);
  const longitude = requiredNumber(search.get('lng'), 'lng', -180, 180);
  const hours = search.get('hours');
  if (!hours) {
    throw new HttpError(400, 'hours が必要です');
  }
  const genreValue = search.get('genre');
  const keyword = search.get('keyword')?.trim() ?? '';
  if (keyword.length > 100) {
    throw new HttpError(400, 'keyword は100文字までです');
  }
  return {
    origin: { latitude, longitude },
    radiusKm: radiusKmFor(hours),
    genre: genreValue ? parseGenre(genreValue) : null,
    keyword,
  };
}

export function parseCreatePost(body: unknown): CreatePostInput {
  const record = objectBody(body);
  const summary = requiredText(record.summary, 'summary', 500);
  const genres = parseGenres(record.genres);
  const price = parsePrice(record.price);
  const parking = parseParking(record.parking);
  const bodyText = optionalText(record.body, 'body', 8000);
  const name = optionalText(record.name, 'name', 80);
  const photos = parsePhotos(record.photos);
  const locationId = optionalId(record.locationId, 'locationId');
  if (!locationId) {
    return {
      name,
      summary,
      genres,
      price,
      parking,
      body: bodyText,
      photos,
      latitude: requiredNumber(asNumberSource(record.latitude), 'latitude', -90, 90),
      longitude: requiredNumber(asNumberSource(record.longitude), 'longitude', -180, 180),
    };
  }
  return { locationId, name, summary, genres, price, parking, body: bodyText, photos };
}

export function parseSaveRide(body: unknown): SaveRideInput {
  const record = objectBody(body);
  if ('latitude' in record || 'longitude' in record || 'lat' in record || 'lng' in record) {
    throw new HttpError(400, '走行中の座標は受け取りません');
  }
  const status = record.status;
  if (status !== 'arrived' && status !== 'unconfirmed') {
    throw new HttpError(400, 'status は arrived か unconfirmed です');
  }
  const locationId = optionalId(record.locationId, 'locationId');
  if (!locationId) {
    throw new HttpError(400, 'locationId が必要です');
  }
  const clientRideId = optionalId(record.clientRideId, 'clientRideId');
  if (status === 'unconfirmed') {
    if (record.detectedAt != null && record.detectedAt !== undefined) {
      throw new HttpError(400, '未確認の detectedAt は空です');
    }
    return { locationId, status, detectedAt: null, clientRideId };
  }
  const detectedAt = record.detectedAt === undefined ? null : requiredTimestamp(record.detectedAt, 'detectedAt');
  return { locationId, status, detectedAt, clientRideId };
}

export function parseRideAction(body: unknown): 'arrive' | 'discard' {
  const record = objectBody(body);
  if (record.action === 'arrive' || record.action === 'discard') {
    return record.action;
  }
  throw new HttpError(400, 'action は arrive か discard です');
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'JSON オブジェクトを送ってください');
  }
  return body as Record<string, unknown>;
}

function asNumberSource(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

function requiredNumber(value: string | null, name: string, min: number, max: number): number {
  if (value === null || value.trim() === '') {
    throw new HttpError(400, `${name} が必要です`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${name} の値が範囲外です`);
  }
  return parsed;
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${name} が必要です`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new HttpError(400, `${name} は${max}文字までです`);
  }
  return text;
}

function optionalText(value: unknown, name: string, max: number): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, `${name} は文字列です`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new HttpError(400, `${name} は${max}文字までです`);
  }
  return text;
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new HttpError(400, `${name} の形式が不正です`);
  }
  return value;
}

function parseGenre(value: string): Genre {
  const genre = GENRES.find((item) => item === value);
  if (!genre) {
    throw new HttpError(400, 'genre は景色、食事、癒し、走り、仲間のいずれかです');
  }
  return genre;
}

function parseGenres(value: unknown): Genre[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new HttpError(400, 'genres は1〜3個です');
  }
  const genres = value.map((item) => {
    if (typeof item !== 'string') {
      throw new HttpError(400, 'genres は文字列の配列です');
    }
    return parseGenre(item);
  });
  if (new Set(genres).size !== genres.length) {
    throw new HttpError(400, 'genres が重複しています');
  }
  return genres;
}

function parsePrice(value: unknown): Price {
  const price = PRICES.find((item) => item === value);
  if (!price) {
    throw new HttpError(400, 'price の値が不正です');
  }
  return price;
}

function parseParking(value: unknown): Parking {
  const parking = PARKING.find((item) => item === value);
  if (!parking) {
    throw new HttpError(400, 'parking の値が不正です');
  }
  return parking;
}

function parsePhotos(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 5) {
    throw new HttpError(400, 'photos は5枚までです');
  }
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '' || item.length > 500) {
      throw new HttpError(400, 'photos の各要素は500文字までの文字列です');
    }
    return item.trim();
  });
}

function requiredTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${name} は日時です`);
  }
  return new Date(value).toISOString();
}
