import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { RoomHeader } from '../components/RoomHeader';
import { Canvas, type CanvasRef } from '../components/canvas/Canvas';
import { CursorOverlay, type CursorOverlayRef } from '../components/collaboration/CursorOverlay';
import { Toolbar } from '../components/canvas/Toolbar';
import { ClearConfirmDialog } from '../components/canvas/ClearConfirmDialog';
import { PerfOverlay } from '../components/debug/PerfOverlay';
import { normalizeRoomId, isValidRoomId } from '../utils/roomId';
import { getUserSession, setUserSession } from '../utils/storage';
import {
  exportCanvasToPng,
  TOOL_DEFAULT_WIDTHS,
  reconstructCanvasState,
  findLatestUndoableOperation,
  findLatestRedoableOperation,
} from '../canvas';
import {
  createCollaborationClient,
  type CollaborationClient,
  PendingOperationQueue,
  readAllPendingRecordsFromStorage,
} from '../collaboration';
import type { UserSession } from '../types';
import type { Stroke, CanvasSettings, CanvasOperation, DrawingTool, Point } from '../canvas';
import type {
  Collaborator,
  ConnectionStatus,
  CollaborativeOperation,
  OperationRecord,
} from '../collaboration';

export const RoomPage: React.FC = () => {
  const { roomId: rawRoomId } = useParams<{ roomId: string }>();
  const roomId = rawRoomId ? normalizeRoomId(rawRoomId) : '';
  const isRoomValid = isValidRoomId(roomId);

  const canvasRef = useRef<CanvasRef>(null);
  const cursorOverlayRef = useRef<CursorOverlayRef>(null);
  const clientRef = useRef<CollaborationClient | null>(null);

  const [session, setSession] = useState<UserSession | null>(() => getUserSession());
  const [directJoinName, setDirectJoinName] = useState<string>('');
  const [joinError, setJoinError] = useState<string | null>(null);

  const displayName = session?.displayName || '';
  const hasSession = Boolean(session && session.displayName);

  // Initialize initial pending state directly from storage without accessing refs in render
  const [pendingCount, setPendingCount] = useState<number>(() => {
    if (!roomId || !displayName) return 0;
    const records = readAllPendingRecordsFromStorage().filter(
      (r) => r.roomId === roomId && r.userSessionId === displayName
    );
    return records.length;
  });

  // Collaborative Operation History Log: hydrated from persisted pending queue if any
  const [operations, setOperations] = useState<OperationRecord[]>(() => {
    if (!roomId || !displayName) return [];
    const records = readAllPendingRecordsFromStorage().filter(
      (r) => r.roomId === roomId && r.userSessionId === displayName
    );
    return records.map((r) => ({ operation: r.operation, active: true }));
  });

  // Drawing state: Canonical collection of finalized strokes
  const [strokes, setStrokes] = useState<Stroke[]>(() => {
    if (!roomId || !displayName) return [];
    const records = readAllPendingRecordsFromStorage().filter(
      (r) => r.roomId === roomId && r.userSessionId === displayName
    );
    const initialRecords = records.map((r) => ({ operation: r.operation, active: true }));
    return reconstructCanvasState(initialRecords);
  });

  const appliedOperationIds = useRef<Set<string>>(
    new Set(
      roomId && displayName
        ? readAllPendingRecordsFromStorage()
            .filter((r) => r.roomId === roomId && r.userSessionId === displayName)
            .map((r) => r.operation.operationId)
        : []
    )
  );

  // Durable Client-Side Pending Operation Queue (accessed only in effects/callbacks)
  const queueRef = useRef<PendingOperationQueue | null>(null);
  useEffect(() => {
    if (isRoomValid && roomId && displayName) {
      queueRef.current = new PendingOperationQueue(roomId, displayName);
    }
    return () => {
      queueRef.current?.destroy();
      queueRef.current = null;
    };
  }, [isRoomValid, roomId, displayName]);

  // Clear confirmation modal state
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);

  // Canvas tool and brush settings
  const [settings, setSettings] = useState<CanvasSettings>({
    tool: 'pen',
    color: '#111111',
    width: 4,
  });

  // Real-Time Collaboration & Presence State
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | undefined>(undefined);

  // Author-scoped undo/redo eligibility for the local participant (memoized to avoid scanning on unrelated renders)
  const effectiveAuthorId = currentUserId || displayName;
  const canUndo = useMemo(
    () => Boolean(findLatestUndoableOperation(operations, effectiveAuthorId)),
    [operations, effectiveAuthorId]
  );
  const canRedo = useMemo(
    () => Boolean(findLatestRedoableOperation(operations, effectiveAuthorId)),
    [operations, effectiveAuthorId]
  );

  // Establish real-time connection lifecycle strictly when user is in the room
  useEffect(() => {
    if (!hasSession || !isRoomValid || !roomId || !displayName) return;

    const client = createCollaborationClient({
      roomId,
      displayName,
      onStatusChange: (status) => {
        setConnectionStatus(status);
      },
      onRoomJoined: (data) => {
        setCurrentUserId(data.user.id);
        setCollaborators(data.collaborators);
      },
      onUserJoined: (data) => {
        setCollaborators((prev) => {
          if (prev.some((c) => c.id === data.user.id)) return prev;
          return [...prev, data.user];
        });
      },
      onUserLeft: (data) => {
        setCollaborators((prev) => prev.filter((c) => c.id !== data.userId));
        // Discard any active strokes for the disconnected user to prevent ghost strokes
        canvasRef.current?.cleanRemoteStrokesForUser(data.userId);
        cursorOverlayRef.current?.removeRemoteCursor(data.userId);
      },
      onCursorUpdate: (data) => {
        cursorOverlayRef.current?.updateRemoteCursor(data.userId, data.x, data.y);
      },
      onSyncState: (data) => {
        // Hydrate canvas and operation log with room's authoritative state
        const canonicalOpIds = new Set<string>();
        if (data.operations && data.operations.length > 0) {
          for (const rec of data.operations) {
            canonicalOpIds.add(rec.operation.operationId);
            appliedOperationIds.current.add(rec.operation.operationId);
          }
        }
        if (data.strokes && data.strokes.length > 0) {
          for (const s of data.strokes) {
            canonicalOpIds.add(`op_${s.id}`);
            appliedOperationIds.current.add(`op_${s.id}`);
          }
        }

        // Reconcile local pending queue: drop operations already canonical on server
        const opsToReplay = queueRef.current?.reconcileWithCanonical(canonicalOpIds) || [];
        setPendingCount(queueRef.current?.getPendingCount() || 0);

        // Deterministic state reconstruction: canonical server state + local pending operations
        const pendingOps = queueRef.current?.getPendingOperations() || [];
        for (const op of pendingOps) {
          appliedOperationIds.current.add(op.operationId);
        }

        const combinedOperations: OperationRecord[] = [
          ...(data.operations || []),
          ...pendingOps.map((op) => ({ operation: op, active: true })),
        ];

        setOperations(combinedOperations);
        setStrokes(reconstructCanvasState(combinedOperations));

        // Replay only missing unacknowledged operations in chronological order
        for (const op of opsToReplay) {
          queueRef.current?.markSent(op.operationId);
          clientRef.current?.sendOperation(op);
        }
      },
      onOperationApplied: (data) => {
        const op = data.operation;
        // Even if ack was lost or delayed, an operation applied broadcast confirms it is canonical
        queueRef.current?.acknowledge(op.operationId);
        setPendingCount(queueRef.current?.getPendingCount() || 0);

        if (appliedOperationIds.current.has(op.operationId)) {
          setOperations((prev) => {
            if (prev.some((r) => r.operation.operationId === op.operationId)) return prev;
            return [...prev, { operation: op, active: true }];
          });
          return;
        }

        appliedOperationIds.current.add(op.operationId);

        setOperations((prev) => {
          let nextOps: OperationRecord[];
          if (op.type === 'undo') {
            nextOps = prev.map((r) =>
              r.operation.operationId === op.targetOperationId ? { ...r, active: false } : r
            );
            nextOps.push({ operation: op, active: true });
          } else if (op.type === 'redo') {
            nextOps = prev.map((r) =>
              r.operation.operationId === op.targetOperationId ? { ...r, active: true } : r
            );
            nextOps.push({ operation: op, active: true });
          } else {
            nextOps = [...prev, { operation: op, active: true }];
          }

          setStrokes(reconstructCanvasState(nextOps));
          return nextOps;
        });
      },
      onOperationAck: (ack) => {
        if (ack.accepted) {
          queueRef.current?.acknowledge(ack.operationId);
          setPendingCount(queueRef.current?.getPendingCount() || 0);
        } else {
          console.warn(`[Operation Rejected] ${ack.operationId}:`, ack.reason);
          queueRef.current?.reject(ack.operationId);
          setPendingCount(queueRef.current?.getPendingCount() || 0);
        }
      },
      onDrawStart: (data) => {
        canvasRef.current?.handleRemoteDrawStart(data);
      },
      onDrawUpdate: (data) => {
        canvasRef.current?.handleRemoteDrawUpdate(data);
      },
      onDrawEnd: (data) => {
        canvasRef.current?.handleRemoteDrawEnd(data);
      },
      onEraseStrokes: (data) => {
        const idSet = new Set(data.strokeIds);
        setStrokes((prev) => prev.filter((s) => !idSet.has(s.id)));
      },
      onError: (err) => {
        console.error('[Room Collaboration Error]:', err.code, err.message);
      },
    });

    clientRef.current = client;

    return () => {
      clientRef.current = null;
      client.disconnect();
    };
  }, [hasSession, isRoomValid, roomId, displayName]);

  // Unified dispatcher for all local mutations (drawing, erasing, undo, redo, clear)
  const dispatchLocalOperation = useCallback((colOp: CollaborativeOperation) => {
    // 1. Enqueue to durable pending queue and persist
    queueRef.current?.enqueue(colOp);
    setPendingCount(queueRef.current?.getPendingCount() || 0);

    // 2. Mark applied locally
    appliedOperationIds.current.add(colOp.operationId);

    // 3. Update local operations and canvas state
    setOperations((prev) => {
      let nextOps: OperationRecord[];
      if (colOp.type === 'undo') {
        nextOps = prev.map((r) =>
          r.operation.operationId === colOp.targetOperationId ? { ...r, active: false } : r
        );
        nextOps.push({ operation: colOp, active: true });
      } else if (colOp.type === 'redo') {
        nextOps = prev.map((r) =>
          r.operation.operationId === colOp.targetOperationId ? { ...r, active: true } : r
        );
        nextOps.push({ operation: colOp, active: true });
      } else {
        nextOps = [...prev, { operation: colOp, active: true }];
      }

      setStrokes(reconstructCanvasState(nextOps));
      return nextOps;
    });

    // 4. If connected, dispatch over socket and mark sent
    if (clientRef.current?.getConnectionState() === 'connected') {
      queueRef.current?.markSent(colOp.operationId);
      clientRef.current.sendOperation(colOp);
    }
  }, []);

  // Handles finalized local drawing strokes
  const handleOperation = useCallback(
    (op: CanvasOperation) => {
      if (op.type === 'add-stroke') {
        const stroke = op.stroke;
        const opId = `op_${stroke.id}`;
        const colOp: CollaborativeOperation = {
          operationId: opId,
          type: 'add-stroke',
          userId: currentUserId || displayName,
          stroke,
          timestamp: stroke.createdAt || Date.now(),
        };

        dispatchLocalOperation(colOp);
      }
    },
    [currentUserId, displayName, dispatchLocalOperation]
  );

  // Author-scoped Undo: Deactivates current user's latest active operation
  const handleUndo = useCallback(() => {
    const authorId = currentUserId || displayName;
    const targetOp = findLatestUndoableOperation(operations, authorId);
    if (!targetOp) return;

    const undoOpId = `op_undo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const undoOperation: CollaborativeOperation = {
      operationId: undoOpId,
      type: 'undo',
      userId: authorId,
      targetOperationId: targetOp.operationId,
      timestamp: Date.now(),
    };

    dispatchLocalOperation(undoOperation);
  }, [currentUserId, displayName, operations, dispatchLocalOperation]);

  // Author-scoped Redo: Reactivates current user's most recently undone operation
  const handleRedo = useCallback(() => {
    const authorId = currentUserId || displayName;
    const targetOp = findLatestRedoableOperation(operations, authorId);
    if (!targetOp) return;

    const redoOpId = `op_redo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const redoOperation: CollaborativeOperation = {
      operationId: redoOpId,
      type: 'redo',
      userId: authorId,
      targetOperationId: targetOp.operationId,
      timestamp: Date.now(),
    };

    dispatchLocalOperation(redoOperation);
  }, [currentUserId, displayName, operations, dispatchLocalOperation]);

  // Collaborative Clear Canvas: Emits clear-canvas operation preserving history for undo
  const handleConfirmClear = () => {
    setIsClearDialogOpen(false);
    const clearOpId = `op_clear_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const clearOperation: CollaborativeOperation = {
      operationId: clearOpId,
      type: 'clear-canvas',
      userId: currentUserId || displayName,
      timestamp: Date.now(),
    };

    dispatchLocalOperation(clearOperation);
  };

  // Export PNG
  const handleExportPng = async () => {
    const canvasEl = canvasRef.current?.getCanvasElement();
    if (!canvasEl) return;
    const filename = `syncdraw-${roomId || 'canvas'}.png`;
    const success = await exportCanvasToPng(canvasEl, filename);
    if (!success) {
      alert('Unable to export the canvas. Please try again.');
    }
  };

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcuts if the user is typing in an input, textarea, or contenteditable
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const isCtrlOrCmd = isMac ? e.metaKey : e.ctrlKey;

      // Undo: Ctrl+Z / Cmd+Z (without Shift)
      if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Redo: Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y
      if (
        (isCtrlOrCmd && e.shiftKey && e.key.toLowerCase() === 'z') ||
        (!isMac && isCtrlOrCmd && e.key.toLowerCase() === 'y')
      ) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Tool shortcuts (single keys, no modifiers)
      if (!isCtrlOrCmd && !e.altKey) {
        if (e.key.toLowerCase() === 'p') {
          e.preventDefault();
          setSettings((prev) => ({ ...prev, tool: 'pen', width: TOOL_DEFAULT_WIDTHS.pen }));
        } else if (e.key.toLowerCase() === 'h') {
          e.preventDefault();
          setSettings((prev) => ({
            ...prev,
            tool: 'highlighter',
            width: Math.max(14, prev.width),
          }));
        } else if (e.key.toLowerCase() === 'e') {
          e.preventDefault();
          setSettings((prev) => ({
            ...prev,
            tool: 'eraser',
            width: Math.max(14, prev.width),
          }));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleUndo, handleRedo]);

  // Stabilized callbacks for Canvas and Toolbar to prevent unnecessary re-renders
  const handleRemoteStrokeComplete = useCallback((stroke: Stroke) => {
    const opId = `op_${stroke.id}`;
    if (!appliedOperationIds.current.has(opId)) {
      appliedOperationIds.current.add(opId);
      setOperations((prev) => {
        if (prev.some((r) => r.operation.operationId === opId)) return prev;
        return [
          ...prev,
          {
            operation: {
              operationId: opId,
              type: 'add-stroke',
              userId: stroke.userId,
              stroke,
              timestamp: stroke.createdAt || Date.now(),
            },
            active: true,
          },
        ];
      });
    }
    setStrokes((prev) => {
      if (prev.some((s) => s.id === stroke.id)) return prev;
      return [...prev, stroke];
    });
  }, []);

  const handleLocalDrawStart = useCallback((data: {
    strokeId: string;
    tool: DrawingTool;
    color: string;
    width: number;
    point: Point;
  }) => {
    clientRef.current?.sendDrawStart(data);
  }, []);

  const handleLocalDrawMove = useCallback((strokeId: string, point: Point) => {
    clientRef.current?.queueStrokePoint(strokeId, point);
  }, []);

  const handleLocalDrawEnd = useCallback((strokeId: string) => {
    clientRef.current?.sendDrawEnd(strokeId);
  }, []);

  const handleLocalErase = useCallback(
    (strokeIds: string[]) => {
      if (strokeIds.length > 0) {
        const operationId = `op_erase_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const colOp: CollaborativeOperation = {
          operationId,
          type: 'erase-strokes',
          userId: currentUserId || displayName,
          strokeIds,
          timestamp: Date.now(),
        };

        dispatchLocalOperation(colOp);

        if (clientRef.current?.getConnectionState() === 'connected') {
          clientRef.current?.sendEraseStrokes({ operationId, strokeIds });
        }
      }
    },
    [currentUserId, displayName, dispatchLocalOperation]
  );

  const handleLocalCursorMove = useCallback((point: Point) => {
    clientRef.current?.sendCursorMove(point.x, point.y);
  }, []);

  const handleOpenClearDialog = useCallback(() => {
    setIsClearDialogOpen(true);
  }, []);

  const handleCancelClearDialog = useCallback(() => {
    setIsClearDialogOpen(false);
  }, []);

  const getClientPingLatency = useCallback(() => {
    return clientRef.current?.getPingLatency() ?? null;
  }, []);

  const handleDirectJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = directJoinName.trim();
    if (!trimmed) {
      setJoinError('Please enter your name to enter the room.');
      return;
    }
    if (trimmed.length < 2) {
      setJoinError('Display name must be at least 2 characters.');
      return;
    }
    if (trimmed.length > 30) {
      setJoinError('Display name must not exceed 30 characters.');
      return;
    }

    setJoinError(null);
    setUserSession(trimmed);
    setSession({ displayName: trimmed });
  };

  // Malformed Room ID handling
  if (!isRoomValid) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 p-8 shadow-sm text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center mx-auto">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-slate-900">Invalid Room Code</h2>
          <p className="text-xs text-slate-600">
            The room identifier <code className="font-mono font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">{rawRoomId || 'empty'}</code> is not valid. Room IDs must be 3–24 alphanumeric characters.
          </p>
          <div className="pt-2">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-all"
            >
              Return to Home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Direct Link Prompt (when user opens /room/:roomId without an existing session display name)
  if (!hasSession) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 p-8 shadow-xl text-center space-y-6">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-600 flex items-center justify-center mx-auto font-bold">
            S
          </div>

          <div>
            <h2 className="text-xl font-bold text-slate-900">Enter Room {roomId}</h2>
            <p className="text-xs text-slate-500 mt-1">
              You were invited to this drawing room. Enter your display name to enter the workspace.
            </p>
          </div>

          <form onSubmit={handleDirectJoinSubmit} className="space-y-4 text-left">
            <div>
              <label
                htmlFor="direct-name"
                className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1.5"
              >
                Your Name
              </label>
              <input
                id="direct-name"
                type="text"
                value={directJoinName}
                onChange={(e) => {
                  setDirectJoinName(e.target.value);
                  if (joinError) setJoinError(null);
                }}
                placeholder="e.g., Taylor Swift"
                maxLength={30}
                autoFocus
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all"
              />
              {joinError && (
                <p role="alert" className="mt-1.5 text-xs text-rose-600 font-medium flex items-center gap-1">
                  <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {joinError}
                </p>
              )}
            </div>

            <button
              type="submit"
              className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-xs transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              Enter Room
            </button>
          </form>

          <div className="border-t border-slate-100 pt-4">
            <Link to="/" className="text-xs text-slate-500 hover:text-slate-800">
              ← Return to landing page
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Active Interactive Drawing Workspace with Real-Time Presence
  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-100">
      {/* Room Header with Real Presence and Live Socket Connection Status */}
      <RoomHeader
        roomId={roomId}
        displayName={displayName}
        connectionStatus={connectionStatus}
        collaborators={collaborators}
        currentUserId={currentUserId}
        pendingCount={pendingCount}
      />

      {/* Drawing Canvas Area */}
      <main className="relative flex-1 w-full h-full flex flex-col overflow-hidden">
        <Canvas
          ref={canvasRef}
          userId={displayName}
          settings={settings}
          strokes={strokes}
          onOperation={handleOperation}
          onRemoteStrokeComplete={handleRemoteStrokeComplete}
          onLocalDrawStart={handleLocalDrawStart}
          onLocalDrawMove={handleLocalDrawMove}
          onLocalDrawEnd={handleLocalDrawEnd}
          onLocalErase={handleLocalErase}
          onLocalCursorMove={handleLocalCursorMove}
        />

        {/* Live Collaborative Cursor Overlay Layer */}
        <CursorOverlay
          ref={cursorOverlayRef}
          collaborators={collaborators}
          currentUserId={currentUserId}
        />

        {/* Floating Toolbar with Full Toolset */}
        <Toolbar
          settings={settings}
          onSettingsChange={setSettings}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClearClick={handleOpenClearDialog}
          onExportClick={handleExportPng}
        />

        {/* Clear Confirmation Dialog */}
        <ClearConfirmDialog
          isOpen={isClearDialogOpen}
          onConfirm={handleConfirmClear}
          onCancel={handleCancelClearDialog}
        />

        {/* Development-Only Performance Diagnostics HUD */}
        <PerfOverlay
          activeCollaboratorsCount={collaborators.length}
          operationsCount={operations.length}
          pendingQueueCount={pendingCount}
          connectionStatus={connectionStatus}
          getPingLatency={getClientPingLatency}
        />
      </main>
    </div>
  );
};

