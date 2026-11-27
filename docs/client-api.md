# クライアント向け API

Phase1 のモバイルアプリがクラウドへ接続するための契約です。場所の取得、投稿、気になる場所、到着記録はここを呼びます。メールアドレスの登録とログインは API ではなく Cognito に直接話します。Instagram ログインだけは、この API が Meta と Cognito の間を取り次ぎます。

API Gateway と Lambda にはまだ載せていません。開発中は、このリポジトリで `npm run dev` したプロセスが API です。

## 接続先

| 項目 | 値 |
| --- | --- |
| ベース URL | `http://127.0.0.1:3000` |
| リージョン | `ap-northeast-1` |
| User Pool ID | `ap-northeast-1_wDaczsQZI` |
| App Client ID | `1am2njkk9ldegdmkmv030062dj` |
| クライアントシークレット | なし |

同じ PC のシミュレータは `127.0.0.1` で届きます。実機は PC の LAN アドレス（例: `http://192.168.1.10:3000`）にして、Windows ファイアウォールでそのポートを許可します。Android エミュレータからホストを見るときは `http://10.0.2.2:3000` です。

CORS は開発用に全オリジンを許可しています。

## 認証

メールアドレスとパスワードで Cognito に自己登録し、メールの確認コードを通します。招待制ではありません。アプリが使う認証フローは `USER_SRP_AUTH` です。`USER_PASSWORD_AUTH` も有効です。

API が読むのは **ID トークン** です。アクセストークンでは通りません。

```http
Authorization: Bearer <ID トークン>
Content-Type: application/json
```

ユーザー ID はトークンの `sub` です。メールアドレスは API のユーザー情報へコピーしません。

パスワードは 8 文字以上で、英大文字、英小文字、数字が必要です。記号は必須ではありません。

Phase2 で、ログイン画面の「パスワードを忘れた場合」から再設定します。アプリは Cognito の `ForgotPassword` で確認コードを送り、`ConfirmForgotPassword` で新しいパスワードを確定します。API は呼びません。新しいパスワードの規則は登録時と同じです。確定したあとはログイン画面から入り直します。

ヘッダが無い呼び出しは未ログインです。閲覧系はそれで通り、登録系は `401` です。ヘッダがあるのにトークンが無効なときも `401` です。

## Instagram ログイン

Instagram の認可は Meta の Unified login です。アプリシークレットは API の環境変数にだけ置き、アプリには入れません。ローカルでは `touring-api/.env` に書きます。このファイルは Git に入れません。`npm run dev` が起動時に読みます。

| 変数 | 意味 |
| --- | --- |
| `META_APP_ID` | アプリ設定 → ベーシックのアプリ ID |
| `META_APP_SECRET` | 同じ画面のアプリシークレット |
| `META_CONFIG_ID` | Unified login の設定 ID |
| `INSTAGRAM_REDIRECT_URI` | `https://<公開されたAPI>/auth/instagram/callback` |
| `APP_LOGIN_REDIRECT` | 省略時は `touringapp://oauth/instagram` |

`INSTAGRAM_REDIRECT_URI` は Meta のリダイレクト URL と、1 文字まで同じにします。`http://` では動きません。開発中の API が LAN の HTTP だけのときは、そのプロセスへ届く HTTPS の入口を別に用意します。

未設定のときは次の 3 つが `503` です。場所や投稿の API はそのまま動きます。

### GET `/auth/instagram/start`

ログイン画面が開く URL を返します。認証ヘッダは不要です。

```json
{ "url": "https://www.facebook.com/dialog/oauth?..." }
```

### GET `/auth/instagram/callback`

Meta がブラウザをここへ戻します。成功すると `302` でアプリへ戻します。

```text
touringapp://oauth/instagram?ticket=<一度だけのチケット>
```

失敗時の `error` は `denied`、`expired`、`no_account`、`failed` のいずれかです。

### POST `/auth/instagram/session`

