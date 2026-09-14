# SyncDraw

SyncDraw is a high-performance, real-time collaborative drawing canvas and whiteboard platform. Built end-to-end in TypeScript, it enables multiple participants to sketch simultaneously in shared rooms with zero-latency vector rendering, live cursor tracking, author-scoped undo/redo, offline resilience, and defensive security rate limiting.

---

## Features

- **Real-Time Vector Sync**: Synchronizes lightweight vector operations (`DRAW_START`, `DRAW_UPDATE`, `DRAW_END`, `ERASE_STROKES`) rather than heavy canvas screenshots or bitmap diffs.
- **Local-First Zero-Latency Rendering**: Local strokes render instantaneously at native display refresh rates (60-120 FPS); network broadcasts are batched in ~25ms intervals.
- **Drawing Tools**: Pen, Highlighter (`0.35` alpha), and stroke-level Eraser with geometric point-to-segment hit detection.
- **Live Collaborative Cursors & Presence**: Decoupled GPU-accelerated cursor overlay (`translate3d`) with 30ms rate limiting, 6-second inactivity fading, and real-time collaborator presence roster with initial avatars.
- **Author-Scoped Collaborative History**: Non-destructive operation log allowing collaborators to undo and redo their own mutations without altering peers' drawings. Includes collaborative, reversible canvas clearing.
- **Offline Operation Queue & Safe Replay**: Operates 100% offline with durable `localStorage` queuing. On reconnect, missing mutations are safely reconciled against server state with zero duplicate strokes.
- **Touch & Mobile Optimized**: Minimum 40px touch targets, horizontal momentum scrolling, platform-aware keyboard shortcuts (`?` vs `Ctrl`), and responsive layouts from mobile (375px) to 4K displays.
- **Defensive Security & Rate Limiting**: Per-socket token-bucket rate limiters (`CURSOR_MOVE`, `DRAW_UPDATE`, `OPERATION_APPLY`, `JOIN_ROOM`), hard room memory bounds (50 users, 10,000 operations), input sanitization, disabled `X-Powered-By`, and strict HTTP security headers.
- **Fault-Tolerant Architecture**: Top-level React `ErrorBoundary` for graceful UI error recovery; structured protocol error notifications (`RATE_LIMITED`, `ROOM_FULL`, `AUTHOR_MISMATCH`).

---

## Architecture

SyncDraw pairs a React single-page frontend with an event-driven Node.js backend:

```text
Browser Client A (Desktop)           Browser Client B (Mobile)
       |                                     |
       | HTTPS                               | HTTPS
       ?                                     ?
Static Frontend (Vite SPA)           Static Frontend (Vite SPA)
       |                                     |
       | WSS / Socket.IO (Port 443)          | WSS / Socket.IO (Port 443)
       ?                                     ?
+------------------------------------------------------------------------+
|                   SyncDraw Real-Time Server Gateway                    |
|             (Express HTTP + Socket.IO on Node.js / TS)                 |
+------------------------------------------------------------------------+
                                    |
                         +---------------------+
                         | In-Memory Registry  |
                         |    (RoomManager)    |
                         +---------------------+
                                    |
             +---------------------------------------------+
             ?                                             ?
+-------------------------+                   +-------------------------+
|       Room ABC123       |                   |       Room XYZ789       |
|  +-- User A (#4f46e5)   |                   |  +-- User C (#0891b2)   |
|  +-- User B (#059669)   |                   |                         |
|  (Isolated Namespace)   |                   |  (Isolated Namespace)   |
+-------------------------+                   +-------------------------+
```

---

## Local Development

### Prerequisites
- Node.js `>=20.0.0` (tested on Node v24.14.1)
- npm `>=10.0.0` (tested on npm 11.11.0)

### Quick Start

```bash
# 1. Clone repository and install dependencies
npm install

# 2. Configure environment files from templates
cp .env.example .env
cp client/.env.example client/.env
cp server/.env.example server/.env

# 3. Start development environment (runs client on :5173 and server on :5000)
npm run dev
```

Alternatively, run each workspace independently:

```bash
# Run backend server only (starts on http://localhost:5000)
npm run dev:server

# Run frontend client only (starts on http://localhost:5173)
npm run dev:client
```

---

## Environment Variables

SyncDraw cleanly separates client build-time variables from server runtime variables:

### Frontend Variables (`client/.env` or build environment)
| Variable | Description | Default / Example |
|---|---|---|
| `VITE_API_URL` | Public URL of deployed backend gateway | `http://localhost:5000` (production: `https://syncdraw-backend.onrender.com`) |
| `VITE_SERVER_URL` | Alias for `VITE_API_URL` (backward compatibility) | `http://localhost:5000` |
| `VITE_PERF_DEBUG` | Mounts diagnostic FPS/latency HUD by default | `false` (toggleable in browser via `?debug=true`) |

