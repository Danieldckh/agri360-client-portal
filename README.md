# Agri360 Client Portal

A small, standalone client-facing web app for ProAgri / Agri360. **No login** — it
is opened via a shared link. It talks to the Agri360 CRM request-forms surface
through a server-side proxy so the shared portal key is **never** exposed to the
browser.

## Architecture

A tiny Express server that:

1. Serves the static SPA from `./public`.
2. Proxies **every** `/api/*` request to the CRM (`CRM_API_BASE`), injecting the
   `X-Portal-Key` header server-side. The CRM's status + JSON is returned verbatim.

Node 20 has global `fetch`, so the only dependency is **express**.

```
browser  ──/api/*──►  this server  ──X-Portal-Key──►  Agri360 CRM
   (never sees the key)
```

## Features (two only)

### 1. Focus-points form — `/form/:token`
- `GET /api/request-forms/public/:token` to load the questionnaire.
- Renders fields (text, long text, number, date, select, radio, checkbox).
- `POST /api/request-forms/public/:token/submit` with `{ responses }`.
- Shows a thank-you state on success. The CRM auto-advances the linked
  deliverable (`request_focus_points` / `focus_points_requested` →
  `focus_points_received`).

### 2. Content-calendar approvals — `/approvals/:clientToken`
- `GET /api/request-forms/public/portal/:clientToken/approvals` lists the
  client's CC deliverables awaiting approval (red "Approval required" cards).
- Opening a card shows a gallery of only the post/size cards that have media.
- Per card:
  - **Approve** → `POST /api/request-forms/public/portal/approve`
    `{ deliverableId, postIndex, size }`.
  - **Review** → detail view: image + caption in a rich-text (contenteditable)
    editor + a change-request box (body + optional screenshot) →
    `POST /api/request-forms/public/portal/change-request`
    `{ deliverableId, postIndex, body, screenshots, captionEdits }`.
- Respects the CRM's 3-round change cap: a `409` shows
  *"No change rounds left — please approve."*
- When all shown cards are approved the CRM auto-advances; the app re-fetches and
  shows the approved state (with the approval date the CRM returns).

## Environment

| Var            | Default                            | Purpose                                  |
| -------------- | ---------------------------------- | ---------------------------------------- |
| `CRM_API_BASE` | `https://agri360.proagrihub.com`   | CRM API base URL the proxy targets.      |
| `PORTAL_KEY`   | *(required)*                       | Shared key, sent as `X-Portal-Key`.      |
| `PORT`         | `3000`                             | Port the server listens on.              |

Copy `.env.example` → `.env` for local dev. In production set these in Coolify
env (never commit the real key).

## Run locally

```bash
npm install
PORTAL_KEY=... npm start
# http://localhost:3000/form/<token>
# http://localhost:3000/approvals/<clientToken>
```

`GET /health` returns `200` for health checks.

## Deploy (Coolify)

Build the Docker image (`node:20-alpine`, `EXPOSE 3000`, `CMD node server.js`)
and set `CRM_API_BASE`, `PORTAL_KEY`, `PORT` in the Coolify environment.