```json
{ "ticket": "<チケット>" }
```

```json
{
  "idToken": "<Cognito の ID トークン>",
  "accessToken": "<Cognito のアクセストークン>",
  "refreshToken": "<Cognito のリフレッシュトークン>",
  "email": "17841400000000001@ig.touring.app",
  "instagram": { "id": "17841400000000001", "username": "rider" }
}
```

チケットは 2 分で失効し、一度使うと消えます。返る ID トークンは、メールログインと同じく `Authorization: Bearer` に使います。

Instagram はメールアドレスを返さないため、Cognito のユーザー名は `<InstagramのID>@ig.touring.app` です。同じ Instagram アカウントは同じ Cognito ユーザーに戻ります。

## 共通

成功時の本文は JSON です。`204` には本文がありません。

失敗時は次の形です。

```json
{ "message": "ログインが必要です" }
```

| ステータス | 意味 |
| --- | --- |
| 400 | 入力が不正 |
| 401 | 未ログイン、またはトークンが無効 |
| 403 | 自分の投稿ではない |
| 404 | 対象がない |
| 409 | 状態が操作と合わない |
| 413 | 本文が 1MB を超えた |
| 500 | サーバー側の失敗 |

ID は英数字、ハイフン、アンダースコアで 1〜80 文字です。パスに入れるときは `encodeURIComponent` します。走行記録の ID は `2026-11-16T21:56:39.375Z` のような時刻で、`:` を含むためエンコードが必要です。

## 値の一覧

ジャンルは 1 つだけ選びます。未指定なら全ジャンルです。投稿側の `genres` は 1〜3 個で、重複はできません。

| 名前 | 値 |
| --- | --- |
| genre | `景色` `食事` `癒し` `走り` `仲間` |
| price | `無料` `〜1000円` `1000〜2000円` `2000〜5000円` `5000円以上` `わからない` |
| parking | `専用駐車場あり` `近隣に停めた` `停めにくい` `不明` |
| hours | `0.5` `1` `2` `3` `4` `6` `8` `all` |

半径は、その応答の `averageSpeedKmh` を使い `hours * averageSpeedKmh` km です。`all` は距離で切りません。いまの時速は 30 です。表示件数の上限は 120 です。

時速から換算した半径、所要時間、圏内かどうかは保存しません。場所に残すのは緯度経度と、座標から作った geohash です。距離は検索のたびに計算します。

## エンドポイント

### GET `/locations/nearby`

近くの場所。認証は任意です。

クエリ:

| 名前 | 必須 | 説明 |
| --- | --- | --- |
| lat | はい | 現在地の緯度 |
| lng | はい | 現在地の経度 |
| hours | はい | スライダーの値。`all` は全国 |
| genre | いいえ | 1 ジャンル |
| keyword | いいえ | 100 文字まで。場所名、ジャンル、投稿の要約と本文に部分一致 |

```http
GET /locations/nearby?lat=35.68&lng=139.76&hours=1&genre=景色&keyword=港
```

```json
{
  "averageSpeedKmh": 30,
  "locations": [
    {
      "id": "9737cde3-637a-4250-814a-4484efe8e5e5",
      "name": "動作確認の丘",
      "latitude": 35.681,
      "longitude": 139.767,
      "genres": ["景色"],
      "price": "無料",
      "parking": "専用駐車場あり",
      "postCount": 1,
      "createdAt": "2026-11-16T21:56:38.985Z",
      "distanceKm": 0.6
    }
  ]
}
```

`averageSpeedKmh` は、その応答の半径を切った時速です。場所ごとには付けません。

クライアントは、この値で二つを計算します。地図の円はスライダーの時間 × 時速です。ContextCard と場所詳細の「現在地から N 分」は、座標から出した距離 ÷ 時速 × 60 です。表示のキロ数は座標の距離のままで、時速では換算しません。

