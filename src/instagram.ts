import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomBytes } from 'node:crypto';

import { config } from './config.js';
import {
  instagramEmail,
  instagramSettingsFromEnv,
  type InstagramAccount,
  type InstagramDeps,
  type InstagramSettings,
  type IssuedSession,
} from './instagram-login.js';
import { saveLoginTicket, takeLoginTicket } from './login-tickets.js';

const GRAPH = 'https://graph.facebook.com/v27.0';

const cognito = new CognitoIdentityProviderClient({
  region: config.userPoolId.split('_')[0] || config.region,
});

export function liveInstagramDeps(): InstagramDeps {
  return {
    settings: instagramSettingsFromEnv(),
    exchange: exchangeInstagramCode,
    accounts: fetchInstagramAccounts,
    issue: issueCognitoSession,
    saveTicket: saveLoginTicket,
    takeTicket: takeLoginTicket,
  };
}

export async function exchangeInstagramCode(code: string): Promise<string> {
  const settings = requiredSettings();
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('client_id', settings.appId);
  url.searchParams.set('client_secret', settings.appSecret);
  url.searchParams.set('redirect_uri', settings.redirectUri);
  url.searchParams.set('code', code);
  const payload = await readGraph(url);
  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('Instagram のトークン交換に失敗しました');
  }
  return payload.access_token;
}

export async function fetchInstagramAccounts(accessToken: string): Promise<InstagramAccount[]> {
  try {
    return await readInstagramAccounts(accessToken, 'id,username,profile_picture_url');
  } catch {
    return readInstagramAccounts(accessToken, 'id,username');
  }
}

async function readInstagramAccounts(accessToken: string, fields: string): Promise<InstagramAccount[]> {
  const url = new URL(`${GRAPH}/me/assigned_instagram_accounts`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', accessToken);
  const payload = await readGraph(url);
  if (!Array.isArray(payload.data)) {
    return [];
  }
  return payload.data.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const record = item as { id?: unknown; username?: unknown; profile_picture_url?: unknown };
    const id = typeof record.id === 'string' ? record.id : '';
    const username = typeof record.username === 'string' ? record.username : '';
    const profilePictureUrl = pictureUrl(record.profile_picture_url);
    return id ? [{ id, username, ...(profilePictureUrl ? { profilePictureUrl } : {}) }] : [];
  });
}

function pictureUrl(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('https://') || value.length > 2048) {
    return undefined;
  }
  return value;
}

export async function issueCognitoSession(account: InstagramAccount): Promise<IssuedSession> {
  const email = instagramEmail(account.id);
  await ensureCognitoUser(email);
  const password = oneTimePassword();
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: config.userPoolId,
    Username: email,
    Password: password,
    Permanent: true,
  }));
  const result = await cognito.send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: config.clientId,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  }));
  const tokens = result.AuthenticationResult;
  if (!tokens?.IdToken || !tokens.AccessToken || !tokens.RefreshToken) {
    throw new Error('Cognito のログインに失敗しました');
  }
  return {
    idToken: tokens.IdToken,
    accessToken: tokens.AccessToken,
    refreshToken: tokens.RefreshToken,
    email,
    instagramId: account.id,
    instagramUsername: account.username,
    ...(account.profilePictureUrl ? { instagramPictureUrl: account.profilePictureUrl } : {}),
  };
}

async function ensureCognitoUser(email: string) {
  try {
    await cognito.send(new AdminGetUserCommand({
      UserPoolId: config.userPoolId,
      Username: email,
    }));
    return;
  } catch (error) {
    if (errorName(error) !== 'UserNotFoundException') {
      throw error;
    }
  }
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: config.userPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }));
  } catch (error) {
    if (errorName(error) !== 'UsernameExistsException') {
      throw error;
    }
  }
}

function requiredSettings(): InstagramSettings {
  const settings = instagramSettingsFromEnv();
  if (!settings) {
    throw new Error('Instagram ログインが未設定です');
  }
  return settings;
}

async function readGraph(url: URL): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Instagram に接続できません');
  }
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error('Instagram の応答を読めません');
    }
  }
  if (!response.ok || payload.error) {
    throw new Error(graphMessage(payload) ?? `Instagram が ${response.status} を返しました`);
  }
  return payload;
}

function graphMessage(payload: Record<string, unknown>): string | null {
  const error = payload.error;
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return null;
  }
  const message = (error as { message: unknown }).message;
  return typeof message === 'string' ? message : null;
}

function oneTimePassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(24);
  let value = 'Aa1!';
  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length];
  }
  return value;
}

function errorName(error: unknown): string {
  return error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
}
