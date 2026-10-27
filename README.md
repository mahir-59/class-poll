# Class Poll

A tiny, self-hosted voting app for class elections (CR, events, anything). No npm install, no database. Just Node.js.

## Run

```
node server.js
```

Open the printed URL. Admin page: `/#admin`.

## Admin login

Default: `admin` / `admin@123`. Change it with environment variables (always do this when hosting publicly):

```
ADMIN_USER=teacher ADMIN_PASS=your-strong-password node server.js
```

## Features

- **Voter codes**: generate one-time codes, print slips, hand one to each student. Only real codes work, each works once.
- Or let voters type their own ID (roll number), optionally restricted to an allowed list.
- Optional name, optional anonymous voting (admin sees "Anonymous"; the ID is stored only as a one-way hash).
- Live results, "who voted for whom" table, CSV export.
- Settings page: title, candidates, open/close voting, rules.

## Deploy to Vercel

1. Import this repo in Vercel (no build settings needed).
2. In the project, open **Storage → Create / Connect → Upstash (Redis)** and connect it. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. In **Settings → Environment Variables**, set `ADMIN_USER` and `ADMIN_PASS`.
4. Redeploy. Votes and settings are stored in Redis, so they survive across serverless instances.

Locally (no Redis vars), everything is stored in `data.json`.

## Environment variables

| Variable     | Default       |
|--------------|---------------|
| `PORT`       | `3000`        |
| `ADMIN_USER` | `admin`       |
| `ADMIN_PASS` | `admin@123`   |
| `DATA_FILE`  | `./data.json` |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — (Upstash Redis; also accepts `UPSTASH_REDIS_REST_URL` / `_TOKEN`) |
| `SESSION_SECRET` | optional extra secret for admin login tokens |