応答が届くまでは、端末が覚えている前回の `averageSpeedKmh` で円と分数を出します。覚えているのは時速だけで、半径はスライダーの段とその場で計算します。覚えていない初回だけ 30 を使います。応答が届いたら、その値へ更新して覚え直します。スライダーの段（`0.5` `1` `2` `3` `4` `6` `8` `all`）はクライアントに固定です。

近い順です。`distanceKm` は小数第 1 位で、その場で計算した値です。`featureId` がある場所だけ、その項目が付きます。

### GET `/locations/{id}`

場所の詳細。認証は任意です。無ければ `404`。

```json
{
  "location": {
    "id": "9737cde3-637a-4250-814a-4484efe8e5e5",
    "name": "動作確認の丘",
    "latitude": 35.681,
    "longitude": 139.767,
    "genres": ["景色"],
    "price": "無料",
    "parking": "専用駐車場あり",
    "postCount": 1,
    "createdAt": "2026-11-16T21:56:38.985Z"
  }
}
```

### GET `/locations/{id}/posts`

その場所の投稿。認証は任意です。新しい順です。場所が無ければ `404`。

```json
{
  "posts": [
    {
      "id": "83d87954-152b-47a6-9570-21c1fd83ff1e",
      "locationId": "9737cde3-637a-4250-814a-4484efe8e5e5",
      "userId": "cognito-sub",
      "summary": "港が見える丘",
      "body": "朝は人が少ない",
      "photos": [],
      "photoUrls": [],
      "photoCount": 0,
      "createdAt": "2026-11-16T21:56:38.985Z",
      "updatedAt": "2026-11-16T21:56:38.985Z"
    }
  ]
}
```

写真がある投稿では `photos` が保存した S3 の key、`photoUrls` が表示用の URL です。並び順は同じです。key でない古い値は、`photoUrls` にも同じ文字列が入ります。

### POST `/photos`

写真を置くための URL を発行する。認証が必要です。

```json
{ "contentType": "image/jpeg" }
```

`contentType` は `image/jpeg` だけです。それ以外は `400` です。`200`:

```json
{
  "key": "photos/{userId}/{uuid}.jpg",
  "uploadUrl": "https://..."
}
```

`uploadUrl` へ JPEG の本体を `PUT` します。`Content-Type` は `image/jpeg` です。URL の有効期限は 5 分です。保存先は非公開の S3 で、投稿の `photos` には `key` を入れます。URL 自体は保存しません。

### POST `/posts`

投稿を作る。認証が必要です。場所 ID が無ければ、緯度経度から場所も作ります。

新しい場所:

```json
{
  "name": "動作確認の丘",
  "summary": "港が見える丘",
  "genres": ["景色"],
  "price": "無料",
  "parking": "専用駐車場あり",
  "latitude": 35.681,
  "longitude": 139.767,
  "body": "朝は人が少ない",
  "photos": []
}
```

既存の場所へ足すときは `locationId` を送り、`latitude` と `longitude` は不要です。特集が付いた場所（`featureId` あり）では、ジャンル、価格、駐車は既存の値のままです。

| 項目 | 制約 |
| --- | --- |
| summary | 必須。500 文字まで |
| genres | 必須。1〜3 個 |
| price | 必須 |
| parking | 必須 |
| name | 任意。80 文字まで。空なら `（名称未設定）` |
| body | 任意。8000 文字まで |
| photos | 任意。`POST /photos` で受け取った、自分の key を 5 個まで |
| latitude, longitude | 新規の場所では必須 |

`201`:

```json
{
  "location": { "id": "...", "name": "動作確認の丘", "postCount": 1 },
  "post": { "id": "...", "locationId": "...", "summary": "港が見える丘" }
}
```

場所と投稿の形は、詳細取得と同じです。返った `location.id` を画面遷移に使います。

投稿の `photos` には key を保存します。応答の `photoUrls` は表示用の URL で、有効期限は 1 時間です。`photos` と並び順は同じです。key 以外の文字列は新規投稿では `400` です。

