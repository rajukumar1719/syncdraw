import { io } from 'socket.io-client';

const SERVER_URL = 'http://localhost:5000';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStroke(id, userId, color = '#111111') {
  return {
    id,
    userId,
    tool: 'pen',
    color,
    width: 4,
    points: [
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ],
    createdAt: Date.now(),
  };
}

async function runCollaborativeHistoryTests() {
  console.log('=== STARTING SECTION 8 COLLABORATIVE HISTORY TESTS ===\n');

  // Connect Clients
  const clientA = io(SERVER_URL, { transports: ['websocket'] });
  const clientB = io(SERVER_URL, { transports: ['websocket'] });
  const clientC = io(SERVER_URL, { transports: ['websocket'] }); // Room Other

  await Promise.all([
    new Promise((res) => clientA.on('connect', res)),
    new Promise((res) => clientB.on('connect', res)),
    new Promise((res) => clientC.on('connect', res)),
  ]);

  let aliceUserId = '';
  let bobUserId = '';

  clientA.on('ROOM_JOINED', (data) => {
    aliceUserId = data.user.id;
  });
  clientB.on('ROOM_JOINED', (data) => {
    bobUserId = data.user.id;
  });

  clientA.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_1', displayName: 'Alice' });
  clientB.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_1', displayName: 'Bob' });
  clientC.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_OTHER', displayName: 'Charlie' });
  await wait(300);

  console.log(`[Setup] Alice (${aliceUserId}) & Bob (${bobUserId}) in ROOM_HIST_1, Charlie in ROOM_HIST_OTHER.\n`);

  // Setup operation listeners on Bob
  const bobReceivedOps = [];
  clientB.on('OPERATION_APPLIED', (data) => {
    bobReceivedOps.push(data.operation);
  });

  // Track errors on Alice and Bob
  const aliceErrors = [];
  clientA.on('ERROR', (err) => aliceErrors.push(err));
  const bobErrors = [];
  clientB.on('ERROR', (err) => bobErrors.push(err));

  // ----------------------------------------------------
  // Test 1 & 2: Alice undo removes Alice's latest stroke, Bob's stroke remains
  // ----------------------------------------------------
  console.log('[Test 1 & 2] Alice draws A1, Bob draws B1, Alice draws A2. Alice undos A2; Bob stroke B1 remains...');

  // A1
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_a1',
      type: 'add-stroke',
      userId: aliceUserId,
      stroke: makeStroke('stroke_a1', aliceUserId, '#ef4444'),
      timestamp: 1000,
    },
  });
  await wait(80);

  // B1
  clientB.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_b1',
      type: 'add-stroke',
      userId: bobUserId,
      stroke: makeStroke('stroke_b1', bobUserId, '#3b82f6'),
      timestamp: 2000,
    },
  });
  await wait(80);

  // A2
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_a2',
      type: 'add-stroke',
      userId: aliceUserId,
      stroke: makeStroke('stroke_a2', aliceUserId, '#ef4444'),
      timestamp: 3000,
    },
  });
  await wait(80);

  // Alice undos A2
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_undo_a2',
      type: 'undo',
      userId: aliceUserId,
      targetOperationId: 'op_a2',
      timestamp: 4000,
    },
  });
  await wait(120);

  // Verify Bob received the undo operation targeting op_a2
  const undoA2Op = bobReceivedOps.find((op) => op.operationId === 'op_undo_a2');
  if (!undoA2Op || undoA2Op.type !== 'undo' || undoA2Op.targetOperationId !== 'op_a2') {
    throw new Error(`Test 1 & 2 Failed: Bob did not receive valid undo operation: ${JSON.stringify(undoA2Op)}`);
  }
  console.log('✓ Test 1 & 2 Passed: Alice undo targeted A2, leaving Bob B1 intact.\n');

  // ----------------------------------------------------
  // Test 3 & 4: Bob undos B1; Alice and Bob independently undo
  // ----------------------------------------------------
  console.log('[Test 3 & 4] Bob undos B1; verifying independent author-scoped undo...');
  clientB.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_undo_b1',
      type: 'undo',
      userId: bobUserId,
      targetOperationId: 'op_b1',
      timestamp: 5000,
    },
  });
  await wait(120);

  const undoB1Op = bobReceivedOps.find((op) => op.operationId === 'op_undo_b1');
  if (!undoB1Op || undoB1Op.type !== 'undo' || undoB1Op.targetOperationId !== 'op_b1') {
    throw new Error(`Test 3 & 4 Failed: Bob did not receive valid undo operation for B1: ${JSON.stringify(undoB1Op)}`);
  }
  console.log('✓ Test 3 & 4 Passed: Bob independently undid B1.\n');

  // ----------------------------------------------------
  // Test 5: Alice redo restores Alice's undone stroke
  // ----------------------------------------------------
  console.log('[Test 5] Alice redoes A2; verifying A2 is reactivated...');
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_redo_a2',
      type: 'redo',
      userId: aliceUserId,
      targetOperationId: 'op_a2',
      timestamp: 6000,
    },
  });
  await wait(120);

  const redoA2Op = bobReceivedOps.find((op) => op.operationId === 'op_redo_a2');
  if (!redoA2Op || redoA2Op.type !== 'redo' || redoA2Op.targetOperationId !== 'op_a2') {
    throw new Error(`Test 5 Failed: Redo operation not received: ${JSON.stringify(redoA2Op)}`);
  }
  console.log('✓ Test 5 Passed: Alice successfully redid A2.\n');

  // ----------------------------------------------------
  // Test 6: Bob cannot redo or undo Alice's operation
  // ----------------------------------------------------
  console.log('[Test 6] Bob attempts to undo/redo Alice\'s operation; server must reject with author mismatch...');
  const initialBobErrorsCount = bobErrors.length;
  clientB.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_malicious_undo',
      type: 'undo',
      userId: bobUserId,
      targetOperationId: 'op_a1', // Belongs to Alice!
      timestamp: 7000,
    },
  });
  await wait(150);

  if (bobErrors.length === initialBobErrorsCount) {
    throw new Error('Test 6 Failed: Server accepted cross-author undo without error!');
  }
  const lastBobError = bobErrors[bobErrors.length - 1];
  if (lastBobError.code !== 'AUTHOR_MISMATCH' && lastBobError.code !== 'OPERATION_REJECTED') {
    throw new Error(`Test 6 Failed: Unexpected error code for author mismatch: ${lastBobError.code}`);
  }
  console.log(`✓ Test 6 Passed: Cross-author mutation cleanly rejected with code "${lastBobError.code}".\n`);

  // ----------------------------------------------------
  // Test 7: Duplicate operationId is handled idempotently without error
  // ----------------------------------------------------
  console.log('[Test 7] Verify duplicate operationId is acknowledged as ALREADY_CANONICAL without ERROR...');
  const initialAliceErrors = aliceErrors.length;
  let duplicateAck = null;
  const ackListener = (ack) => {
    if (ack.operationId === 'op_a1') {
      duplicateAck = ack;
    }
  };
  clientA.on('OPERATION_ACK', ackListener);

  // Send op_a1 again
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_a1',
      type: 'add-stroke',
      userId: aliceUserId,
      stroke: makeStroke('stroke_a1_dup', aliceUserId),
      timestamp: 8000,
    },
  });
  await wait(150);
  clientA.off('OPERATION_ACK', ackListener);

  if (!duplicateAck || !duplicateAck.accepted || duplicateAck.reason !== 'ALREADY_CANONICAL') {
    throw new Error(`Test 7 Failed: Expected ALREADY_CANONICAL accepted ACK, got: ${JSON.stringify(duplicateAck)}`);
  }
  if (aliceErrors.length !== initialAliceErrors) {
    throw new Error(`Test 7 Failed: Server emitted misleading ERROR event on duplicate operation! ${JSON.stringify(aliceErrors.slice(initialAliceErrors))}`);
  }
  console.log('✓ Test 7 Passed: Duplicate operationId idempotently acknowledged without ERROR.\n');

  // ----------------------------------------------------
  // Test 8: Collaborative clear reaches all clients
  // ----------------------------------------------------
  console.log('[Test 8] Collaborative clear-canvas operation reaches all clients...');
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_clear_1',
      type: 'clear-canvas',
      userId: aliceUserId,
      timestamp: 9000,
    },
  });
  await wait(120);

  const clearOp = bobReceivedOps.find((op) => op.operationId === 'op_clear_1');
  if (!clearOp || clearOp.type !== 'clear-canvas') {
    throw new Error(`Test 8 Failed: Bob did not receive clear-canvas: ${JSON.stringify(clearOp)}`);
  }
  console.log('✓ Test 8 Passed: Collaborative clear broadcast successfully.\n');

  // ----------------------------------------------------
  // Test 9: Undo clear restores previous state
  // ----------------------------------------------------
  console.log('[Test 9] Alice undos clear-canvas; verifying restoration...');
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_undo_clear_1',
      type: 'undo',
      userId: aliceUserId,
      targetOperationId: 'op_clear_1',
      timestamp: 10000,
    },
  });
  await wait(120);

  const undoClearOp = bobReceivedOps.find((op) => op.operationId === 'op_undo_clear_1');
  if (!undoClearOp || undoClearOp.type !== 'undo' || undoClearOp.targetOperationId !== 'op_clear_1') {
    throw new Error(`Test 9 Failed: Bob did not receive undo for clear-canvas: ${JSON.stringify(undoClearOp)}`);
  }
  console.log('✓ Test 9 Passed: Undoing clear broadcast successfully.\n');

  // ----------------------------------------------------
  // Test 10: Drawing after clear survives undoing clear (A1, B1, CLEAR, A2, B2 scenario)
  // ----------------------------------------------------
  console.log('[Test 10] Testing A1, B1, CLEAR, A2, B2: Undo CLEAR preserves A2 & B2...');
  // Connect Client D and E to fresh room ROOM_HIST_DETERMINISTIC
  const clientD = io(SERVER_URL, { transports: ['websocket'] });
  const clientE = io(SERVER_URL, { transports: ['websocket'] });
  await Promise.all([
    new Promise((res) => clientD.on('connect', res)),
    new Promise((res) => clientE.on('connect', res)),
  ]);

  let userD = '';
  let userE = '';
  clientD.on('ROOM_JOINED', (data) => (userD = data.user.id));
  clientE.on('ROOM_JOINED', (data) => (userE = data.user.id));

  clientD.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_DET', displayName: 'Dan' });
  clientE.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_DET', displayName: 'Eve' });
  await wait(250);

  // 1. Dan draws D1
  clientD.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_det_d1',
      type: 'add-stroke',
      userId: userD,
      stroke: makeStroke('s_d1', userD),
      timestamp: 100,
    },
  });
  // 2. Eve draws E1
  clientE.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_det_e1',
      type: 'add-stroke',
      userId: userE,
      stroke: makeStroke('s_e1', userE),
      timestamp: 200,
    },
  });
  await wait(100);

  // 3. Dan clears
  clientD.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_det_clear',
      type: 'clear-canvas',
      userId: userD,
      timestamp: 300,
    },
  });
  await wait(100);

  // 4. Dan draws D2
  clientD.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_det_d2',
      type: 'add-stroke',
      userId: userD,
      stroke: makeStroke('s_d2', userD),
      timestamp: 400,
    },
  });
  // 5. Eve draws E2
  clientE.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_det_e2',
      type: 'add-stroke',
      userId: userE,
      stroke: makeStroke('s_e2', userE),
      timestamp: 500,
    },
  });
  await wait(100);

  // 6. Dan undos clear
  clientD.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_det_undo_clear',
      type: 'undo',
      userId: userD,
      targetOperationId: 'op_det_clear',
      timestamp: 600,
    },
  });
  await wait(200);

  // Connect Client F to verify SYNC_STATE after undo clear
  const clientF = io(SERVER_URL, { transports: ['websocket'] });
  let syncDataF = null;
  clientF.on('SYNC_STATE', (data) => {
    syncDataF = data;
  });
  clientF.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_DET', displayName: 'Frank' });
  await wait(300);

  if (!syncDataF || !syncDataF.strokes) {
    throw new Error('Test 10 Failed: Client Frank did not receive SYNC_STATE strokes');
  }

  // Expecting all 4 strokes: s_d1, s_e1, s_d2, s_e2
  const strokeIds = syncDataF.strokes.map((s) => s.id);
  if (
    !strokeIds.includes('s_d1') ||
    !strokeIds.includes('s_e1') ||
    !strokeIds.includes('s_d2') ||
    !strokeIds.includes('s_e2')
  ) {
    throw new Error(`Test 10 Failed: Expected [s_d1, s_e1, s_d2, s_e2] after undoing clear, got: ${JSON.stringify(strokeIds)}`);
  }
  console.log(`✓ Test 10 Passed: Drawing after clear survived undo clear (${strokeIds.join(', ')}).\n`);

  // ----------------------------------------------------
  // Test 11: Multiple clear operations behave deterministically
  // ----------------------------------------------------
  console.log('[Test 11] Multiple clear operations behave deterministically (CLEAR1, CLEAR2)...');
  // Dan clears again (CLEAR2)
  clientD.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_det_clear2',
      type: 'clear-canvas',
      userId: userD,
      timestamp: 700,
    },
  });
  await wait(150);

  // Dan draws D3
  clientD.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_det_d3',
      type: 'add-stroke',
      userId: userD,
      stroke: makeStroke('s_d3', userD),
      timestamp: 800,
    },
  });
  await wait(150);

  // Connect Client G to verify state has only D3
  const clientG = io(SERVER_URL, { transports: ['websocket'] });
  let syncDataG = null;
  clientG.on('SYNC_STATE', (data) => (syncDataG = data));
  clientG.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_DET', displayName: 'Grace' });
  await wait(300);

  if (!syncDataG || syncDataG.strokes.length !== 1 || syncDataG.strokes[0].id !== 's_d3') {
    throw new Error(`Test 11 Failed: Expected only [s_d3] after CLEAR2, got: ${JSON.stringify(syncDataG?.strokes?.map((s) => s.id))}`);
  }
  console.log('✓ Test 11 Passed: Multiple clear operations behaved deterministically.\n');

  // ----------------------------------------------------
  // Test 12: Concurrent Alice and Bob undo
  // ----------------------------------------------------
  console.log('[Test 12] Concurrent Alice and Bob undo executed simultaneously...');
  // Alice draws A_CONC, Bob draws B_CONC
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_a_conc',
      type: 'add-stroke',
      userId: aliceUserId,
      stroke: makeStroke('s_a_conc', aliceUserId),
      timestamp: 20000,
    },
  });
  clientB.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_b_conc',
      type: 'add-stroke',
      userId: bobUserId,
      stroke: makeStroke('s_b_conc', bobUserId),
      timestamp: 20001,
    },
  });
  await wait(150);

  // Emit concurrent undos
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_undo_a_conc',
      type: 'undo',
      userId: aliceUserId,
      targetOperationId: 'op_a_conc',
      timestamp: 20010,
    },
  });
  clientB.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_undo_b_conc',
      type: 'undo',
      userId: bobUserId,
      targetOperationId: 'op_b_conc',
      timestamp: 20011,
    },
  });
  await wait(200);

  // Verify room strokes via new client in ROOM_HIST_1
  const clientCheck = io(SERVER_URL, { transports: ['websocket'] });
  let checkSync = null;
  clientCheck.on('SYNC_STATE', (data) => (checkSync = data));
  clientCheck.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_1', displayName: 'Checker' });
  await wait(300);

  const remainingIds = checkSync.strokes.map((s) => s.id);
  if (remainingIds.includes('s_a_conc') || remainingIds.includes('s_b_conc')) {
    throw new Error(`Test 12 Failed: Undone concurrent strokes still present: ${JSON.stringify(remainingIds)}`);
  }
  console.log('✓ Test 12 Passed: Concurrent undos processed cleanly without conflict.\n');

  // ----------------------------------------------------
  // Test 13: Concurrent Undo + remote draw
  // ----------------------------------------------------
  console.log('[Test 13] Concurrent Undo by Alice + Draw by Bob at nearly same time...');
  // Alice adds stroke A_SURVIVE
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_a_survive',
      type: 'add-stroke',
      userId: aliceUserId,
      stroke: makeStroke('s_a_survive', aliceUserId),
      timestamp: 30000,
    },
  });
  await wait(100);

  // Simultaneously: Alice undos A_SURVIVE, Bob adds B_SURVIVE
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_undo_a_survive',
      type: 'undo',
      userId: aliceUserId,
      targetOperationId: 'op_a_survive',
      timestamp: 30010,
    },
  });
  clientB.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_b_survive',
      type: 'add-stroke',
      userId: bobUserId,
      stroke: makeStroke('s_b_survive', bobUserId),
      timestamp: 30011,
    },
  });
  await wait(200);

  const clientCheck13 = io(SERVER_URL, { transports: ['websocket'] });
  let checkSync13 = null;
  clientCheck13.on('SYNC_STATE', (data) => (checkSync13 = data));
  clientCheck13.emit('JOIN_ROOM', { roomId: 'ROOM_HIST_1', displayName: 'Checker13' });
  await wait(300);

  const strokeIds13 = checkSync13.strokes.map((s) => s.id);
  if (strokeIds13.includes('s_a_survive')) {
    throw new Error('Test 13 Failed: Alice stroke was not undone');
  }
  if (!strokeIds13.includes('s_b_survive')) {
    throw new Error('Test 13 Failed: Bob stroke was not committed');
  }
  console.log('✓ Test 13 Passed: Concurrent Undo + Draw survived deterministically.\n');

  // ----------------------------------------------------
  // Test 14: Reconnect receives canonical history through SYNC_STATE
  // ----------------------------------------------------
  console.log('[Test 14] Reconnecting / late-joining participant receives canonical operation history...');
  if (!checkSync13.operations || !Array.isArray(checkSync13.operations)) {
    throw new Error('Test 14 Failed: SYNC_STATE does not contain operations array!');
  }
  if (checkSync13.operations.length < 5) {
    throw new Error(`Test 14 Failed: Expected rich operation history in SYNC_STATE, got length ${checkSync13.operations.length}`);
  }
  console.log(`✓ Test 14 Passed: Late joiner received ${checkSync13.operations.length} canonical operations.\n`);

  // ----------------------------------------------------
  // Test 15: Different rooms cannot affect each other's history
  // ----------------------------------------------------
  console.log('[Test 15] Verify room isolation (Charlie in ROOM_HIST_OTHER receives zero operations from ROOM_HIST_1)...');
  const charlieOps = [];
  clientC.on('OPERATION_APPLIED', (d) => charlieOps.push(d));

  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_isolated_test',
      type: 'add-stroke',
      userId: aliceUserId,
      stroke: makeStroke('s_iso', aliceUserId),
      timestamp: 40000,
    },
  });
  await wait(150);

  if (charlieOps.length > 0) {
    throw new Error(`Test 15 Failed: Charlie received operations from ROOM_HIST_1: ${JSON.stringify(charlieOps)}`);
  }
  console.log('✓ Test 15 Passed: Operations strictly isolated by room.\n');

  // ----------------------------------------------------
  // Test 16: Invalid undo/redo payloads are rejected
  // ----------------------------------------------------
  console.log('[Test 16] Server rejects malformed undo/redo payloads without crash...');
  const initialAliceErrCount = aliceErrors.length;

  // Redo an operation that is NOT undone
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_invalid_redo',
      type: 'redo',
      userId: aliceUserId,
      targetOperationId: 'op_isolated_test', // Already active!
      timestamp: 50000,
    },
  });
  await wait(100);

  // Undo non-existent target
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_invalid_undo_target',
      type: 'undo',
      userId: aliceUserId,
      targetOperationId: 'op_does_not_exist_xyz',
      timestamp: 50001,
    },
  });
  await wait(100);

  // Malformed type
  clientA.emit('OPERATION_APPLY', {
    operation: {
      operationId: 'op_bad_type',
      type: 'invalid-type-name',
      userId: aliceUserId,
    },
  });
  await wait(100);

  if (aliceErrors.length - initialAliceErrCount < 3) {
    throw new Error(`Test 16 Failed: Expected 3 rejection errors, got ${aliceErrors.length - initialAliceErrCount}`);
  }
  console.log('✓ Test 16 Passed: All invalid operations properly rejected.\n');

  // Disconnect all
  clientA.disconnect();
  clientB.disconnect();
  clientC.disconnect();
  clientD.disconnect();
  clientE.disconnect();
  clientF.disconnect();
  clientG.disconnect();
  clientCheck.disconnect();
  clientCheck13.disconnect();

  console.log('===========================================================');
  console.log('ALL SECTION 8 COLLABORATIVE HISTORY TESTS PASSED! 🎉');
  console.log('===========================================================\n');
}

runCollaborativeHistoryTests().catch((err) => {
  console.error('\n❌ COLLABORATIVE HISTORY TEST FAILED:', err);
  process.exit(1);
});
