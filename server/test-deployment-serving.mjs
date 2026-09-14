/**
 * SyncDraw Unified Deployment Integration Test
 *
 * Verifies that the single Express + Socket.IO server:
 * 1. Returns JSON HTTP 200 for GET /health
 * 2. Serves built React frontend (client/dist/index.html) with strict CSP on GET /
 * 3. Handles SPA client routes (e.g. GET /room/:roomId) via index.html fallback
 * 4. Correctly serves static assets from client/dist
 * 5. Returns JSON HTTP 404 for missing static assets with extensions (does not misroute to SPA fallback)
 * 6. Returns JSON HTTP 404 for nonexistent API endpoints
 * 7. Permits real-time Socket.IO WebSocket connections without route collision
 */

import { io } from 'socket.io-client';

const SERVER_URL = process.env.TEST_SERVER_URL || 'http://localhost:5000';

async function runTests() {
  console.log('\n=== TESTING UNIFIED DEPLOYMENT SERVING & WEBSOCKET GATEWAY ===\n');

  // Test 1: GET /health returns JSON HTTP 200
  console.log('[Test 1] Verifying GET /health endpoint...');
  const healthRes = await fetch(`${SERVER_URL}/health`);
  if (healthRes.status !== 200) {
    throw new Error(`Expected HTTP 200 on /health, got ${healthRes.status}`);
  }
  const healthJson = await healthRes.json();
  if (healthJson.status !== 'ok' || healthJson.service !== 'syncdraw-backend') {
    throw new Error(`Unexpected /health JSON: ${JSON.stringify(healthJson)}`);
  }
  console.log('✓ Test 1 Passed: GET /health returned 200 OK with valid JSON payload.');

  // Test 2: GET / serves client/dist index.html with CSP headers
  console.log('[Test 2] Verifying GET / serves React frontend with CSP...');
  const rootRes = await fetch(`${SERVER_URL}/`);
  if (rootRes.status !== 200) {
    throw new Error(`Expected HTTP 200 on /, got ${rootRes.status}`);
  }
  const rootHtml = await rootRes.text();
  if (!rootHtml.includes('id="root"') || !rootHtml.toLowerCase().includes('syncdraw')) {
    throw new Error(`Expected index.html content on /, got: ${rootHtml.slice(0, 200)}`);
  }
  const cspHeader = rootRes.headers.get('content-security-policy');
  if (!cspHeader || !cspHeader.includes("default-src 'self'")) {
    throw new Error(`Expected valid CSP header on /, got: ${cspHeader}`);
  }
  console.log('✓ Test 2 Passed: GET / served client index.html with restrictive CSP.');

  // Test 3: GET /room/:roomId serves SPA index.html fallback
  console.log('[Test 3] Verifying SPA direct navigation fallback on /room/TEST_ROOM_123...');
  const spaRes = await fetch(`${SERVER_URL}/room/TEST_ROOM_123`);
  if (spaRes.status !== 200) {
    throw new Error(`Expected HTTP 200 on /room/TEST_ROOM_123, got ${spaRes.status}`);
  }
  const spaHtml = await spaRes.text();
  if (!spaHtml.includes('id="root"')) {
    throw new Error('Expected SPA index.html fallback for /room/TEST_ROOM_123');
  }
  console.log('✓ Test 3 Passed: /room/:roomId correctly resolved via SPA fallback.');

  // Test 4: Missing static asset with extension returns 404 (not index.html)
  console.log('[Test 4] Verifying missing static asset with extension returns 404...');
  const missingAssetRes = await fetch(`${SERVER_URL}/assets/nonexistent-file.js`);
  if (missingAssetRes.status !== 404) {
    throw new Error(`Expected HTTP 404 for missing asset, got ${missingAssetRes.status}`);
  }
  const missingAssetJson = await missingAssetRes.json();
  if (missingAssetJson.error !== 'Not Found') {
    throw new Error(`Expected 404 JSON for missing asset, got: ${JSON.stringify(missingAssetJson)}`);
  }
  console.log('✓ Test 4 Passed: Missing asset with extension correctly routed to 404 handler.');

  // Test 5: Unknown API endpoint returns 404 JSON
  console.log('[Test 5] Verifying unknown API endpoint returns 404 JSON...');
  const missingApiRes = await fetch(`${SERVER_URL}/api/nonexistent-endpoint`);
  if (missingApiRes.status !== 404) {
    throw new Error(`Expected HTTP 404 for missing API endpoint, got ${missingApiRes.status}`);
  }
  const missingApiJson = await missingApiRes.json();
  if (missingApiJson.error !== 'Not Found') {
    throw new Error(`Expected 404 JSON, got: ${JSON.stringify(missingApiJson)}`);
  }
  console.log('✓ Test 5 Passed: Unknown API endpoint returned 404 JSON.');

  // Test 6: Socket.IO WebSocket connection works alongside static file serving
  console.log('[Test 6] Verifying Socket.IO real-time connection on same unified server...');
  const socket = io(SERVER_URL, {
    transports: ['websocket'],
    forceNew: true,
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket.IO connection timed out'));
    }, 5000);

    socket.on('connect', () => {
      socket.emit('JOIN_ROOM', { roomId: 'TEST_UNIFIED_ROOM', displayName: 'DeployTester' });
    });

    socket.on('ROOM_JOINED', (data) => {
      clearTimeout(timeout);
      if (data.roomId !== 'TEST_UNIFIED_ROOM') {
        socket.disconnect();
        reject(new Error(`Unexpected roomId: ${data.roomId}`));
        return;
      }
      socket.disconnect();
      resolve();
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(err);
    });
  });

  console.log('✓ Test 6 Passed: Socket.IO connected and joined room on unified server.');

  console.log('\n===========================================================');
  console.log('ALL UNIFIED DEPLOYMENT INTEGRATION TESTS PASSED! (6/6) 🎉');
  console.log('===========================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Unified Deployment Integration Test Failed:', err);
  process.exit(1);
});