### Backend Variables (`server/.env` or platform config)
| Variable | Description | Default / Example |
|---|---|---|
| `PORT` | Server listen port (injected automatically by cloud PaaS) | `5000` |
| `NODE_ENV` | Environment mode (`development` \| `production`) | `development` |
| `CLIENT_ORIGIN` | Allowed frontend origin(s) for HTTP and Socket.IO CORS | `http://localhost:5173` (production: `https://syncdraw.onrender.com`) |
| `CLIENT_URL` | Alias for `CLIENT_ORIGIN` (supports comma-separated origins) | `http://localhost:5173` |

---

## Production Build

To compile both frontend and backend for production:

```bash
npm run build
```

Individual workspace build commands:
```bash
# Compile backend TypeScript to server/dist/
npm run build:server

# Bundle client to client/dist/ with Vite
npm run build:client
```

To run the compiled backend locally in production mode:
```bash
npm run start -w server
# Or directly:
node server/dist/server.js
```

---

## Deployment

SyncDraw requires a **persistent Node.js process** for the backend to support long-lived Socket.IO WebSocket connections. Serverless platforms (e.g. AWS Lambda without WebSockets) are incompatible.

### Recommended Provider: Render (Infrastructure Blueprint)

The repository includes a production-ready `render.yaml` blueprint deploying:
1. **Backend**: Render Web Service (persistent Node.js + Express + Socket.IO on Starter/Standard tier).
2. **Frontend**: Render Static Site (Vite Single Page Application on Free/Static tier).

#### Step-by-Step Deployment Steps:

1. **Push repository to GitHub**:
   Ensure all changes are committed and pushed to your GitHub repository.