### PATCH `/posts/{id}`

自分の投稿を編集する。認証が必要です。`id` は作成時に返った投稿 ID です。場所の移動、改名、緯度経度の変更はこの入口ではしません。本文に `name`、`locationId`、`latitude`、`longitude`、`lat`、`lng` があると `400` です。

```json
{
  "summary": "港が見える丘",
  "genres": ["景色"],
  "price": "無料",
  "parking": "専用駐車場あり",
  "body": "朝は人が少ない",
  "photos": []
}
```

| 項目 | 制約 |
| --- | --- |
| summary | 必須。500 文字まで |
| genres | 必須。1〜3 個 |
| price | 必須 |
| parking | 必須 |
| body | 任意。8000 文字まで。省略すると空 |
| photos | 任意。新しい key、またはその投稿に既に入っている文字列を 5 個まで。省略すると空 |

投稿が無ければ `404` です。トークンの `sub` と投稿の `userId` が違うときは `403` です。

ジャンル、価格、駐車は場所の値です。特集が付いた場所（`featureId` あり）では、送った値は使わず既存のままです。特集が無い場所では、この投稿の値で上書きします。`createdAt` は変えず、`updatedAt` だけを受け取り時刻にします。`postCount` は変えません。

`200` で、場所と投稿を返します。形は作成時と同じです。その投稿に既に保存されている文字列（以前の端末内パスを含む）はそのまま残せます。表示は応答の `photoUrls` を使います。

### DELETE `/posts/{id}`

自分の投稿を削除する。認証が必要です。本文はありません。

自分の投稿でなければ `404` です。削除できたときは `204` で、本文はありません。S3 に置いたその投稿の写真も消します。

その場所の `postCount` を 1 減らします。他の投稿が残っていれば、場所は残ります。最後の投稿を消すと、その場所は近傍と詳細から外れます。気になる一覧では、その項目の `location` が `null` になります。走行記録の `locationId` はそのまま残します。

### POST `/locations/{id}/wishlist`

気になる場所へ追加。認証が必要です。本文はありません。場所が無ければ `404`。

`200`:

```json
{
  "locationId": "9737cde3-637a-4250-814a-4484efe8e5e5",
  "savedAt": "2026-11-16T21:56:39.289Z"
}
```

すでに入っているときは、最初の `savedAt` をそのまま返します。

### DELETE `/locations/{id}/wishlist`

気になる場所から外す。認証が必要です。`204` で本文はありません。元から無くても `204` です。

### GET `/users/me/posts`

ログイン中のユーザー自身の投稿。認証が必要です。新しい投稿が先です。どの端末から開いても、同じユーザーには同じ一覧が返ります。

```json
{
  "posts": [
    {
      "post": {
        "id": "83d87954-152b-47a6-9570-21c1fd83ff1e",
        "locationId": "9737cde3-637a-4250-814a-4484efe8e5e5",
        "userId": "cognito-sub",
        "summary": "港が見える丘",
        "body": "朝は人が少ない",
        "photos": [],
        "photoUrls": [],
        "photoCount": 0,
        "createdAt": "2026-11-16T21:56:38.985Z",
        "updatedAt": "2026-11-16T21:56:38.985Z"
      },
      "location": {
        "id": "9737cde3-637a-4250-814a-4484efe8e5e5",
        "name": "動作確認の丘",
        "latitude": 35.681,
        "longitude": 139.767,
        "genres": ["景色"],
        "price": "無料",
        "parking": "専用駐車場あり",
        "postCount": 1,
        "createdAt": "2026-11-16T21:56:38.985Z"
      }
    }
  ]
}
```

場所が消えている項目は `location: null` です。投稿の作成は `POST /posts`、編集は `PATCH /posts/{id}` です。この一覧は、その結果をユーザー単位で読む口です。

### GET `/users/me/wishlist`

自分の気になる場所。認証が必要です。新しい保存が先です。

