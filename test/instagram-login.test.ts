import {
  createLoginUrl,
  instagramHttp,
  instagramSettingsFromEnv,
  sessionFromItem,
  type InstagramDeps,
  type IssuedSession,
} from '../src/instagram-login';

const now = 1_700_000_000_000;

const settings = {
  appId: 'app-id',
  appSecret: 'app-secret',
  configId: '1450068690095068',
  redirectUri: 'https://api.example.com/auth/instagram/callback',
  appRedirect: 'touringapp://oauth/instagram',
};

test('instagram settings require the https callback path', () => {
  expect(instagramSettingsFromEnv({
    META_APP_ID: 'app-id',
    META_APP_SECRET: 'app-secret',
    META_CONFIG_ID: 'config',
    INSTAGRAM_REDIRECT_URI: 'http://127.0.0.1:3000/auth/instagram/callback',
  })).toBeNull();
  expect(instagramSettingsFromEnv({
    META_APP_ID: 'app-id',
    META_APP_SECRET: 'app-secret',
    META_CONFIG_ID: 'config',
    INSTAGRAM_REDIRECT_URI: 'https://api.example.com/auth/instagram/callback',
  })?.redirectUri).toBe('https://api.example.com/auth/instagram/callback');
});

test('the login url carries the config and not the secret', () => {
  const url = new URL(createLoginUrl(settings, now));
  expect(url.origin + url.pathname).toBe('https://www.facebook.com/dialog/oauth');
  expect(url.searchParams.get('client_id')).toBe('app-id');
  expect(url.searchParams.get('config_id')).toBe(settings.configId);
  expect(url.searchParams.get('redirect_uri')).toBe(settings.redirectUri);
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('prompt')).toBe('login');
  expect(url.searchParams.get('client_secret')).toBeNull();
  expect(url.toString()).not.toContain(settings.appSecret);
});

test('a fresh login code becomes a one-time app ticket', async () => {
  const deps = fakeDeps();
  const start = await instagramHttp({
    method: 'GET',
    path: '/auth/instagram/start',
    query: new URLSearchParams(),
    body: undefined,
  }, deps);
  const login = new URL((start?.body as { url: string }).url);
  const callback = await instagramHttp({
    method: 'GET',
    path: '/auth/instagram/callback',
    query: new URLSearchParams({
      code: 'auth-code',
      state: login.searchParams.get('state') ?? '',
    }),
    body: undefined,
  }, deps);

  expect(callback?.status).toBe(302);
  const ticket = new URL(callback?.redirect ?? 'http://invalid').searchParams.get('ticket');
  expect(ticket).toEqual(expect.any(String));
  const session = await instagramHttp({
    method: 'POST',
    path: '/auth/instagram/session',
    query: new URLSearchParams(),
    body: { ticket },
  }, deps);
  expect(session?.body).toMatchObject({
    idToken: 'id-token',
    refreshToken: 'refresh-token',
    email: '17841400000000001@ig.touring.app',
    instagram: {
      id: '17841400000000001',
      username: 'rider',
      pictureUrl: 'https://cdn.example/rider.jpg',
    },
  });
  await expect(instagramHttp({
    method: 'POST',
    path: '/auth/instagram/session',
    query: new URLSearchParams(),
    body: { ticket },
  }, deps)).rejects.toMatchObject({ status: 401 });
});

test('a rejected or stale callback does not exchange the code', async () => {
  const deps = fakeDeps();
  const denied = await instagramHttp({
    method: 'GET',
    path: '/auth/instagram/callback',
    query: new URLSearchParams({ error: 'access_denied' }),
    body: undefined,
  }, deps);
  expect(denied?.redirect).toBe('touringapp://oauth/instagram?error=denied');

  const stale = await instagramHttp({
    method: 'GET',
    path: '/auth/instagram/callback',
    query: new URLSearchParams({ code: 'auth-code', state: '1.abcd.bad' }),
    body: undefined,
  }, deps);
  expect(stale?.redirect).toBe('touringapp://oauth/instagram?error=expired');
  expect(deps.exchange).not.toHaveBeenCalled();
});

test('callback without a shared instagram account returns no_account', async () => {
  const deps = fakeDeps();
  deps.accounts.mockResolvedValueOnce([]);
  const start = await instagramHttp({
    method: 'GET',
    path: '/auth/instagram/start',
    query: new URLSearchParams(),
    body: undefined,
  }, deps);
  const state = new URL((start?.body as { url: string }).url).searchParams.get('state') ?? '';
  const callback = await instagramHttp({
    method: 'GET',
    path: '/auth/instagram/callback',
    query: new URLSearchParams({ code: 'auth-code', state }),
    body: undefined,
  }, deps);
  expect(callback?.redirect).toBe('touringapp://oauth/instagram?error=no_account');
});

test('missing instagram settings stay off the other routes', async () => {
  const result = await instagramHttp({
    method: 'GET',
    path: '/auth/instagram/start',
    query: new URLSearchParams(),
    body: undefined,
  }, { ...fakeDeps(), settings: null });
  expect(result).toEqual({ status: 503, body: { message: 'Instagram ログインが未設定です' } });
  expect(await instagramHttp({
    method: 'GET',
    path: '/locations/nearby',
    query: new URLSearchParams(),
    body: undefined,
  }, fakeDeps())).toBeNull();
});

test('an expired stored ticket is empty', () => {
  const session: IssuedSession = {
    idToken: 'id',
    accessToken: 'access',
    refreshToken: 'refresh',
    email: '17841400000000001@ig.touring.app',
    instagramId: '17841400000000001',
    instagramUsername: 'rider',
  };
  expect(sessionFromItem({ ...session, expiresAt: now }, now)).toBeNull();
  expect(sessionFromItem({ ...session, expiresAt: now + 1 }, now)?.email).toBe(session.email);
  expect(sessionFromItem({
    ...session,
    instagramPictureUrl: 'https://cdn.example/rider.jpg',
    expiresAt: now + 1,
  }, now)?.instagramPictureUrl).toBe('https://cdn.example/rider.jpg');
});

function fakeDeps(): InstagramDeps & { exchange: jest.Mock; accounts: jest.Mock } {
  const stored = new Map<string, IssuedSession>();
  let sequence = 0;
  const exchange = jest.fn(async () => 'meta-token');
  const accounts = jest.fn(async () => [{
    id: '17841400000000001',
    username: 'rider',
    profilePictureUrl: 'https://cdn.example/rider.jpg',
  }]);
  return {
    settings,
    exchange,
    accounts,
    issue: async (account) => ({
      idToken: 'id-token',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      email: `${account.id}@ig.touring.app`,
      instagramId: account.id,
      instagramUsername: account.username,
      ...(account.profilePictureUrl ? { instagramPictureUrl: account.profilePictureUrl } : {}),
    }),
    saveTicket: async (session) => {
      sequence += 1;
      const ticket = `ticket-${sequence}-abcdefghijklmnop`;
      stored.set(ticket, session);
      return ticket;
    },
    takeTicket: async (ticket) => {
      const session = stored.get(ticket) ?? null;
      stored.delete(ticket);
      return session;
    },
    now: () => now,
  };
}
