export const config = {
  region: process.env.AWS_REGION ?? 'ap-northeast-1',
  contentTable: process.env.TOURING_APP_TABLE ?? 'TouringAppTable',
  rideTable: process.env.RIDE_HISTORY_TABLE ?? 'RideHistoryTable',
  userPoolId: process.env.COGNITO_USER_POOL_ID ?? 'ap-northeast-1_wDaczsQZI',
  clientId: process.env.COGNITO_CLIENT_ID ?? '1am2njkk9ldegdmkmv030062dj',
  photosBucket: process.env.TOURING_PHOTOS_BUCKET ?? 'touring-photos-dev-470364454600-ap-northeast-1-an',
};
