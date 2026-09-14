import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  Collaborator,
  Stroke,
} from '../types/collaboration.js';
import { roomManager } from '../rooms/roomManager.js';
import {
  validateJoinRoomPayload,
  validateDrawStartPayload,
  validateDrawUpdatePayload,
  validateDrawEndPayload,
  validateEraseStrokesPayload,
  validateCursorMovePayload,
  validateOperationApplyPayload,
} from '../utils/validation.js';
import { assignCollaboratorColor } from '../utils/colors.js';
import { socketRateLimiter } from '../security/rateLimiter.js';

export function initSocketServer(
  httpServer: HttpServer,
  allowedOrigin: string | string[] | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void)
): SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData> {
  const io = new SocketIOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    cors: {
      origin: allowedOrigin as string,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    // 1. JOIN_ROOM Handler
    socket.on('JOIN_ROOM', (rawPayload) => {
      // Rate limit check: prevent rapid-fire join/flood abuse
      if (!socketRateLimiter.consume(socket.id, 'joinRoom')) {
        socket.emit('ERROR', {
          code: 'RATE_LIMITED',
          message: 'Room join rate limit exceeded. Please wait a moment before trying again.',
        });
        return;
      }

      // Validate incoming payload safely without blind casting
      const validation = validateJoinRoomPayload(rawPayload);
      if (!validation.valid || !validation.data) {
        socket.emit('ERROR', {
          code: validation.error?.code || 'INVALID_PAYLOAD',
          message: validation.error?.message || 'Invalid payload received.',
        });
        return;
      }

      const { roomId, displayName } = validation.data;

      // Clean up previous room association if socket rejoins
      if (socket.data.roomId && socket.data.user) {
        const prevRoomId = socket.data.roomId;
        const prevUserId = socket.data.user.id;
        socket.leave(prevRoomId);
        roomManager.removeUser(prevRoomId, prevUserId);
        socket.to(prevRoomId).emit('USER_LEFT', { userId: prevUserId });
      }

      // Assign color avoiding duplicates in the room
      const existingUsers = roomManager.getUsers(roomId);
      const color = assignCollaboratorColor(existingUsers);

      // Server is authoritative for identity and assignment
      const collaborator: Collaborator = {
        id: socket.id,
        name: displayName,
        color,
        joinedAt: Date.now(),
      };

      // Add user to room with capacity check
      const addResult = roomManager.addUser(roomId, collaborator);
      if (!addResult.success) {
        socket.emit('ERROR', addResult.error || {
          code: 'ROOM_FULL',
          message: 'Room has reached maximum allowed collaborator limit.',
        });
        return;
      }

      // Store in socket session data and join room
      socket.data.roomId = roomId;
      socket.data.user = collaborator;
      socket.join(roomId);

      // Acknowledge joining socket with room state and roster
      const currentCollaborators = roomManager.getUsers(roomId);
      socket.emit('ROOM_JOINED', {
        roomId,
        user: collaborator,
        collaborators: currentCollaborators,
      });

      // Synchronize existing finalized room drawing state with the new participant
      const existingStrokes = roomManager.getStrokes(roomId);
      const existingOperations = roomManager.getOperations(roomId);
      socket.emit('SYNC_STATE', {
        strokes: existingStrokes,
        operations: existingOperations,
      });

      // Notify other participants in the same room
      socket.to(roomId).emit('USER_JOINED', {
        user: collaborator,
      });

      console.log(
        `[WebSocket] ${displayName} (${socket.id}) joined room ${roomId} (Users: ${currentCollaborators.length}, Strokes: ${existingStrokes.length})`
      );
    });

    // 2. DRAW_START Handler
    socket.on('DRAW_START', (rawPayload) => {
      const roomId = socket.data.roomId;
      const user = socket.data.user;

      if (!roomId || !user) {
        socket.emit('ERROR', {
          code: 'UNAUTHORIZED_ACTION',
          message: 'Must join a room before drawing.',
        });
        return;
      }

      const validation = validateDrawStartPayload(rawPayload);
      if (!validation.valid || !validation.data) {
        socket.emit('ERROR', {
          code: validation.error?.code || 'INVALID_DRAW_START',
          message: validation.error?.message || 'Invalid DRAW_START payload.',
        });
        return;
      }

      const { strokeId, tool, color, width, point } = validation.data;

      // Track active stroke in server room with capacity checks
      const newStroke: Stroke = {
        id: strokeId,
        userId: user.id, // Authoritative server ID
        tool,
        color,
        width,
        points: [point],
        createdAt: Date.now(),
      };

      const startResult = roomManager.startStroke(roomId, newStroke);
      if (!startResult.success) {
        socket.emit('ERROR', startResult.error || {
          code: 'DRAW_REJECTED',
          message: 'Could not start stroke.',
        });
        return;
      }

      // Broadcast exclusively to other clients in this room (avoid echo)
      socket.to(roomId).emit('DRAW_START', {
        strokeId,
        userId: user.id,
        tool,
        color,
        width,
        point,
      });
    });

    // 3. DRAW_UPDATE Handler (Batched Points)
    socket.on('DRAW_UPDATE', (rawPayload) => {
      const roomId = socket.data.roomId;
      const user = socket.data.user;

      if (!roomId || !user) {
        socket.emit('ERROR', {
          code: 'UNAUTHORIZED_ACTION',
          message: 'Must join a room before drawing.',
        });
        return;
      }

      // Rate limit check: prevent flooding of point updates
      if (!socketRateLimiter.consume(socket.id, 'drawUpdate')) {
        socket.emit('ERROR', {
          code: 'RATE_LIMITED',
          message: 'Drawing update rate limit exceeded.',
        });
        return;
      }

      const validation = validateDrawUpdatePayload(rawPayload);
      if (!validation.valid || !validation.data) {
        return; // Drop invalid batch silently without crashing
      }

      const { strokeId, points } = validation.data;

      // Append points to active stroke in server memory
      roomManager.appendStrokePoints(roomId, strokeId, points);

      // Broadcast points batch to peers in room
      socket.to(roomId).emit('DRAW_UPDATE', {
        strokeId,
        userId: user.id,
        points,
      });
    });

    // 4. DRAW_END Handler
    socket.on('DRAW_END', (rawPayload) => {
      const roomId = socket.data.roomId;
      const user = socket.data.user;

      if (!roomId || !user) {
        socket.emit('ERROR', {
          code: 'UNAUTHORIZED_ACTION',
          message: 'Must join a room before drawing.',
        });
        return;
      }

      const validation = validateDrawEndPayload(rawPayload);
      if (!validation.valid || !validation.data) return;

      const { strokeId } = validation.data;

      // Finalize stroke and store in canonical room strokes
      roomManager.finalizeStroke(roomId, strokeId);

      // Broadcast finalization to room peers
      socket.to(roomId).emit('DRAW_END', {
        strokeId,
        userId: user.id,
      });
    });

    // 5. ERASE_STROKES Handler (Logical Stroke Deletion)
    socket.on('ERASE_STROKES', (rawPayload) => {
      const roomId = socket.data.roomId;
      const user = socket.data.user;

      if (!roomId || !user) {
        socket.emit('ERROR', {
          code: 'UNAUTHORIZED_ACTION',
          message: 'Must join a room before erasing.',
        });
        return;
      }

      if (!socketRateLimiter.consume(socket.id, 'operation')) {
        socket.emit('ERROR', {
          code: 'RATE_LIMITED',
          message: 'Operation rate limit exceeded.',
        });
        return;
      }

      const validation = validateEraseStrokesPayload(rawPayload);
      if (!validation.valid || !validation.data) return;

      const { operationId, strokeIds } = validation.data;

      // Apply stroke deletion to server room state
      const erased = roomManager.eraseStrokes(roomId, strokeIds, operationId, user.id);
      if (erased.length > 0) {
        socket.to(roomId).emit('ERASE_STROKES', {
          operationId,
          strokeIds: erased,
          userId: user.id,
        });
      }
    });

    // 6. CURSOR_MOVE Handler (Collaborative Live Cursors)
    socket.on('CURSOR_MOVE', (rawPayload) => {
      const roomId = socket.data.roomId;
      const user = socket.data.user;

      if (!roomId || !user) {
        socket.emit('ERROR', {
          code: 'UNAUTHORIZED_ACTION',
          message: 'Must join a room before sending cursor updates.',
        });
        return;
      }

      // Rate limit check: drop excess cursor events silently to prevent event loop saturation
      if (!socketRateLimiter.consume(socket.id, 'cursor')) {
        return;
      }

      const validation = validateCursorMovePayload(rawPayload);
      if (!validation.valid || !validation.data) {
        return; // Drop malformed cursor coordinates safely without crashing
      }

      // Broadcast exclusively to peers in the same room (zero echo, zero leak)
      socket.to(roomId).emit('CURSOR_UPDATE', {
        userId: user.id,
        x: validation.data.x,
        y: validation.data.y,
        timestamp: Date.now(),
      });
    });

    // 7. OPERATION_APPLY Handler (Author-Scoped Collaborative Operations)
    socket.on('OPERATION_APPLY', (rawPayload) => {
      const roomId = socket.data.roomId;
      const user = socket.data.user;

      if (!roomId || !user) {
        socket.emit('ERROR', {
          code: 'UNAUTHORIZED_ACTION',
          message: 'Must join a room before submitting operations.',
        });
        return;
      }

      // Rate limit check: operations flood protection
      if (!socketRateLimiter.consume(socket.id, 'operation')) {
        const rawOp =
          typeof rawPayload === 'object' && rawPayload !== null && 'operation' in rawPayload
            ? (rawPayload as { operation?: { operationId?: string } }).operation
            : undefined;
        const opId = rawOp?.operationId || '';

        socket.emit('OPERATION_ACK', {
          operationId: opId,
          accepted: false,
          reason: 'RATE_LIMITED',
        });
        socket.emit('ERROR', {
          code: 'RATE_LIMITED',
          message: 'Operation rate limit exceeded. Please wait before submitting more operations.',
        });
        return;
      }

      const validation = validateOperationApplyPayload(rawPayload);
      if (!validation.valid || !validation.data) {
        const rawOp =
          typeof rawPayload === 'object' && rawPayload !== null && 'operation' in rawPayload
            ? (rawPayload as { operation?: { operationId?: string } }).operation
            : undefined;
        const opId = rawOp?.operationId || '';

        socket.emit('OPERATION_ACK', {
          operationId: opId,
          accepted: false,
          reason: validation.error?.message || 'Invalid operation payload.',
        });

        socket.emit('ERROR', validation.error || {
          code: 'INVALID_OPERATION_PAYLOAD',
          message: 'Invalid operation payload.',
        });
        return;
      }

      const operation = validation.data.operation;
      // Server authority: enforce authoritative user ID from active socket
      operation.userId = user.id;

      const result = roomManager.applyCollaborativeOperation(roomId, operation);

      // Idempotent duplicate check: already canonical
      if (result.duplicate) {
        socket.emit('OPERATION_ACK', {
          operationId: operation.operationId,
          accepted: true,
          reason: 'ALREADY_CANONICAL',
        });
        return;
      }

      if (!result.success) {
        socket.emit('OPERATION_ACK', {
          operationId: operation.operationId,
          accepted: false,
          reason: result.error?.message || 'Operation could not be applied.',
        });
        socket.emit('ERROR', result.error || {
          code: 'OPERATION_REJECTED',
          message: 'Operation could not be applied.',
        });
        return;
      }

      // Authoritatively acknowledge the applying socket
      socket.emit('OPERATION_ACK', {
        operationId: operation.operationId,
        accepted: true,
      });

      // Broadcast the accepted canonical operation to all room participants
      io.to(roomId).emit('OPERATION_APPLIED', {
        operation,
      });
    });

    // 8. Disconnect Handler
    socket.on('disconnect', (reason) => {
      // Clear socket rate limiter state
      socketRateLimiter.clearSocket(socket.id);

      const roomId = socket.data.roomId;
      const user = socket.data.user;

      if (roomId && user) {
        // Clean up any incomplete strokes initiated by this user
        const abandonedStrokes = roomManager.cleanActiveStrokesForUser(roomId, user.id);
        if (abandonedStrokes.length > 0) {
          for (const strokeId of abandonedStrokes) {
            socket.to(roomId).emit('DRAW_END', { strokeId, userId: user.id });
          }
        }

        roomManager.removeUser(roomId, user.id);
        socket.to(roomId).emit('USER_LEFT', { userId: user.id });
        console.log(`[WebSocket] ${user.name} (${user.id}) left room ${roomId} [reason: ${reason}]`);
      }
    });

    socket.on('error', (err) => {
      console.error(`[WebSocket Error] Socket ${socket.id}:`, err.message);
    });
  });

  console.log('[WebSocket] Real-time collaboration gateway initialized.');
  return io;
}
