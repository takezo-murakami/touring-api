import type { CreatePostInput, LocationItem, PostItem, RideItem, SaveRideInput } from './domain.js';
import type { LatLng } from './domain.js';

export type WishlistEntry = {
  locationId: string;
  savedAt: string;
  location: LocationItem | null;
};

export type MyPostEntry = {
  post: PostItem;
  location: LocationItem | null;
};

export interface AppStore {
  listCandidates(origin: LatLng, radiusKm: number | null): Promise<LocationItem[]>;
  postsFor(locationIds: string[]): Promise<PostItem[]>;
  getLocation(locationId: string): Promise<LocationItem | null>;
  listPosts(locationId: string): Promise<PostItem[]>;
  listMyPosts(userId: string): Promise<MyPostEntry[]>;
  createPost(userId: string, input: CreatePostInput): Promise<{ location: LocationItem; post: PostItem }>;
  updatePost(userId: string, postId: string, input: CreatePostInput): Promise<{ location: LocationItem; post: PostItem }>;
  deletePost(userId: string, postId: string): Promise<string[]>;
  putWishlist(userId: string, locationId: string): Promise<{ locationId: string; savedAt: string }>;
  deleteWishlist(userId: string, locationId: string): Promise<void>;
  listWishlist(userId: string): Promise<WishlistEntry[]>;
  saveRide(userId: string, input: SaveRideInput): Promise<{ ride: RideItem; created: boolean }>;
  updateRide(userId: string, rideId: string, action: 'arrive' | 'discard'): Promise<RideItem | null>;
}
