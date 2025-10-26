
# Vibran License Server

A tiny Node/Express server to redeem and check product keys. Ready for Render deploy.

## Endpoints

- `POST /api/license/redeem`  (rate-limited: 10/min/IP)
  - body: `{ "key": "YOUR-KEY" }`
  - marks key as used and returns `{ ok:true }` if unused & valid

- `POST /api/license/check`   (no rate limit; use once per page load)
  - body: `{ "key": "YOUR-KEY" }`
  - returns `{ ok:true }` only if key exists, is marked `used`, and not revoked

- Admin (requires `x-admin-token: <ADMIN_TOKEN>` header):
  - `POST /api/admin/add-keys` body `{ "keys": ["K1","K2"] }`
  - `POST /api/admin/revoke` body `{ "key": "K1" }`
  - `POST /api/admin/unrevoke` body `{ "key": "K1" }`
  - `GET  /api/admin/list`

## Deploy to Render

1. Create a new **Web Service** from this folder (GitHub repo or upload).
2. Use Node 18+.
3. Render picks up `render.yaml` automatically; it will generate `ADMIN_TOKEN`.
4. After deploy, save the `ADMIN_TOKEN` value and use it in your admin requests.

## keys.json

The server stores keys in `keys.json`:
```json
{
  "keys": [
    { "key": "EXAMPLE-KEY-123", "used": false, "revoked": false, "createdAt": "2025-10-25T00:00:00.000Z" }
  ]
}
```
You can edit this file directly or use the admin endpoints.