```json
{
  "entries": [
    {
      "locationId": "9737cde3-637a-4250-814a-4484efe8e5e5",
      "savedAt": "2026-11-16T21:56:39.289Z",
      "location": {
        "id": "9737cde3-637a-4250-814a-4484efe8e5e5",
        "name": "動作確認の丘",
        "latitude": 35.681,
        "longitude": 139.767,
        "genres": ["景色"],
        "price": "無料",
        "parking": "専用駐車場あり",
        "postCount": 1,
        "createdAt": "2026-11-16T21:56:38.985Z"
      }
    }
  ]
}
```

場所が消えている項目は `location: null` です。

### POST `/rides`

到着、または未確認を保存する。認証が必要です。既存の場所だけです。緯度、経度、`lat`、`lng` を本文に含めると `400` です。移動中の座標は送りません。

未確認:

```json
{
  "locationId": "9737cde3-637a-4250-814a-4484efe8e5e5",
  "status": "unconfirmed",
  "clientRideId": "ride-1731800000000"
}
```

到着:

```json
{
  "locationId": "9737cde3-637a-4250-814a-4484efe8e5e5",
  "status": "arrived",
  "detectedAt": "2026-11-16T21:56:39.436Z",
  "clientRideId": "ride-1731800000000"
}
```

`detectedAt` を省略した到着は、サーバーが受け取った時刻を入れます。未確認に `detectedAt` を付けると `400` です。

`clientRideId` は任意で、英数字、ハイフン、アンダースコアの 1〜80 文字です。同じ値でもう一度送ると新しい記録は作らず、既存を `200` で返します。初回は `201` です。

```json
{
  "ride": {
    "id": "2026-11-16T21:56:39.375Z",
    "locationId": "9737cde3-637a-4250-814a-4484efe8e5e5",
    "status": "unconfirmed",
    "detectedAt": null,
    "createdAt": "2026-11-16T21:56:39.375Z",
    "visibility": "private"
  }
}
```

案内の開始とジオフェンスは端末のままです。監視が終わった結果だけを送ります。一覧取得は Phase2 です。

### PATCH `/rides/{id}`

未確認を到着にするか、破棄します。認証が必要です。`id` は作成時に返った `ride.id` です。

```json
{ "action": "arrive" }
```

```json
{ "action": "discard" }
```

`arrive` は `200` で、`status` が `arrived` になった記録を返します。すでに到着なら、そのまま返します。`discard` は未確認だけを消し、`204` です。到着済みの破棄は `409` です。

## いまのアプリからの置き換え

| いまの処理 | API |
| --- | --- |
| `listNearby` | `GET /locations/nearby`。スライダーの時間を `hours` で送る |
| 場所の詳細 | `GET /locations/{id}` |
| `postsFor` | `GET /locations/{id}/posts` |
| `createPost` | `POST /posts`。返った `location.id` へ遷移する |
| `updatePost` | `PATCH /posts/{id}` |
| `deletePost` | `DELETE /posts/{id}` |
| 自分の投稿一覧 | `GET /users/me/posts` |
| `toggleWishlist` の追加 | `POST /locations/{id}/wishlist` |
| `toggleWishlist` の削除 | `DELETE /locations/{id}/wishlist` |
| 気になる一覧 | `GET /users/me/wishlist` |
| ジオフェンスの到着または未確認 | `POST /rides`。端末の監視 ID を `clientRideId` にする |
| `markArrived` | `PATCH /rides/{id}` の `arrive` |
| `discardWatch` | `PATCH /rides/{id}` の `discard` |
| `login` / `logout` | Cognito。API は呼ばない |
| パスワード再設定 | Phase2。Cognito の `ForgotPassword` と `ConfirmForgotPassword`。API は呼ばない |

特集の取得 API は、Phase1 の一覧に無いのでまだありません。

スライダーの段と時速は端末に残します。自分の投稿一覧は `GET /users/me/posts` が正で、端末には残しません。
