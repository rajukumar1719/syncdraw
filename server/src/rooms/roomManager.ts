import type { Room, Collaborator, Stroke, Point, CollaborativeOperation, OperationRecord } from '../types/collaboration.js';
import { createRoomState, reconstructRoomStrokes } from './roomState.js';
import {
  MAX_USERS_PER_ROOM,
  MAX_ACTIVE_STROKES_PER_USER,
  MAX_ACTIVE_STROKES_PER_ROOM,
  MAX_OPERATIONS_PER_ROOM,
  MAX_STROKES_PER_ROOM,
} from '../utils/validation.js';

/**
 * In-Memory Room Manager
 * Authoritative registry managing active rooms, collaborator presence, and memory release.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();

  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  public createRoom(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

    const newRoom = createRoomState(roomId);
    this.rooms.set(roomId, newRoom);
    console.log(`[RoomManager] Room created: ${roomId} (Total active rooms: ${this.rooms.size})`);
    return newRoom;
  }

  public getOrCreateRoom(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    return this.createRoom(roomId);
  }

  private roomCleanupTimers = new Map<string, NodeJS.Timeout>();

  public cancelRoomCleanup(roomId: string): void {
    const timer = this.roomCleanupTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.roomCleanupTimers.delete(roomId);
    }
  }

  public scheduleRoomCleanup(roomId: string, delayMs = 120000): void {
    this.cancelRoomCleanup(roomId);
    const timer = setTimeout(() => {
      this.roomCleanupTimers.delete(roomId);
      const room = this.rooms.get(roomId);
      if (room && room.users.size === 0) {
        this.rooms.delete(roomId);
        console.log(`[RoomManager] Room cleaned up after grace period: ${roomId} (Remaining active rooms: ${this.rooms.size})`);
      }
    }, delayMs);
    this.roomCleanupTimers.set(roomId, timer);
  }

  public addUser(roomId: string, user: Collaborator): { success: boolean; error?: { code: string; message: string } } {
    this.cancelRoomCleanup(roomId);
    const room = this.getOrCreateRoom(roomId);

    // Enforce maximum collaborators per room
    if (!room.users.has(user.id) && room.users.size >= MAX_USERS_PER_ROOM) {
      return {
        success: false,
        error: {
          code: 'ROOM_FULL',
          message: `Room has reached maximum limit of ${MAX_USERS_PER_ROOM} collaborators.`,
        },
      };
    }

    room.users.set(user.id, user);
    return { success: true };
  }

  public removeUser(roomId: string, userId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const removed = room.users.delete(userId);
    if (removed && room.users.size === 0) {
      // If room has persistent history, retain state during temporary reconnects
      if (room.strokes.length > 0 || room.operations.length > 0) {
        this.scheduleRoomCleanup(roomId, 120000);
      } else {
        this.rooms.delete(roomId);
        console.log(`[RoomManager] Room cleaned up: ${roomId} (Remaining active rooms: ${this.rooms.size})`);
      }
    }
    return removed;
  }

  public getUsers(roomId: string): Collaborator[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.users.values());
  }

  public deleteRoomIfEmpty(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    if (room.users.size === 0) {
      if (room.strokes.length > 0 || room.operations.length > 0) {
        this.scheduleRoomCleanup(roomId, 120000);
        return false;
      }
      this.rooms.delete(roomId);
      console.log(`[RoomManager] Room cleaned up: ${roomId} (Remaining active rooms: ${this.rooms.size})`);
      return true;
    }

    return false;
  }

  public getActiveRoomCount(): number {
    return this.rooms.size;
  }

  // Drawing State Management
  public startStroke(roomId: string, stroke: Stroke): { success: boolean; error?: { code: string; message: string } } {
    const room = this.getOrCreateRoom(roomId);

    if (room.activeStrokes.size >= MAX_ACTIVE_STROKES_PER_ROOM) {
      return {
        success: false,
        error: {
          code: 'MAX_ACTIVE_STROKES_EXCEEDED',
          message: `Room exceeds maximum allowed in-flight strokes (${MAX_ACTIVE_STROKES_PER_ROOM}).`,
        },
      };
    }

    let userActiveCount = 0;
    for (const active of room.activeStrokes.values()) {
      if (active.userId === stroke.userId) {
        userActiveCount++;
      }
    }

    if (userActiveCount >= MAX_ACTIVE_STROKES_PER_USER) {
      return {
        success: false,
        error: {
          code: 'MAX_USER_ACTIVE_STROKES',
          message: `User exceeds maximum allowed in-flight strokes (${MAX_ACTIVE_STROKES_PER_USER}).`,
        },
      };
    }

    room.activeStrokes.set(stroke.id, stroke);
    return { success: true };
  }

  public appendStrokePoints(roomId: string, strokeId: string, points: Point[]): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;

    const active = room.activeStrokes.get(strokeId);
    if (!active) return false;

    // Guard max points per stroke to prevent unbounded memory consumption
    if (active.points.length + points.length <= 10000) {
      active.points.push(...points);
    }
    return true;
  }

  public finalizeStroke(roomId: string, strokeId: string): Stroke | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const stroke = room.activeStrokes.get(strokeId);
    if (!stroke) {
      // Stroke might already be in room.strokes or already finalized
      return null;
    }

    room.activeStrokes.delete(strokeId);

    // Prevent duplicate entries in room.strokes
    if (!room.strokes.some((s) => s.id === stroke.id)) {
      room.strokes.push(stroke);
    }

    // Automatically record corresponding add-stroke operation if not already recorded
    const opId = `op_${stroke.id}`;
    if (!room.appliedOperationIds.has(opId)) {
      room.appliedOperationIds.add(opId);
      const record: OperationRecord = {
        operation: {
          operationId: opId,
          type: 'add-stroke',
          userId: stroke.userId,
          stroke,
          timestamp: stroke.createdAt || Date.now(),
        },
        active: true,
      };
      room.operations.push(record);
      room.operationMap.set(opId, record);
    }

    return stroke;
  }

  public eraseStrokes(roomId: string, strokeIds: string[], operationId?: string, userId?: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    const idSet = new Set(strokeIds);
    const erasedIds: string[] = [];

    room.strokes = room.strokes.filter((s) => {
      if (idSet.has(s.id)) {
        erasedIds.push(s.id);
        return false;
      }
      return true;
    });

    // Also remove from active strokes if any
    for (const id of strokeIds) {
      if (room.activeStrokes.has(id)) {
        room.activeStrokes.delete(id);
        if (!erasedIds.includes(id)) {
          erasedIds.push(id);
        }
      }
    }

    // Record erase operation if provided and not already recorded
    if (operationId && !room.appliedOperationIds.has(operationId)) {
      room.appliedOperationIds.add(operationId);
      const record: OperationRecord = {
        operation: {
          operationId,
          type: 'erase-strokes',
          userId: userId || '',
          strokeIds,
          timestamp: Date.now(),
        },
        active: true,
      };
      room.operations.push(record);
      room.operationMap.set(operationId, record);
    }

    return erasedIds;
  }

  public getStrokes(roomId: string): Stroke[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.strokes];
  }

  public getOperations(roomId: string): OperationRecord[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.operations];
  }

  /**
   * Applies an authoritative collaborative operation (add-stroke, erase-strokes, clear-canvas, undo, redo).
   */
  public applyCollaborativeOperation(
    roomId: string,
    op: CollaborativeOperation
  ): { success: boolean; duplicate?: boolean; record?: OperationRecord; error?: { code: string; message: string } } {
    const room = this.getOrCreateRoom(roomId);

    // Idempotent duplicate check: return duplicate flag and existing record via O(1) Map lookup
    if (room.appliedOperationIds.has(op.operationId)) {
      const existingRecord = room.operationMap.get(op.operationId) || room.operations.find((r) => r.operation.operationId === op.operationId);
      return {
        success: true,
        duplicate: true,
        record: existingRecord,
      };
    }

    // Resource limit: maximum operations per room
    if (room.operations.length >= MAX_OPERATIONS_PER_ROOM) {
      return {
        success: false,
        error: {
          code: 'MAX_OPERATIONS_EXCEEDED',
          message: `Room has reached maximum allowed operation history (${MAX_OPERATIONS_PER_ROOM}).`,
        },
      };
    }

    // Resource limit: maximum strokes per room on add-stroke
    if (op.type === 'add-stroke' && room.strokes.length >= MAX_STROKES_PER_ROOM) {
      return {
        success: false,
        error: {
          code: 'MAX_STROKES_EXCEEDED',
          message: `Room has reached maximum allowed stroke limit (${MAX_STROKES_PER_ROOM}).`,
        },
      };
    }

    if (op.type === 'undo') {
      const targetRecord = room.operationMap.get(op.targetOperationId) || room.operations.find((r) => r.operation.operationId === op.targetOperationId);
      if (!targetRecord) {
        return {
          success: false,
          error: { code: 'TARGET_NOT_FOUND', message: `Target operation ${op.targetOperationId} not found in history.` },
        };
      }

      // Author-scoped undo enforcement: user can only undo their own operations
      if (targetRecord.operation.userId !== op.userId) {
        return {
          success: false,
          error: { code: 'AUTHOR_MISMATCH', message: 'Cannot undo another user\'s operation.' },
        };
      }

      if (!targetRecord.active) {
        return {
          success: false,
          error: { code: 'ALREADY_UNDONE', message: `Target operation ${op.targetOperationId} is already undone.` },
        };
      }

      // Deactivate target operation
      targetRecord.active = false;

      // Commit undo operation record
      const record: OperationRecord = { operation: op, active: true };
      room.operations.push(record);
      room.operationMap.set(op.operationId, record);
      room.appliedOperationIds.add(op.operationId);

      // Deterministically rebuild canonical room strokes
      room.strokes = reconstructRoomStrokes(room.operations);
      return { success: true, record };
    }

    if (op.type === 'redo') {
      const targetRecord = room.operationMap.get(op.targetOperationId) || room.operations.find((r) => r.operation.operationId === op.targetOperationId);
      if (!targetRecord) {
        return {
          success: false,
          error: { code: 'TARGET_NOT_FOUND', message: `Target operation ${op.targetOperationId} not found in history.` },
        };
      }

      // Author-scoped redo enforcement: user can only redo their own operations
      if (targetRecord.operation.userId !== op.userId) {
        return {
          success: false,
          error: { code: 'AUTHOR_MISMATCH', message: 'Cannot redo another user\'s operation.' },
        };
      }

      if (targetRecord.active) {
        return {
          success: false,
          error: { code: 'NOT_UNDONE', message: `Target operation ${op.targetOperationId} is not currently undone.` },
        };
      }

      // Reactivate target operation
      targetRecord.active = true;

      // Commit redo operation record
      const record: OperationRecord = { operation: op, active: true };
      room.operations.push(record);
      room.operationMap.set(op.operationId, record);
      room.appliedOperationIds.add(op.operationId);

      // Deterministically rebuild canonical room strokes
      room.strokes = reconstructRoomStrokes(room.operations);
      return { success: true, record };
    }

    if (op.type === 'add-stroke') {
      const record: OperationRecord = { operation: op, active: true };
      room.operations.push(record);
      room.operationMap.set(op.operationId, record);
      room.appliedOperationIds.add(op.operationId);

      // Add to room.strokes if not present
      if (!room.strokes.some((s) => s.id === op.stroke.id)) {
        room.strokes.push(op.stroke);
      }
      return { success: true, record };
    }

    if (op.type === 'erase-strokes') {
      const record: OperationRecord = { operation: op, active: true };
      room.operations.push(record);
      room.operationMap.set(op.operationId, record);
      room.appliedOperationIds.add(op.operationId);

      const idSet = new Set(op.strokeIds);
      room.strokes = room.strokes.filter((s) => !idSet.has(s.id));
      for (const id of op.strokeIds) {
        room.activeStrokes.delete(id);
      }
      return { success: true, record };
    }

    if (op.type === 'clear-canvas') {
      const record: OperationRecord = { operation: op, active: true };
      room.operations.push(record);
      room.operationMap.set(op.operationId, record);
      room.appliedOperationIds.add(op.operationId);

      room.strokes = [];
      room.activeStrokes.clear();
      return { success: true, record };
    }

    return {
      success: false,
      error: { code: 'INVALID_OPERATION_TYPE', message: 'Unsupported operation type.' },
    };
  }

  public cleanActiveStrokesForUser(roomId: string, userId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    const cleanedIds: string[] = [];
    for (const [strokeId, stroke] of room.activeStrokes.entries()) {
      if (stroke.userId === userId) {
        cleanedIds.push(strokeId);
        room.activeStrokes.delete(strokeId);
      }
    }
    return cleanedIds;
  }
}

export const roomManager = new RoomManager();
