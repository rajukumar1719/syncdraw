async function verifyProduction() {
  console.log('=== VERIFYING LIVE RAILWAY PRODUCTION DEPLOYMENT ===\n');

  // 1. Health check
  const healthRes = await fetch('https://syncdraw-production.up.railway.app/health');
  console.log('[Health Check] HTTP Status:', healthRes.status);
  const healthData = await healthRes.json();
  console.log('[Health Check] Body:', JSON.stringify(healthData));

  // 2. Root SPA
  const rootRes = await fetch('https://syncdraw-production.up.railway.app/');
  console.log('\n[Root SPA /] HTTP Status:', rootRes.status);
  const csp = rootRes.headers.get('content-security-policy');
  console.log('[Root SPA /] CSP Header:', csp);
  const rootHtml = await rootRes.text();
  console.log('[Root SPA /] Title and Icon present:');
  console.log('  Favicon link:', rootHtml.includes('href="/favicon.svg"'));
  console.log('  SyncDraw title:', rootHtml.includes('SyncDraw'));

  // 3. Favicon asset
  const faviconRes = await fetch('https://syncdraw-production.up.railway.app/favicon.svg');
  console.log('\n[Favicon /favicon.svg] HTTP Status:', faviconRes.status);
  console.log('[Favicon /favicon.svg] Content-Type:', faviconRes.headers.get('content-type'));
  const faviconText = await faviconRes.text();
  console.log('[Favicon /favicon.svg] Valid SVG:', faviconText.includes('<svg') && faviconText.includes('</svg>'));

  // 4. SPA route direct navigation (/room/:roomId)
  const roomRes = await fetch('https://syncdraw-production.up.railway.app/room/PROD_TEST_ROOM');
  console.log('\n[SPA Fallback /room/PROD_TEST_ROOM] HTTP Status:', roomRes.status);
  const roomHtml = await roomRes.text();
  console.log('[SPA Fallback /room/PROD_TEST_ROOM] HTML root container present:', roomHtml.includes('id="root"'));

  // 5. Check CSS & JS bundle integrity
  const scriptMatch = rootHtml.match(/src="([^"]+\.js)"/);
  const cssMatch = rootHtml.match(/href="([^"]+\.css)"/);

  if (scriptMatch) {
    const jsUrl = 'https://syncdraw-production.up.railway.app' + scriptMatch[1];
    const jsRes = await fetch(jsUrl);
    console.log(`\n[JS Bundle ${scriptMatch[1]}] HTTP Status:`, jsRes.status);
    const jsText = await jsRes.text();
    console.log('[JS Bundle] Contains ALREADY_CANONICAL handler:', jsText.includes('ALREADY_CANONICAL'));
  }

  if (cssMatch) {
    const cssUrl = 'https://syncdraw-production.up.railway.app' + cssMatch[1];
    const cssRes = await fetch(cssUrl);
    console.log(`\n[CSS Bundle ${cssMatch[1]}] HTTP Status:`, cssRes.status);
    const cssText = await cssRes.text();
    console.log('[CSS Bundle] Contains system font stack:', cssText.includes('-apple-system') || cssText.includes('BlinkMacSystemFont'));
    console.log('[CSS Bundle] Contains NO googleapis reference:', !cssText.includes('googleapis.com'));
  }

  console.log('\n===========================================================');
  console.log('PRODUCTION VERIFICATION COMPLETE! 🎉');
  console.log('===========================================================');
}

verifyProduction().catch(console.error);
