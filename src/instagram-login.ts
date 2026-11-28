import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { HttpError } from './errors.js';

export const INSTAGRAM_START_PATH = '/auth/instagram/start';
export const INSTAGRAM_CALLBACK_PATH = '/auth/instagram/callback';
export const INSTAGRAM_SESSION_PATH = '/auth/instagram/session';

const STATE_TTL_MS = 10 * 60 * 1000;

export type InstagramSettings = {
  appId: string;
  appSecret: string;
  configId: string;
  redirectUri: string;
  appRedirect: string;
};

export type InstagramAccount = {
  id: string;
  username: string;
  profilePictureUrl?: string;
};

export type IssuedSession = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  email: string;
  instagramId: string;
  instagramUsername: string;
  instagramPictureUrl?: string;
};

export type InstagramDeps = {
  settings: InstagramSettings | null;
  exchange: (code: string) => Promise<string>;
  accounts: (accessToken: string) => Promise<InstagramAccount[]>;
  issue: (account: InstagramAccount) => Promise<IssuedSession>;
  saveTicket: (session: IssuedSession) => Promise<string>;
  takeTicket: (ticket: string) => Promise<IssuedSession | null>;
  now?: () => number;
};

export type HttpResult = {
  status: number;
  body?: unknown;
  redirect?: string;
};

export function instagramSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): InstagramSettings | null {
  const appId = env.META_APP_ID?.trim() ?? '';
  const appSecret = env.META_APP_SECRET?.trim() ?? '';
  const configId = env.META_CONFIG_ID?.trim() ?? '';
  const redirectUri = env.INSTAGRAM_REDIRECT_URI?.trim() ?? '';
  if (!appId || !appSecret || !configId || !redirectUri.startsWith('https://')) {
    return null;
  }
  if (!redirectUri.endsWith(INSTAGRAM_CALLBACK_PATH)) {
    return null;
  }
  return {
    appId,
    appSecret,
    configId,
    redirectUri,
    appRedirect: env.APP_LOGIN_REDIRECT?.trim() || 'touringapp://oauth/instagram',
  };
}

export function instagramEmail(instagramId: string): string {
  if (!/^[0-9A-Za-z]{5,40}$/.test(instagramId)) {
    throw new HttpError(400, 'Instagram アカウントを確認できません');
  }
  return `${instagramId}@ig.touring.app`;
}

export function createLoginUrl(settings: InstagramSettings, now = Date.now()): string {
  const url = new URL('https://www.facebook.com/dialog/oauth');
  url.searchParams.set('client_id', settings.appId);
  url.searchParams.set('config_id', settings.configId);
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', signState(settings.appSecret, now));
  url.searchParams.set('prompt', 'login');
  return url.toString();
}

export async function instagramHttp(
  request: { method: string; path: string; query: URLSearchParams; body: unknown },
  deps: InstagramDeps,
): Promise<HttpResult | null> {
  if (
    request.path !== INSTAGRAM_START_PATH
    && request.path !== INSTAGRAM_CALLBACK_PATH
    && request.path !== INSTAGRAM_SESSION_PATH
  ) {
    return null;
  }
  if (!deps.settings) {
    return { status: 503, body: { message: 'Instagram ログインが未設定です' } };
  }
  if (request.method === 'GET' && request.path === INSTAGRAM_START_PATH) {
    return { status: 200, body: { url: createLoginUrl(deps.settings, deps.now?.()) } };
  }
  if (request.method === 'GET' && request.path === INSTAGRAM_CALLBACK_PATH) {
    try {
      return { status: 302, redirect: await finishLogin(deps.settings, request.query, deps) };
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return { status: 302, redirect: appUrl(deps.settings.appRedirect, { error: 'failed' }) };
    }
  }
  if (request.method === 'POST' && request.path === INSTAGRAM_SESSION_PATH) {
    const ticket = parseTicket(request.body);
    const session = await deps.takeTicket(ticket);
    if (!session) {
      throw new HttpError(401, 'ログインの有効期限が切れました');
    }
    return {
      status: 200,
      body: {
        idToken: session.idToken,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        email: session.email,
        instagram: {
          id: session.instagramId,
          username: session.instagramUsername,
          ...(session.instagramPictureUrl ? { pictureUrl: session.instagramPictureUrl } : {}),
        },
      },
    };
  }
  return { status: 404, body: { message: '見つかりません' } };
}

export function sessionFromItem(item: Record<string, unknown> | undefined, now = Date.now()): IssuedSession | null {
  if (!item || typeof item.expiresAt !== 'number' || item.expiresAt <= now) {
    return null;
  }
  if (
    typeof item.idToken !== 'string'
    || typeof item.accessToken !== 'string'
    || typeof item.refreshToken !== 'string'
    || typeof item.email !== 'string'
    || typeof item.instagramId !== 'string'
    || typeof item.instagramUsername !== 'string'
  ) {
    return null;
  }
  return {
    idToken: item.idToken,
    accessToken: item.accessToken,
    refreshToken: item.refreshToken,
    email: item.email,
    instagramId: item.instagramId,
    instagramUsername: item.instagramUsername,
    ...pictureFromItem(item.instagramPictureUrl),
  };
}

function pictureFromItem(value: unknown): { instagramPictureUrl: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith('https://') || value.length > 2048) {
    return undefined;
  }
  return { instagramPictureUrl: value };
}

async function finishLogin(settings: InstagramSettings, query: URLSearchParams, deps: InstagramDeps): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  const denied = query.get('error');
  if (denied) {
    return appUrl(settings.appRedirect, { error: denied === 'access_denied' ? 'denied' : 'failed' });
  }
  const code = query.get('code') ?? '';
  if (!code || !stateIsFresh(settings.appSecret, query.get('state') ?? '', now)) {
    return appUrl(settings.appRedirect, { error: 'expired' });
  }
  let accessToken: string;
  try {
    accessToken = await deps.exchange(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return appUrl(settings.appRedirect, { error: 'failed' });
  }
  let accounts: InstagramAccount[];
  try {
    accounts = await deps.accounts(accessToken);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return appUrl(settings.appRedirect, { error: 'failed' });
  }
  const account = accounts.find((item) => /^[0-9A-Za-z]{5,40}$/.test(item.id));
  if (!account) {
    return appUrl(settings.appRedirect, { error: 'no_account' });
  }
  const session = await deps.issue({
    id: account.id,
    username: /^[A-Za-z0-9._]{1,30}$/.test(account.username) ? account.username : account.id,
    ...(account.profilePictureUrl ? { profilePictureUrl: account.profilePictureUrl } : {}),
  });
  const ticket = await deps.saveTicket(session);
  return appUrl(settings.appRedirect, { ticket });
}

function parseTicket(body: unknown): string {
  const ticket = body && typeof body === 'object' && 'ticket' in body ? (body as { ticket: unknown }).ticket : undefined;
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(ticket)) {
    throw new HttpError(400, 'ticket が不正です');
  }
  return ticket;
}

function signState(secret: string, now: number): string {
  const payload = `${now}.${randomBytes(8).toString('hex')}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function stateIsFresh(secret: string, state: string, now: number): boolean {
  const parts = state.split('.');
  if (parts.length !== 3) {
    return false;
  }
  const [issued, nonce, signature] = parts;
  if (!/^\d+$/.test(issued) || !/^[0-9a-f]+$/.test(nonce) || !signature) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(`${issued}.${nonce}`).digest('base64url');
  if (!safeEqual(signature, expected)) {
    return false;
  }
  const age = now - Number(issued);
  return age >= 0 && age <= STATE_TTL_MS;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function appUrl(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams(params).toString()}`;
}
