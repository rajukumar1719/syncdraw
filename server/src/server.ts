import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import type { HealthResponse, ServerConfig } from './types/index.js';
import { initSocketServer } from './websocket/socket.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistPath = path.resolve(__dirname, '../../client/dist');
const clientIndexPath = path.join(clientDistPath, 'index.html');
const hasClientDist = fs.existsSync(clientIndexPath);

const config: ServerConfig = {
  port: Number(process.env.PORT) || 5000,
  clientUrl: process.env.CLIENT_ORIGIN || process.env.CLIENT_URL || 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV || 'development',
};

const app = express();

// Security: Disable Express server signature
app.disable('x-powered-by');

// Security: HTTP Security Headers
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // Strict CSP tailored for API endpoints vs Frontend SPA
  if (req.path === '/health' || req.path.startsWith('/api/')) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  } else {
    // Restrictive CSP allowing Vite scripts, styles, fonts, and WebSocket connections to self and configured origins
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "connect-src 'self' ws: wss: https:; " +
      "font-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'self'; " +
      "frame-ancestors 'none';"
    );
  }
  next();
});

// Configurable CORS Origin Verification
const configuredOrigins = config.clientUrl
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const isOriginAllowed = (origin: string | undefined): boolean => {
  // Allow non-browser requests without origin header (e.g., health probes, server-to-server)
  if (!origin) return true;
  if (configuredOrigins.includes(origin)) return true;
  // Always permit Railway production domain
  if (origin === 'https://syncdraw-production.up.railway.app') return true;
  // In development mode, allow any local loopback origin
  if (config.nodeEnv !== 'production') {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  }
  return false;
};

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    }
  },
  credentials: true,
}));
app.use(express.json());

// Health Check Endpoint (always returns JSON HTTP 200)
app.get('/health', (_req: Request, res: Response) => {
  const healthData: HealthResponse = {
    status: 'ok',
    service: 'syncdraw-backend',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  res.status(200).json(healthData);
});

// Serve client/dist static assets when built frontend exists
if (hasClientDist) {
  app.use(express.static(clientDistPath));

  // SPA Route Fallback: serve index.html for GET requests that don't match API/socket routes
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    // If it's a request for a missing static file with an extension, pass through to 404 handler
    if (path.extname(req.path) || req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(clientIndexPath);
  });
}

// 404 Not Found Handler for unmatched API routes or missing static assets
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource does not exist.',
  });
});

// Global Error Handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server Error]:', err.message);

  res.status(500).json({
    error: 'Internal Server Error',
    message: config.nodeEnv === 'production' ? 'An unexpected error occurred.' : err.message,
  });
});

// HTTP Server & WebSocket Server
const httpServer = http.createServer(app);
const io = initSocketServer(httpServer, (origin, callback) => {
  if (isOriginAllowed(origin)) {
    callback(null, true);
  } else {
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  }
});

const server = httpServer.listen(config.port, () => {
  console.log(`[SyncDraw Server] Running in ${config.nodeEnv} mode`);
  console.log(`[SyncDraw Server] Listening on http://localhost:${config.port}`);
  console.log(`[SyncDraw Server] Health check available at http://localhost:${config.port}/health`);
});

// Graceful Shutdown
const handleShutdown = (signal: string) => {
  console.log(`[SyncDraw Server] Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('[SyncDraw Server] HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

export { app, httpServer, io };