2. **Connect to Render**:
   - Log in to [Render Dashboard](https://dashboard.render.com).
   - Click **New +** $\to$ **Blueprint**.
   - Connect your SyncDraw repository.
   - Render reads `render.yaml` and initializes both services.

3. **Configure Environment Variables**:
   - On the backend service (`syncdraw-backend`), verify:
     - `NODE_ENV`: `production`
     - `CLIENT_ORIGIN`: `https://<your-frontend-subdomain>.onrender.com`
   - On the frontend service (`syncdraw-frontend`), set:
     - `VITE_API_URL`: `https://<your-backend-subdomain>.onrender.com`

4. **Deploy**:
   - Trigger deployment.
   - The backend builds via `npm install && npm run build:server` and starts via `npm run start -w server`.
   - The frontend builds via `npm install && npm run build:client` and serves `client/dist`.
   - The `client/public/_redirects` file guarantees SPA fallback (`/* /index.html 200`) for direct `/room/:roomId` links.

### Manual VPS / Docker / Alternative Deployment:
For traditional Linux VPS (Ubuntu, Debian) or PaaS (Railway, Fly.io):
- **Backend**: Execute `npm install && npm run build:server`, run `npm run start -w server` via `pm2` or `systemd`, reverse-proxy through Nginx with WebSocket upgrade headers (`Upgrade $http_upgrade`, `Connection "upgrade"`), and configure SSL via Let's Encrypt Certbot.
- **Frontend**: Serve `client/dist` via Nginx, Caddy, Vercel, or Cloudflare Pages with SPA rewrite `try_files $uri $uri/ /index.html =404;`.

---

## Health Check

The backend exposes an unauthenticated, lightweight health endpoint:

```http
GET /health
```

**Response (HTTP 200)**:
```json
{
  "status": "ok",
  "service": "syncdraw-backend",
  "uptime": 1464,
  "timestamp": "2026-09-14T05:22:59.108Z"
}
```
Used by cloud uptime monitors and load balancers to verify service health without triggering database or disk overhead.

---

## WebSocket Configuration

SyncDraw connects over Socket.IO using WebSocket transport with automatic polling fallback:
- **Development**: Connects to `http://localhost:5000` via `ws://`.
- **Production**: When served over HTTPS, Socket.IO connects to `VITE_API_URL` and establishes a secure `wss://` connection.
- **Disconnection & Heartbeats**: Socket.IO ping/pong packets monitor connectivity. If dropped, exponential backoff reconnects automatically while preserving the local drawing queue.

---

## Testing & Quality Assurance

SyncDraw features 6 comprehensive automated test suites covering all system dimensions:

```bash
# 1. Real-time drawing synchronization (11 test cases)
npm run test:drawing -w server

# 2. Live collaborative cursors & room isolation (7 test cases)
npm run test:cursor -w server

# 3. Collaborative history & author-scoped undo/redo (16 test cases)
npm run test:history -w server

# 4. Reconnect resilience & offline operation replay (16 test cases)
npm run test:reconnect -w server

# 5. Performance & scalability stress suite (6 stress test cases)
npm run test:performance -w server

# 6. Security, rate limiting & abuse hardening (22 test cases)
npm run test:security -w server
```

**Overall Test Suite Status: 78 / 78 tests passing (100% green).**

Code quality commands:
```bash
# Strict TypeScript validation across all workspaces
npm run typecheck

# ESLint flat config validation on client workspace
npm run lint -w client
```

---

## Accessibility

- **Keyboard Navigation**: Full keyboard shortcuts (`P`, `H`, `E`, `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Escape`). Shortcuts are suppressed automatically while typing in text inputs.
- **Focus States**: Visible focus rings (`focus-visible:ring-2 focus-visible:ring-indigo-500`) across all buttons, palette swatches, and inputs.
- **Dialog Trapping**: Focus trapping, `Escape` key dismissal, backdrop click dismissal, and `role="dialog"` modal semantics.
- **Live Status Announcements**: `aria-live="polite"` announces pending offline changes and dynamic connection states to assistive technologies.
- **Touch Targets**: Minimum 40px touch targets (`min-w-[40px] min-h-[40px]`) prevent mis-taps on mobile devices.
- **Motion Adaptation**: `prefers-reduced-motion` suppresses spinning and pulsing animations.
- *Honest Note*: Universal WCAG compliance cannot be claimed for the freehand 2D canvas drawing surface itself, as arbitrary sketches lack semantic text equivalents.

---

## Security

Comprehensive threat modeling, validation rules, rate-limiting parameters, and audit findings are documented in [SECURITY.md](SECURITY.md).
- **Rate Limiting**: Sliding-window token buckets per connection (`CURSOR_MOVE`, `DRAW_UPDATE`, `OPERATION_APPLY`, `JOIN_ROOM`).
- **Authorization**: Author-scoped undo/redo enforcement and server identity rewriting to prevent spoofing.
- **Headers & CORS**: Strict production origin verification, disabled `X-Powered-By`, frame prevention, and MIME-sniffing protection.

---

## Known Limitations

1. **Single-Node In-Memory Architecture**: Room states and operation histories reside in server heap memory. Horizontal clustering across multiple servers requires a distributed Pub/Sub adapter (such as Redis) which is not yet implemented.
2. **2-Minute Reconnect Grace Period**: When all users exit a room, drawing history is preserved for 2 minutes before memory eviction. A complete server restart clears active room memory.
3. **Session-Based Pseudonymous Identity**: SyncDraw relies on session display names and transient socket IDs rather than persistent user accounts or database authentication.
4. **Offline Queue Bounds**: Browser `localStorage` offline queues are capped at 500 operations to prevent client storage quota exhaustion.
5. **Transitive `qs` Advisory**: Two moderate advisories exist in transitive dependency `qs` via `express@4.21.2` (`GHSA-x5fp-wj9c-mxmx`, `GHSA-4mjr-xmp4-gh2g`). SyncDraw does not process query strings with `qs`; dependencies are preserved to maintain runtime stability.

---

## Deployment Troubleshooting

### 1. Frontend cannot connect to backend
- Verify `VITE_API_URL` points to the exact backend URL (e.g. `https://syncdraw-backend.onrender.com`). Remember that `VITE_*` variables must be set **before** building the client.
- Check backend `CLIENT_ORIGIN`: ensure the exact frontend domain (including `https://` without a trailing slash) is included in the backend's allowed origins.
- Verify the backend is online and running (`GET /health`).

### 2. WebSocket disconnects or fails to upgrade
- Confirm your hosting provider supports persistent WebSockets. Free tiers that sleep after inactivity will disconnect active sockets; use persistent plans for production.
- Ensure reverse proxies (Nginx / Cloudflare) have WebSocket upgrades enabled (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).

### 3. Direct URL refresh on `/room/:roomId` returns 404
- The hosting provider is not forwarding client-side routes to `index.html`.
- For Render, Netlify, and Cloudflare Pages, verify `client/public/_redirects` was copied to the build root (`client/dist/_redirects`).
- For Nginx, configure `try_files $uri $uri/ /index.html;`.

### 4. Health check fails on deployment
- Ensure the backend binds to `process.env.PORT` (`0.0.0.0`), not hardcoded `localhost:5000`.
- Verify the health check path in the hosting platform is configured to `/health` (HTTP 200).

---

## License

MIT
