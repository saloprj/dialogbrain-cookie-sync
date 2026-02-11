/**
 * DialogBrain Cookie Sync - Background Service Worker
 *
 * EVENT-DRIVEN cookie synchronization for Instagram and LinkedIn.
 * Listens for cookie changes and syncs with DialogBrain backend.
 *
 * SECURITY NOTES:
 * - NEVER log cookie values
 * - All cookie data sent over HTTPS only
 * - Cookies stored only in backend, not locally
 */

// =============================================================================
// Configuration
// =============================================================================

// API endpoints
const CONFIG = {
  // Production API
  PROD_API_URL: 'https://stage-api.dialogbrain.com',
  // Development API
  DEV_API_URL: 'http://localhost:8000',

  // WebSocket URLs
  PROD_WS_URL: 'wss://stage-api.dialogbrain.com/ws/ws',
  DEV_WS_URL: 'ws://localhost:8000/ws',

  // Default settings (can be overridden in options)
  DEFAULT_INSTAGRAM_METHOD: 'direct', // 'direct' (browser extension) or 'unipile'
  DEBOUNCE_MS: 2000, // Wait 2s for cookie changes to settle
  FALLBACK_SYNC_HOURS: 6, // Periodic sync interval

  // Auto-reply WebSocket settings
  WS_RECONNECT_DELAY_MS: 3000,
  WS_MAX_RECONNECT_DELAY_MS: 30000,
  WS_HEARTBEAT_INTERVAL_MS: 30000,
};

// Cached settings (loaded from storage)
let cachedSettings = null;

// Get settings from storage (with caching)
// NOTE: Does NOT cache auth_token - that's fetched separately each time
async function getSettings() {
  // Only use cache if it exists and has valid data
  if (cachedSettings) return cachedSettings;

  const storage = await chrome.storage.local.get([
    'dev_mode',
    'instagram_sync_method',
    'auto_sync_enabled',
    'periodic_sync_enabled',
  ]);

  cachedSettings = {
    devMode: storage.dev_mode === true,
    instagramMethod: storage.instagram_sync_method || CONFIG.DEFAULT_INSTAGRAM_METHOD,
    autoSyncEnabled: storage.auto_sync_enabled !== false,
    periodicSyncEnabled: storage.periodic_sync_enabled !== false,
  };

  return cachedSettings;
}

// Get auth token with retry (waits for storage to be ready)
async function getAuthToken(maxRetries = 3, delayMs = 200) {
  for (let i = 0; i < maxRetries; i++) {
    const storage = await chrome.storage.local.get(['auth_token']);
    if (storage.auth_token) {
      return storage.auth_token;
    }
    if (i < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

// Get refresh token from storage
async function getRefreshToken() {
  const storage = await chrome.storage.local.get(['refresh_token']);
  return storage.refresh_token || null;
}

/**
 * Refresh the access token using the refresh token.
 * Returns the new access token or null if refresh failed.
 */
async function refreshAccessToken() {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    console.log('[DialogBrain] No refresh token available');
    return null;
  }

  try {
    const settings = await getSettings();
    const apiUrl = settings.devMode ? CONFIG.DEV_API_URL : CONFIG.PROD_API_URL;

    console.log('[DialogBrain] Attempting to refresh access token...');

    const response = await fetch(`${apiUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.warn('[DialogBrain] Token refresh failed:', response.status, errorData);

      // If refresh token is invalid/expired, clear all tokens
      if (response.status === 401 || response.status === 403) {
        await chrome.storage.local.remove(['auth_token', 'refresh_token']);
        console.log('[DialogBrain] Refresh token invalid, cleared all tokens');
      }
      return null;
    }

    const data = await response.json();
    const newAccessToken = data.access_token || data.accessToken;

    if (newAccessToken) {
      // Store the new access token
      await chrome.storage.local.set({ auth_token: newAccessToken });
      console.log('[DialogBrain] Access token refreshed successfully');
      return newAccessToken;
    }

    return null;
  } catch (error) {
    console.error('[DialogBrain] Token refresh error:', error);
    return null;
  }
}

// Clear settings cache when settings change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.dev_mode || changes.instagram_sync_method ||
        changes.auto_sync_enabled || changes.periodic_sync_enabled) {
      cachedSettings = null;
      console.log('[DialogBrain] Settings changed, cache cleared');
    }
  }
});

// Get current API URL based on mode
// Uses dev_mode setting from storage (set by frontend origin detection)
async function getApiUrl() {
  const settings = await getSettings();
  return settings.devMode ? CONFIG.DEV_API_URL : CONFIG.PROD_API_URL;
}

// Synchronous version for backward compatibility (uses cached settings)
function getApiUrlSync() {
  if (cachedSettings) {
    return cachedSettings.devMode ? CONFIG.DEV_API_URL : CONFIG.PROD_API_URL;
  }
  // Default to dev for now (will be updated by async call)
  return CONFIG.DEV_API_URL;
}

// Cookies we care about per platform
const INSTAGRAM_COOKIES = ['sessionid', 'csrftoken', 'ds_user_id', 'mid'];
const LINKEDIN_COOKIES = ['li_at', 'li_a', 'JSESSIONID'];

// =============================================================================
// State Management
// =============================================================================

// Pending sync timers (for debouncing)
let pendingSyncs = {
  instagram: null,
  linkedin: null,
};

// Track sync status (startedAt is used to detect stuck syncs after service worker restart)
let syncStatus = {
  instagram: { syncing: false, lastSync: null, error: null, startedAt: null },
  linkedin: { syncing: false, lastSync: null, error: null, startedAt: null },
};

// Sync timeout in milliseconds (30 seconds)
const SYNC_TIMEOUT_MS = 30000;

/**
 * Fetch with timeout helper.
 * Prevents hanging requests from blocking sync indefinitely.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = SYNC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

/**
 * Check and reset stuck syncs.
 * Called on popup open to handle cases where service worker was killed mid-sync.
 */
function checkAndResetStuckSyncs() {
  const now = Date.now();
  for (const platform of ['instagram', 'linkedin']) {
    if (syncStatus[platform].syncing && syncStatus[platform].startedAt) {
      const elapsed = now - syncStatus[platform].startedAt;
      if (elapsed > SYNC_TIMEOUT_MS) {
        console.log(`[DialogBrain] Resetting stuck ${platform} sync (elapsed: ${elapsed}ms)`);
        syncStatus[platform] = {
          syncing: false,
          lastSync: syncStatus[platform].lastSync,
          error: 'Sync timed out - please try again',
          startedAt: null,
        };
      }
    }
  }
}

// =============================================================================
// Auto-Reply Draft State
// =============================================================================

/**
 * Draft state for auto-reply feature.
 * Stores pending drafts received via WebSocket.
 */
const draftState = {
  // Map of draftId -> draft object
  drafts: new Map(),

  // Per-channel auto-send settings (synced from backend)
  autoMode: {
    instagram: {
      dm_send_mode: 'draft',  // 'auto' or 'draft'
      auto_delay_seconds: 0,
    }
  },

  // WebSocket connection status
  wsConnected: false,

  // Last successful WebSocket event
  lastEventTime: null,

  // Pending drafts count by channel
  pendingCounts: {
    instagram: 0,
    telegram: 0,
    whatsapp: 0,
    email: 0,
  },

  // Auto-send queue for Instagram drafts (processed one at a time)
  autoSendQueue: [],

  // Flag to track if we're currently processing the queue
  isProcessingQueue: false,
};

// =============================================================================
// Draft State - Server is source of truth, no local persistence
// =============================================================================

/**
 * No-op: Drafts are no longer persisted locally.
 * Server is the single source of truth. Drafts are loaded via REST API on startup
 * and updated in real-time via WebSocket events.
 */
async function persistDraftState() {
  // No-op - drafts are not persisted locally anymore
}

/**
 * Clear any legacy draft data from local storage.
 * Called on startup to clean up old data from previous versions.
 */
async function restoreDraftState() {
  try {
    // Clear legacy draft storage keys (no longer used)
    await chrome.storage.local.remove(['db_drafts', 'db_drafts_timestamp', 'db_pending_counts']);
    console.log('[DialogBrain WS] Cleared legacy draft storage (server is source of truth)');
  } catch (e) {
    console.warn('[DialogBrain WS] Failed to clear legacy storage:', e.message);
  }
}

/**
 * Schedule reconnection using chrome.alarms API.
 * Unlike setTimeout, chrome.alarms survive service worker suspension.
 */
function scheduleReconnectAlarm(delayMs) {
  const alarmName = 'dialogbrain_ws_reconnect';
  chrome.alarms.create(alarmName, { delayInMinutes: delayMs / 60000 });
}

// Handle reconnect alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dialogbrain_ws_reconnect') {
    console.log('[DialogBrain WS] Reconnect alarm fired');
    extensionWS._handleReconnect();
  }
});

// =============================================================================
// ExtensionWebSocket - Real-time connection to DialogBrain backend
// =============================================================================

/**
 * WebSocket client for receiving auto-reply events from DialogBrain backend.
 *
 * Handles:
 * - auto_reply:draft_created - New draft was generated
 * - auto_reply:draft_updated - Draft status changed
 * - auto_reply:drafts_count - Pending drafts count changed
 * - auto_reply:settings_changed - Auto-mode settings changed
 */
class ExtensionWebSocket {
  constructor() {
    this.ws = null;
    this.reconnectDelay = CONFIG.WS_RECONNECT_DELAY_MS;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.isConnecting = false;
    this.intentionalClose = false;
  }

  /**
   * Connect to the backend WebSocket.
   * Returns a Promise that resolves when connected or rejects on failure.
   * This ensures the service worker stays alive until the connection completes.
   */
  async connect() {
    // Don't connect if already connecting or connected
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      console.log('[DialogBrain WS] Already connected or connecting');
      return true;
    }

    // Get auth token
    const authToken = await getAuthToken();
    if (!authToken) {
      console.log('[DialogBrain WS] No auth token - user not logged in');
      draftState.wsConnected = false;
      this._notifyContentScripts('WS_STATUS_CHANGED', { connected: false, reason: 'no_token' });
      return false;
    }

    this.isConnecting = true;
    this.intentionalClose = false;

    try {
      // Get WebSocket URL based on dev mode
      const settings = await getSettings();
      const wsUrl = settings.devMode ? CONFIG.DEV_WS_URL : CONFIG.PROD_WS_URL;

      // Create unique client ID for this extension instance
      const clientId = `extension_${chrome.runtime.id}_${Date.now()}`;
      const fullUrl = `${wsUrl}?client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(authToken)}`;

      console.log(`[DialogBrain WS] Connecting to ${wsUrl}...`);

      // Return a Promise that resolves when connection completes
      // This keeps the service worker alive until the connection is established
      return new Promise((resolve) => {
        this.ws = new WebSocket(fullUrl);

        // Timeout after 10 seconds
        const connectionTimeout = setTimeout(() => {
          console.warn('[DialogBrain WS] Connection timeout');
          this.isConnecting = false;
          this._notifyContentScripts('WS_STATUS_CHANGED', { connected: false, reason: 'timeout' });
          resolve(false);
        }, 10000);

        this.ws.onopen = async () => {
          clearTimeout(connectionTimeout);
          console.log('[DialogBrain WS] Connected successfully');
          this.isConnecting = false;
          this.reconnectDelay = CONFIG.WS_RECONNECT_DELAY_MS; // Reset delay on successful connection
          draftState.wsConnected = true;
          draftState.lastEventTime = Date.now();

          // Start heartbeat
          this._startHeartbeat();

          // Notify content scripts
          this._notifyContentScripts('WS_STATUS_CHANGED', { connected: true });

          // Load settings first (needed for auto-mode)
          await this._loadSettings();

          // Load initial drafts
          this._loadInitialDrafts();

          resolve(true);
        };

        this.ws.onmessage = (event) => {
          this._handleMessage(event);
        };

        this.ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          console.warn('[DialogBrain WS] Connection error');
          this.isConnecting = false;
          this._notifyContentScripts('WS_STATUS_CHANGED', { connected: false, reason: 'error' });
          resolve(false);
        };

        this.ws.onclose = (event) => {
          clearTimeout(connectionTimeout);
          console.log(`[DialogBrain WS] Connection closed: ${event.code} ${event.reason}`);
          this.isConnecting = false;
          draftState.wsConnected = false;
          this._stopHeartbeat();

          // Notify content scripts
          this._notifyContentScripts('WS_STATUS_CHANGED', { connected: false, code: event.code });

          // Check if this is an auth-related close (policy violation or custom auth error)
          // 1008 = Policy Violation, 4001 = Custom unauthorized
          const isAuthError = event.code === 1008 || event.code === 4001 ||
                              (event.reason && event.reason.toLowerCase().includes('auth'));

          // Reconnect if not intentionally closed
          if (!this.intentionalClose) {
            this._scheduleReconnect(isAuthError);
          }

          // Only resolve if onopen didn't already resolve
          // (onclose can be called without onopen if connection fails)
          resolve(false);
        };
      });
    } catch (e) {
      console.error('[DialogBrain WS] Connection setup error:', e.message);
      this.isConnecting = false;
      this._scheduleReconnect();
      return false;
    }
  }

  /**
   * Disconnect from the WebSocket.
   */
  disconnect() {
    this.intentionalClose = true;
    this._stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Extension disconnect');
      this.ws = null;
    }

    draftState.wsConnected = false;
    this._notifyContentScripts('WS_STATUS_CHANGED', { connected: false, reason: 'disconnect' });
  }

  /**
   * Handle incoming WebSocket message.
   */
  _handleMessage(event) {
    try {
      const data = JSON.parse(event.data);
      draftState.lastEventTime = Date.now();

      // Handle heartbeat response
      if (data.type === 'pong') {
        return;
      }

      // Backend sends 'payload', but fallback to 'data' for compatibility
      const payload = data.payload ?? data.data;

      console.log(`[DialogBrain WS] Received event: ${data.type}`, payload ? JSON.stringify(payload).substring(0, 200) : 'no payload');

      switch (data.type) {
        case 'auto_reply:draft_created':
          console.log('[DialogBrain WS] Processing draft_created, tabs count:', instagramHybrid.tabs.size);
          this._handleDraftCreated(payload);
          break;

        case 'auto_reply:draft_updated':
          console.log('[DialogBrain WS] Received draft_updated via WebSocket:', payload?.draft_id, payload?.status, payload?.response_text ? 'has_response_text' : 'no_response_text');
          this._handleDraftUpdated(payload);
          break;

        case 'auto_reply:drafts_count':
          this._handleDraftsCount(payload);
          break;

        case 'auto_reply:settings_changed':
          console.log('[DialogBrain WS] Received settings_changed via WebSocket:', payload);
          this._handleSettingsChanged(payload);
          break;

        case 'auto_reply:skip_created':
          // Skip events are for UI notification only, no action needed in extension
          console.log('[DialogBrain WS] Skip event received:', payload?.skip_reason);
          break;

        case 'session_expiring_soon':
          // Session about to expire, reconnect with new token
          console.log('[DialogBrain WS] Session expiring, will reconnect');
          break;

        default:
          // Ignore other event types
          break;
      }
    } catch (e) {
      console.warn('[DialogBrain WS] Failed to parse message:', e.message);
    }
  }

  /**
   * Handle new draft created event.
   */
  async _handleDraftCreated(payload) {
    if (!payload) return;

    // Derive channel_type from channel_ref if not provided
    let channelType = payload.channel_type;
    if (!channelType && payload.channel_ref) {
      const match = payload.channel_ref.match(/^(instagram|linkedin|telegram|whatsapp):/);
      if (match) {
        channelType = match[1];
        payload.channel_type = channelType; // Add to payload for consistency
      }
    }

    console.log(`[DialogBrain WS] Draft created: ${payload.draft_id} for ${channelType}`);

    // Phase 3: Validate channel_ref for Instagram as safety net
    // Backend already handles this correctly, but validate client-side too
    if (channelType === 'instagram') {
      // Instagram channel_ref should be "instagram:{17-digit-thread-id}"
      const validChannelRef = payload.channel_ref &&
        /^instagram:\d{15,20}$/.test(payload.channel_ref);

      if (!validChannelRef) {
        console.warn(`[DialogBrain WS] Invalid channel_ref for Instagram draft: ${payload.channel_ref}, fetching fresh from API`);
        this._fetchSingleDraft(payload.draft_id);
        return;
      }
    }

    // Store the draft
    draftState.drafts.set(payload.draft_id, {
      id: payload.draft_id,
      threadId: payload.thread_id,
      channelAccountId: payload.channel_account_id,
      channelRef: payload.channel_ref,
      channelType: channelType,
      threadTitle: payload.thread_title,
      triggerSender: payload.trigger_sender,
      triggerText: payload.trigger_text,
      responseText: payload.response_text,
      createdAt: new Date(payload.created_at),
      expiresAt: new Date(payload.expires_at),
      status: payload.status || 'pending',
    });

    // Update pending count
    if (channelType && draftState.pendingCounts[channelType] !== undefined) {
      draftState.pendingCounts[channelType]++;
    }

    // Persist to storage (survives service worker suspension)
    persistDraftState();

    // Always notify content scripts about new draft (so UI shows it)
    this._notifyContentScripts('DRAFT_CREATED', payload);

    // Check if server requested auto-send (dm_send_mode='auto')
    // Server signals this via auto_send=true in payload, NOT via status
    if (payload.auto_send) {
      console.log(`[DialogBrain WS] Auto-send enabled (dm_send_mode=auto) for draft ${payload.draft_id}`);
      this._autoApproveDraft(payload.draft_id, payload);
      return;
    }
  }

  /**
   * Handle draft updated event.
   */
  _handleDraftUpdated(payload) {
    if (!payload) return;

    console.log(`[DialogBrain WS] Draft updated: ${payload.draft_id} -> ${payload.status}`, payload.response_text ? '(with new text)' : '');

    const draft = draftState.drafts.get(payload.draft_id);
    if (draft) {
      // Special handling for "regenerated" status - update text and keep as pending
      if (payload.status === 'regenerated' && payload.response_text) {
        draft.responseText = payload.response_text;
        draft.editedText = undefined;
        draft.status = 'pending'; // Keep as pending so user can still approve/reject
        draftState.drafts.set(payload.draft_id, draft);
        persistDraftState();
        console.log(`[DialogBrain WS] Draft ${payload.draft_id} regenerated with new text`);
      }
      // Special handling for "edited" status - update edited_text and keep as pending
      else if (payload.status === 'edited' && payload.response_text) {
        draft.editedText = payload.response_text;
        draft.status = 'pending'; // Keep as pending so user can still approve/reject
        draftState.drafts.set(payload.draft_id, draft);
        persistDraftState();
        console.log(`[DialogBrain WS] Draft ${payload.draft_id} edited with new text`);
      }
      else {
        const previousStatus = draft.status;
        draft.status = payload.status;

        // Keep 'pending' and 'approved' drafts in map (approved = in queue, waiting to be sent)
        // Remove from map only for terminal states: sent, rejected, expired
        const keepInMap = ['pending', 'approved'].includes(payload.status);
        if (!keepInMap) {
          draftState.drafts.delete(payload.draft_id);

          // Update pending count
          if (draft.channelType && draftState.pendingCounts[draft.channelType] !== undefined) {
            draftState.pendingCounts[draft.channelType] = Math.max(0, draftState.pendingCounts[draft.channelType] - 1);
          }
        } else {
          // Update the draft in map with new status
          draftState.drafts.set(payload.draft_id, draft);

          // If status changed to 'approved', only auto-send if dm_send_mode is 'auto'
          // When user approves via frontend (queue_for_extension), extension should NOT auto-send
          // Instead, the frontend handles the flow and extension waits for explicit command
          if (payload.status === 'approved' && previousStatus === 'pending' && draft.channelType === 'instagram') {
            const autoModeSettings = draftState.autoMode?.instagram || {};
            const isAutoMode = autoModeSettings.dm_send_mode === 'auto';

            if (isAutoMode) {
              console.log(`[DialogBrain WS] Draft ${payload.draft_id} approved in auto-mode, adding to auto-send queue`);
              this._autoApproveDraft(payload.draft_id, {
                draft_id: payload.draft_id,
                thread_id: draft.threadId,
                channel_ref: draft.channelRef,
                channel_type: draft.channelType,
                response_text: payload.response_text || draft.editedText || draft.responseText,
                thread_title: draft.threadTitle,
              });
            } else {
              console.log(`[DialogBrain WS] Draft ${payload.draft_id} approved (manual mode), waiting for frontend to trigger send`);
            }
          }
        }
      }
    }

    // Notify content scripts
    this._notifyContentScripts('DRAFT_UPDATED', payload);
  }

  /**
   * Handle drafts count event.
   */
  _handleDraftsCount(payload) {
    if (!payload) return;

    console.log(`[DialogBrain WS] Drafts count: ${payload.pending}`);

    // This is a global count, notify content scripts
    this._notifyContentScripts('DRAFTS_COUNT', payload);
  }

  /**
   * Handle settings changed event.
   */
  async _handleSettingsChanged(payload) {
    if (!payload) return;

    const channel = payload.channel || 'instagram';
    console.log(`[DialogBrain WS] Settings changed for ${channel}:`, payload);

    // Initialize channel settings if not exists
    if (!draftState.autoMode[channel]) {
      draftState.autoMode[channel] = { dm_send_mode: 'draft', auto_delay_seconds: 0 };
    }

    // Update local auto-mode settings (in-memory only, backend is source of truth)
    draftState.autoMode[channel].dm_send_mode = payload.dm_send_mode || 'draft';
    draftState.autoMode[channel].auto_delay_seconds = payload.auto_delay_seconds || 0;

    // Notify content scripts
    this._notifyContentScripts('SETTINGS_CHANGED', payload);
    this._notifyContentScripts('AUTO_MODE_CHANGED', {
      enabled: payload.dm_send_mode === 'auto'
    });
  }

  /**
   * Auto-approve a draft (when auto-mode is enabled).
   * Adds to queue and processes one at a time when on Instagram tab.
   */
  async _autoApproveDraft(draftId, draft) {
    // Verify draft still exists and is pending
    const currentDraft = draftState.drafts.get(draftId);
    if (!currentDraft || currentDraft.status === 'sent') {
      console.log(`[DialogBrain WS] Draft ${draftId} already processed, skipping auto-approve`);
      return;
    }

    // Only auto-approve Instagram drafts (extension can only send via DOM on Instagram)
    if (draft.channel_type !== 'instagram') {
      console.log(`[DialogBrain WS] Auto-approve skipped for non-Instagram channel: ${draft.channel_type}`);
      return;
    }

    // Check if already in queue
    if (draftState.autoSendQueue.some(item => item.draftId === draftId)) {
      console.log(`[DialogBrain WS] Draft ${draftId} already in queue`);
      return;
    }

    console.log(`[DialogBrain WS] Adding draft ${draftId} to auto-send queue (already approved in DB)`);

    // Add to queue
    draftState.autoSendQueue.push({
      draftId: draftId,
      threadId: draft.thread_id,
      channelRef: draft.channel_ref,
      text: draft.response_text,
      threadTitle: draft.thread_title,
      addedAt: Date.now(),
    });

    // Update local state to reflect approved status (already approved in DB)
    if (currentDraft) {
      currentDraft.status = 'approved';
      draftState.drafts.set(draftId, currentDraft);
    }

    // Notify content scripts about queue update
    this._notifyContentScripts('AUTO_SEND_QUEUE_UPDATED', {
      queue: draftState.autoSendQueue.map(item => ({
        draftId: item.draftId,
        threadTitle: item.threadTitle,
        status: draftState.autoSendQueue[0]?.draftId === item.draftId ? 'sending' : 'queued',
      })),
    });

    // Start processing queue if not already processing
    this._processAutoSendQueue();
  }

  /**
   * Process the auto-send queue one at a time.
   * Only sends when on Instagram tab.
   */
  async _processAutoSendQueue() {
    // Skip if already processing or queue is empty
    if (draftState.isProcessingQueue || draftState.autoSendQueue.length === 0) {
      return;
    }

    // Check if Instagram tab is open
    if (instagramHybrid.tabs.size === 0) {
      console.log(`[DialogBrain WS] No Instagram tab open, waiting to process queue (${draftState.autoSendQueue.length} items)`);
      return;
    }

    draftState.isProcessingQueue = true;

    const item = draftState.autoSendQueue[0];
    if (!item) {
      draftState.isProcessingQueue = false;
      return;
    }

    console.log(`[DialogBrain WS] Processing auto-send queue item: draft ${item.draftId}`);

    // Notify content script to send the message
    this._notifyContentScripts('AUTO_APPROVE_DRAFT', {
      draftId: item.draftId,
      threadId: item.threadId,
      channelRef: item.channelRef,
      text: item.text,
    });

    // Safety timeout: if no response within 30s, reset processing flag
    // Content script uses pull model (GET_PENDING_AUTO_SENDS) as primary mechanism
    setTimeout(() => {
      if (draftState.isProcessingQueue && draftState.autoSendQueue.length > 0) {
        const stillInQueue = draftState.autoSendQueue[0]?.draftId === item.draftId;
        if (stillInQueue) {
          console.log(`[DialogBrain WS] Auto-send timeout for draft ${item.draftId}, resetting flag`);
          draftState.isProcessingQueue = false;
        }
      }
    }, 30000);

    // Note: isProcessingQueue will be set to false and queue item removed
    // when we receive confirmation via _onAutoSendComplete()
  }

  /**
   * Called when auto-send completes (success or failure).
   * Removes item from queue and continues processing.
   */
  _onAutoSendComplete(draftId, success) {
    console.log(`[DialogBrain WS] Auto-send complete: draft ${draftId}, success=${success}`);

    // Remove from queue
    const index = draftState.autoSendQueue.findIndex(item => item.draftId === draftId);
    if (index !== -1) {
      draftState.autoSendQueue.splice(index, 1);
    }

    // If successful, remove draft from state and notify DraftPanel
    if (success) {
      // Get draft info before deleting
      const draft = draftState.drafts.get(draftId);
      const channelType = draft?.channelType || 'instagram';

      // Remove from drafts map
      draftState.drafts.delete(draftId);

      // Update pending count
      if (draftState.pendingCounts[channelType] > 0) {
        draftState.pendingCounts[channelType]--;
      }

      // Persist updated state
      persistDraftState();

      // Notify DraftPanel to remove the draft
      this._notifyContentScripts('DRAFT_SENT', { draft_id: draftId });
    }

    // Allow processing next item
    draftState.isProcessingQueue = false;

    // Notify content scripts about queue update
    this._notifyContentScripts('AUTO_SEND_QUEUE_UPDATED', {
      queue: draftState.autoSendQueue.map(item => ({
        draftId: item.draftId,
        threadTitle: item.threadTitle,
        status: draftState.autoSendQueue[0]?.draftId === item.draftId ? 'sending' : 'queued',
      })),
    });

    // Process next item with a small delay (avoid Instagram rate limits)
    if (draftState.autoSendQueue.length > 0) {
      setTimeout(() => this._processAutoSendQueue(), 2000);
    }
  }

  /**
   * Load initial pending drafts from API with retry logic.
   * FIXED: Merges instead of clearing to prevent race condition with WebSocket events.
   */
  async _loadInitialDrafts(retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [1000, 3000, 10000]; // Exponential backoff

    try {
      const authToken = await getAuthToken();
      if (!authToken) return;

      const apiUrl = await getApiUrl();

      // Only load Instagram drafts (extension only handles Instagram)
      const response = await fetch(`${apiUrl}/api/auto-reply/drafts?limit=50`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const drafts = await response.json();
      const now = Date.now();

      // Filter to Instagram only, actionable statuses, and not expired
      const instagramDrafts = drafts.filter(d =>
        d.channel_type === 'instagram' &&
        (d.status === 'pending' || d.status === 'approved') &&
        (!d.expires_at || new Date(d.expires_at).getTime() > now)
      );
      console.log(`[DialogBrain WS] Loaded ${instagramDrafts.length} actionable Instagram drafts from API`);

      // Update draftState with fresh data from server (always update, server is source of truth)
      let newCount = 0;
      for (const draft of instagramDrafts) {
        const isNew = !draftState.drafts.has(draft.id);
        draftState.drafts.set(draft.id, {
          id: draft.id,
          threadId: draft.thread_id,
          channelAccountId: draft.channel_account_id,
          channelRef: draft.channel_ref,
          channelType: draft.channel_type,
          threadTitle: draft.thread_title,
          triggerSender: draft.trigger_sender_name,
          triggerText: draft.trigger_text,
          responseText: draft.edited_text || draft.response_text,
          createdAt: new Date(draft.created_at),
          expiresAt: new Date(draft.expires_at),
          status: draft.status,  // Important: include status from server
        });
        if (isNew) newCount++;
      }

      // Recalculate pending count from actual drafts
      draftState.pendingCounts.instagram = Array.from(draftState.drafts.values())
        .filter(d => d.channelType === 'instagram').length;

      console.log(`[DialogBrain WS] Merged ${newCount} new drafts, total: ${draftState.drafts.size}`);

      // Persist to storage
      await persistDraftState();

      // Notify content scripts of all drafts
      this._notifyContentScripts('DRAFTS_LOADED', {
        drafts: Array.from(draftState.drafts.values()),
        count: draftState.pendingCounts.instagram,
      });

    } catch (e) {
      console.warn(`[DialogBrain WS] Failed to load initial drafts (attempt ${retryCount + 1}/${MAX_RETRIES + 1}):`, e.message);

      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAYS[retryCount] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        console.log(`[DialogBrain WS] Retrying in ${delay}ms...`);
        setTimeout(() => this._loadInitialDrafts(retryCount + 1), delay);
      } else {
        console.error('[DialogBrain WS] Failed to load drafts after all retries');
        // Notify content scripts of failure
        this._notifyContentScripts('DRAFTS_LOAD_FAILED', {
          error: e.message,
          retriesExhausted: true,
        });
      }
    }
  }

  /**
   * Fetch a single draft from API (fallback when WebSocket data is invalid).
   */
  async _fetchSingleDraft(draftId) {
    try {
      const authToken = await getAuthToken();
      if (!authToken) return;

      const apiUrl = await getApiUrl();

      const response = await fetch(`${apiUrl}/api/auto-reply/drafts/${draftId}`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      if (response.ok) {
        const draft = await response.json();

        // Store with validated data from API
        draftState.drafts.set(draft.id, {
          id: draft.id,
          threadId: draft.thread_id,
          channelAccountId: draft.channel_account_id,
          channelRef: draft.channel_ref,
          channelType: draft.channel_type,
          threadTitle: draft.thread_title,
          triggerSender: draft.trigger_sender_name,
          triggerText: draft.trigger_text,
          responseText: draft.edited_text || draft.response_text,
          createdAt: new Date(draft.created_at),
          expiresAt: new Date(draft.expires_at),
        });

        // Update pending count
        if (draft.channel_type && draftState.pendingCounts[draft.channel_type] !== undefined) {
          draftState.pendingCounts[draft.channel_type]++;
        }

        // Persist and notify
        await persistDraftState();
        this._notifyContentScripts('DRAFT_CREATED', {
          draft_id: draft.id,
          thread_id: draft.thread_id,
          channel_ref: draft.channel_ref,
          channel_type: draft.channel_type,
          thread_title: draft.thread_title,
          trigger_sender: draft.trigger_sender_name,
          trigger_text: draft.trigger_text,
          response_text: draft.edited_text || draft.response_text,
          created_at: draft.created_at,
          expires_at: draft.expires_at,
        });
      }
    } catch (e) {
      console.warn(`[DialogBrain WS] Failed to fetch single draft ${draftId}:`, e.message);
    }
  }

  /**
   * Load auto-reply settings from API.
   * Syncs auto-mode settings to ensure extension and backend are in sync.
   */
  async _loadSettings() {
    try {
      const authToken = await getAuthToken();
      if (!authToken) return;

      const apiUrl = await getApiUrl();

      const response = await fetch(`${apiUrl}/api/auto-reply/settings`, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
        },
      });

      if (response.ok) {
        const settings = await response.json();

        // Update Instagram auto-mode settings
        if (settings.instagram || settings.dm_send_mode !== undefined) {
          const instagramSettings = settings.instagram || settings;
          draftState.autoMode.instagram = {
            dm_send_mode: instagramSettings.dm_send_mode || 'draft',
            auto_delay_seconds: instagramSettings.auto_delay_seconds || 0,
          };
          console.log('[DialogBrain WS] Loaded settings:', draftState.autoMode.instagram);

          // Notify content scripts of settings
          this._notifyContentScripts('SETTINGS_CHANGED', {
            channel: 'instagram',
            dm_send_mode: draftState.autoMode.instagram.dm_send_mode,
            auto_delay_seconds: draftState.autoMode.instagram.auto_delay_seconds,
          });
        }
      }
    } catch (e) {
      console.warn('[DialogBrain WS] Failed to load settings:', e.message);
    }
  }

  /**
   * Schedule reconnection with exponential backoff.
   * Uses chrome.alarms API to survive service worker suspension.
   * Optionally try token refresh if auth error suspected.
   */
  _scheduleReconnect(authError = false) {
    // Store auth error flag for alarm handler
    this._pendingAuthError = authError;

    console.log(`[DialogBrain WS] Scheduling reconnect in ${this.reconnectDelay}ms (authError=${authError})`);

    // Use chrome.alarms instead of setTimeout (survives service worker suspension)
    scheduleReconnectAlarm(this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, CONFIG.WS_MAX_RECONNECT_DELAY_MS);
  }

  /**
   * Handle reconnect (called from alarm handler).
   */
  async _handleReconnect() {
    const authError = this._pendingAuthError;
    this._pendingAuthError = false;

    // If auth error suspected, try to refresh token first
    if (authError && !this._lastRefreshAttempt ||
        (this._lastRefreshAttempt && Date.now() - this._lastRefreshAttempt > 60000)) {
      console.log('[DialogBrain WS] Attempting token refresh before reconnect...');
      this._lastRefreshAttempt = Date.now();
      const newToken = await refreshAccessToken();
      if (newToken) {
        console.log('[DialogBrain WS] Token refreshed, reconnecting...');
        // Reset backoff on successful refresh
        this.reconnectDelay = CONFIG.WS_RECONNECT_DELAY_MS;
      }
    }

    this.connect();
  }

  /**
   * Start heartbeat timer.
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, CONFIG.WS_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop heartbeat timer.
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Notify all Instagram content scripts about an event.
   */
  async _notifyContentScripts(type, payload) {
    console.log(`[DialogBrain WS] _notifyContentScripts: type=${type}, tabs=${instagramHybrid.tabs.size}`);
    try {
      for (const [tabId, tabInfo] of instagramHybrid.tabs) {
        console.log(`[DialogBrain WS] Sending ${type} to tab ${tabId}, ready=${tabInfo.ready}, wsConnected=${tabInfo.wsConnected}`);
        try {
          await chrome.tabs.sendMessage(tabId, {
            target: 'instagram_content_script',
            source: 'dialogbrain_ws',
            type: type,
            payload: payload,
            timestamp: Date.now(),
          });
          console.log(`[DialogBrain WS] Message sent to tab ${tabId} successfully`);
        } catch (e) {
          console.warn(`[DialogBrain WS] Failed to send to tab ${tabId}:`, e.message);
          // Tab may be closed or content script not ready
        }
      }
    } catch (e) {
      // Ignore errors
    }
  }

  /**
   * Check if WebSocket is connected.
   */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get current connection status.
   */
  getStatus() {
    return {
      connected: this.isConnected(),
      lastEventTime: draftState.lastEventTime,
      pendingDrafts: draftState.drafts.size,
      pendingCounts: { ...draftState.pendingCounts },
    };
  }
}

// Global ExtensionWebSocket instance
const extensionWS = new ExtensionWebSocket();

// =============================================================================
// Instagram Hybrid Mode - Tab Tracking
// =============================================================================

/**
 * Instagram Hybrid Mode State
 *
 * Tracks Instagram tabs to enable content script-based real-time messaging
 * when tab is open, falling back to cookie API when closed.
 *
 * Mode Detection:
 * - content_script: Instagram tab open with WebSocket connected
 * - cookie_api: No Instagram tabs, or tab without working WebSocket
 */
const instagramHybrid = {
  // Map of tabId -> { url, ready, wsConnected, lastActivity }
  tabs: new Map(),

  // Current active mode
  mode: 'cookie_api', // 'content_script' | 'cookie_api'

  // Message queue for pending sends during mode transition
  pendingSends: [],

  // Last mode change timestamp
  lastModeChange: Date.now(),

  // Deduplication cache for messages (msgId -> timestamp)
  seenMessages: new Map(),

  // Dedup TTL in ms (5 minutes)
  dedupTtlMs: 5 * 60 * 1000,
};

/**
 * Get the current Instagram hybrid mode.
 * Returns 'content_script' if any tab is ready with WS, else 'cookie_api'.
 */
function getInstagramHybridMode() {
  for (const [tabId, tabInfo] of instagramHybrid.tabs) {
    if (tabInfo.ready && tabInfo.wsConnected) {
      return 'content_script';
    }
  }
  return 'cookie_api';
}

/**
 * Update the hybrid mode and notify backend if changed.
 */
async function updateInstagramHybridMode() {
  const newMode = getInstagramHybridMode();
  const oldMode = instagramHybrid.mode;

  if (newMode !== oldMode) {
    instagramHybrid.mode = newMode;
    instagramHybrid.lastModeChange = Date.now();
    console.log(`[DialogBrain Hybrid] Mode changed: ${oldMode} -> ${newMode}`);

    // Notify backend of mode change
    await notifyBackendModeChange(newMode);

    // Process any pending sends if switching to content_script
    if (newMode === 'content_script' && instagramHybrid.pendingSends.length > 0) {
      console.log(`[DialogBrain Hybrid] Processing ${instagramHybrid.pendingSends.length} pending sends`);
      const pending = [...instagramHybrid.pendingSends];
      instagramHybrid.pendingSends = [];

      for (const send of pending) {
        await sendInstagramDmViaContentScript(send.threadId, send.text, send.callback);
      }
    }

    // Process auto-send queue when Instagram tab opens
    if (newMode === 'content_script' && draftState.autoSendQueue.length > 0) {
      console.log(`[DialogBrain Hybrid] Instagram tab opened, processing auto-send queue (${draftState.autoSendQueue.length} items)`);
      extensionWS._processAutoSendQueue();
    }
  }
}

/**
 * Notify backend of Instagram hybrid mode change.
 */
async function notifyBackendModeChange(mode) {
  try {
    const authToken = await getAuthToken();
    if (!authToken) return;

    const apiUrl = await getApiUrl();
    const storage = await chrome.storage.local.get(['instagram_account_id']);

    if (!storage.instagram_account_id) return;

    await fetch(`${apiUrl}/api/channels/instagram/hybrid/mode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        account_id: storage.instagram_account_id,
        mode: mode,
        timestamp: Date.now(),
        tabs_count: instagramHybrid.tabs.size,
      }),
    });

    console.log(`[DialogBrain Hybrid] Backend notified of mode: ${mode}`);
  } catch (e) {
    console.warn('[DialogBrain Hybrid] Failed to notify backend:', e.message);
  }
}

/**
 * Check if a message ID has been seen recently (deduplication).
 */
function isMessageDuplicate(messageId) {
  if (!messageId) return false;

  const now = Date.now();

  // Clean old entries
  for (const [id, timestamp] of instagramHybrid.seenMessages) {
    if (now - timestamp > instagramHybrid.dedupTtlMs) {
      instagramHybrid.seenMessages.delete(id);
    }
  }

  if (instagramHybrid.seenMessages.has(messageId)) {
    return true;
  }

  instagramHybrid.seenMessages.set(messageId, now);
  return false;
}

/**
 * Find an active Instagram tab to send a message.
 * Returns tabId or null.
 */
function findActiveInstagramTab() {
  for (const [tabId, tabInfo] of instagramHybrid.tabs) {
    if (tabInfo.ready && tabInfo.wsConnected) {
      return tabId;
    }
  }
  // Fallback: any Instagram tab
  for (const [tabId, tabInfo] of instagramHybrid.tabs) {
    if (tabInfo.ready) {
      return tabId;
    }
  }
  return null;
}

/**
 * Send Instagram DM via content script (DOM manipulation).
 * Handles navigation to different threads with retry logic.
 */
async function sendInstagramDmViaContentScript(threadId, text, callback, retryCount = 0) {
  const MAX_RETRIES = 2;
  const NAVIGATION_WAIT_MS = 2500;

  const tabId = findActiveInstagramTab();

  if (!tabId) {
    console.log('[DialogBrain Hybrid] No active Instagram tab, queueing send');
    instagramHybrid.pendingSends.push({ threadId, text, callback });
    return { success: false, error: 'No active Instagram tab', queued: true };
  }

  try {
    const result = await chrome.tabs.sendMessage(tabId, {
      target: 'instagram_content_script',
      type: 'SEND_DM',
      threadId,
      text,
    });

    // Handle navigation required - content script returns this before navigating
    // to prevent message channel from closing mid-request
    if (result && result.navigationRequired) {
      if (retryCount >= MAX_RETRIES) {
        console.error('[DialogBrain Hybrid] Max retries reached for navigation');
        return { success: false, error: 'Navigation failed after retries' };
      }

      console.log(`[DialogBrain Hybrid] Navigation required to thread ${threadId}, waiting and retrying...`);
      // Wait for navigation to complete, then retry
      await new Promise(resolve => setTimeout(resolve, NAVIGATION_WAIT_MS));
      return sendInstagramDmViaContentScript(threadId, text, callback, retryCount + 1);
    }

    if (callback) callback(result);
    return result;
  } catch (e) {
    console.error('[DialogBrain Hybrid] Content script send failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Like Instagram post via content script (DOM manipulation).
 */
async function likeInstagramPostViaContentScript(postUrl) {
  const tabId = findActiveInstagramTab();

  if (!tabId) {
    return { success: false, error: 'No active Instagram tab' };
  }

  try {
    return await chrome.tabs.sendMessage(tabId, {
      target: 'instagram_content_script',
      type: 'LIKE_POST',
      postUrl,
    });
  } catch (e) {
    console.error('[DialogBrain Hybrid] Content script like failed:', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Comment on Instagram post via content script (DOM manipulation).
 */
async function commentInstagramPostViaContentScript(postUrl, text) {
  const tabId = findActiveInstagramTab();

  if (!tabId) {
    return { success: false, error: 'No active Instagram tab' };
  }

  try {
    return await chrome.tabs.sendMessage(tabId, {
      target: 'instagram_content_script',
      type: 'COMMENT_POST',
      postUrl,
      text,
    });
  } catch (e) {
    console.error('[DialogBrain Hybrid] Content script comment failed:', e.message);
    return { success: false, error: e.message };
  }
}

// =============================================================================
// Instagram Tab Tracking - Chrome Event Listeners
// =============================================================================

/**
 * Handle tab updates - track Instagram tabs.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Check if this is an Instagram tab
  const isInstagram = tab.url?.includes('instagram.com');

  if (isInstagram) {
    if (!instagramHybrid.tabs.has(tabId)) {
      console.log(`[DialogBrain Hybrid] Instagram tab detected: ${tabId}`);
      instagramHybrid.tabs.set(tabId, {
        url: tab.url,
        ready: changeInfo.status === 'complete',
        wsConnected: extensionWS.isConnected(),
        lastActivity: Date.now(),
      });

      // Send current WS status to new tab (async, non-blocking)
      if (changeInfo.status === 'complete') {
        chrome.tabs.sendMessage(tabId, {
          target: 'instagram_content_script',
          source: 'dialogbrain_ws',
          type: 'WS_STATUS_CHANGED',
          payload: { connected: extensionWS.isConnected() },
          timestamp: Date.now(),
        }).catch(() => { /* Content script may not be ready yet */ });
      }
    } else {
      const tabInfo = instagramHybrid.tabs.get(tabId);
      tabInfo.url = tab.url;
      if (changeInfo.status === 'complete') {
        tabInfo.ready = true;
      }
      tabInfo.lastActivity = Date.now();
    }

    // Update mode if needed
    updateInstagramHybridMode();
  } else if (instagramHybrid.tabs.has(tabId)) {
    // Tab navigated away from Instagram
    console.log(`[DialogBrain Hybrid] Tab ${tabId} left Instagram`);
    instagramHybrid.tabs.delete(tabId);
    updateInstagramHybridMode();
  }
});

/**
 * Handle tab removal - clean up tracking.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (instagramHybrid.tabs.has(tabId)) {
    console.log(`[DialogBrain Hybrid] Instagram tab closed: ${tabId}`);
    instagramHybrid.tabs.delete(tabId);
    updateInstagramHybridMode();
  }
});

/**
 * Handle tab activation - useful for knowing which tab is in focus.
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tabInfo = instagramHybrid.tabs.get(activeInfo.tabId);
  if (tabInfo) {
    tabInfo.lastActivity = Date.now();
  }
});

// =============================================================================
// Cookie Change Listener (PRIMARY mechanism)
// =============================================================================

chrome.cookies.onChanged.addListener((changeInfo) => {
  const { cookie, removed } = changeInfo;

  // Instagram cookie changed
  if (cookie.domain.includes('instagram.com') && INSTAGRAM_COOKIES.includes(cookie.name)) {
    console.log(`[DialogBrain] Instagram cookie change detected: ${cookie.name} (${removed ? 'removed' : 'updated'})`);

    // Debounce: wait for multiple cookie changes to settle
    if (pendingSyncs.instagram) {
      clearTimeout(pendingSyncs.instagram);
    }
    pendingSyncs.instagram = setTimeout(() => {
      syncInstagramCookies();
    }, CONFIG.DEBOUNCE_MS);
  }

  // LinkedIn cookie changed
  if (cookie.domain.includes('linkedin.com') && LINKEDIN_COOKIES.includes(cookie.name)) {
    console.log(`[DialogBrain] LinkedIn cookie change detected: ${cookie.name} (${removed ? 'removed' : 'updated'})`);

    // Debounce
    if (pendingSyncs.linkedin) {
      clearTimeout(pendingSyncs.linkedin);
    }
    pendingSyncs.linkedin = setTimeout(() => {
      syncLinkedInCookies();
    }, CONFIG.DEBOUNCE_MS);
  }
});

// =============================================================================
// Fallback Periodic Sync (every 6 hours)
// =============================================================================

// Create alarm for periodic sync
chrome.alarms.create('fallbackSync', { periodInMinutes: CONFIG.FALLBACK_SYNC_HOURS * 60 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fallbackSync') {
    console.log('[DialogBrain] Running fallback periodic sync');
    syncInstagramCookies();
    syncLinkedInCookies();
  }
});

// =============================================================================
// Instagram Cookie Sync
// =============================================================================

async function getInstagramCookies() {
  const cookiePromises = INSTAGRAM_COOKIES.map((name) =>
    chrome.cookies.get({ url: 'https://www.instagram.com', name })
  );

  const cookies = await Promise.all(cookiePromises);

  return {
    sessionid: cookies[0]?.value || null,
    csrftoken: cookies[1]?.value || null,
    ds_user_id: cookies[2]?.value || null,
    mid: cookies[3]?.value || null,
    user_agent: navigator.userAgent, // CRITICAL: Include real browser UA
  };
}

/**
 * Verify Instagram session directly from browser context.
 * This works because the request comes from the same browser that has the session.
 *
 * Returns: { valid: boolean, user_id?: string, username?: string, error?: string }
 */
async function verifyInstagramSession() {
  try {
    const cookies = await getInstagramCookies();

    if (!cookies.sessionid) {
      return { valid: false, error: 'No sessionid cookie' };
    }

    // Build Cookie header manually - credentials: 'include' doesn't work from service worker
    const cookieHeader = buildCookieHeader(cookies);

    // Call Instagram's private API from browser context (with timeout)
    const response = await fetchWithTimeout('https://i.instagram.com/api/v1/accounts/current_user/', {
      method: 'GET',
      headers: {
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-CSRFToken': cookies.csrftoken || '',
        'Cookie': cookieHeader,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      credentials: 'omit', // Don't rely on automatic cookie handling
    }, 10000); // 10 second timeout for Instagram API

    if (response.status === 200) {
      const data = await response.json();

      if (data.status === 'fail') {
        if (data.message?.includes('login_required')) {
          return { valid: false, error: 'Session expired' };
        }
        if (data.message?.includes('checkpoint_required')) {
          return { valid: false, error: 'Checkpoint required' };
        }
        return { valid: false, error: data.message || 'Unknown error' };
      }

      const user = data.user || {};
      return {
        valid: true,
        user_id: String(user.pk || user.pk_id || cookies.ds_user_id || ''),
        username: user.username || '',
        full_name: user.full_name || '',
        profile_pic_url: user.profile_pic_url || '',
      };
    } else if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Session expired' };
    } else if (response.status === 429) {
      return { valid: false, error: 'Rate limited - try again later' };
    } else {
      return { valid: false, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    console.error('[DialogBrain] Instagram verification error:', error.message);
    return { valid: false, error: error.message };
  }
}

/**
 * Sync Instagram cookies to backend.
 *
 * @param {Object} options
 * @param {boolean} options.useUnipile - Use Unipile for session management (overrides settings)
 * @param {boolean} options.forceExtensionVerify - Force extension-direct verification (default: false)
 */
async function syncInstagramCookies(options = {}) {
  // Prevent concurrent syncs - critical to avoid creating duplicate Unipile accounts
  if (syncStatus.instagram.syncing) {
    console.log('[DialogBrain] Instagram sync already in progress, skipping duplicate request');
    return { success: false, error: 'Sync already in progress', skipped: true };
  }

  // Get settings
  const settings = await getSettings();

  // Determine sync method: explicit option > settings > default
  let useUnipile;
  if (options.useUnipile !== undefined) {
    useUnipile = options.useUnipile;
  } else {
    useUnipile = settings.instagramMethod === 'unipile';
  }
  const forceExtensionVerify = options.forceExtensionVerify || false;

  console.log(`[DialogBrain] Instagram sync: method=${settings.instagramMethod}, useUnipile=${useUnipile}`);

  // Get auth token with retry (handles race condition where token is still being saved)
  const authToken = await getAuthToken(5, 300); // 5 retries, 300ms delay = up to 1.5s wait
  if (!authToken) {
    console.log('[DialogBrain] No auth token after retries - user not logged in to extension');
    syncStatus.instagram = { syncing: false, lastSync: null, error: 'Not logged in', startedAt: null };
    return { success: false, error: 'Not logged in' };
  }

  // Get account ID separately
  const storage = await chrome.storage.local.get(['instagram_account_id']);

  // Get cookies
  const cookies = await getInstagramCookies();

  if (!cookies.sessionid) {
    console.log('[DialogBrain] No Instagram session - user not logged in');
    syncStatus.instagram = { syncing: false, lastSync: null, error: 'Not logged in to Instagram', startedAt: null };
    return { success: false, error: 'Not logged in to Instagram' };
  }

  syncStatus.instagram.syncing = true;
  syncStatus.instagram.startedAt = Date.now();

  try {
    const apiUrl = await getApiUrl();
    let endpoint;
    let requestBody;

    // If we have an existing account ID, use sync endpoint
    if (storage.instagram_account_id) {
      endpoint = `${apiUrl}/api/channels/instagram/accounts/${storage.instagram_account_id}/sync-cookie`;

      // Direct mode: skip verification, use ds_user_id from cookies
      // MV3 service workers can't make authenticated requests to Instagram API
      if (!useUnipile) {
        console.log('[DialogBrain] Syncing existing account (direct mode)');
        requestBody = {
          ...cookies,
          extension_verified: true,
          verified_user_id: cookies.ds_user_id,
        };
      } else {
        // Using Unipile - let backend handle verification
        console.log('[DialogBrain] Skipping local verification, using Unipile');
        requestBody = {
          ...cookies,
          use_unipile: true,
        };
      }
    } else {
      // New connection - choose approach
      endpoint = `${apiUrl}/api/channels/instagram/accounts/connect/cookie`;

      if (forceExtensionVerify || !useUnipile) {
        // APPROACH 2: Direct mode - use cookies directly without verification
        // MV3 service workers can't make authenticated requests to Instagram API,
        // so we trust the cookies and use ds_user_id as the user ID
        console.log('[DialogBrain] Using direct mode (no Unipile)');

        // ds_user_id cookie contains the Instagram user ID
        if (!cookies.ds_user_id) {
          syncStatus.instagram = {
            syncing: false,
            lastSync: null,
            error: 'No ds_user_id cookie - please login to Instagram',
            startedAt: null,
          };
          return { success: false, error: 'No ds_user_id cookie' };
        }

        requestBody = {
          ...cookies,
          use_unipile: false,
          verified_user_id: cookies.ds_user_id,
          // Username will be fetched by backend or content script later
        };
        console.log(`[DialogBrain] Direct mode: using ds_user_id=${cookies.ds_user_id}`);
      } else {
        // APPROACH 1: Use Unipile (default)
        console.log('[DialogBrain] Using Unipile for session management');
        requestBody = {
          ...cookies,
          use_unipile: true,
        };
      }
    }

    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(requestBody), // NEVER log this!
    });

    if (response.ok) {
      const data = await response.json();

      // Check if backend returned an error status
      if (data.status === 'error' || data.status === 'session_expired' || data.status === 'checkpoint_required') {
        console.log(`[DialogBrain] Instagram sync returned status: ${data.status}, message: ${data.message}`);

        // If Unipile failed and this is a "test mode" or creation disabled error,
        // DON'T fallback - just show the error (user needs to use Mode A)
        const isUnipileBlocked = data.message?.includes('TEST MODE') || data.message?.includes('disabled');

        // If Unipile failed for other reasons, try extension-direct as fallback
        if (useUnipile && !forceExtensionVerify && !storage.instagram_account_id && !isUnipileBlocked) {
          console.log('[DialogBrain] Unipile failed, trying extension-direct verification...');
          return await syncInstagramCookies({ useUnipile: false, forceExtensionVerify: true });
        }

        // Show error to user
        console.log('[DialogBrain] Sync failed, setting error status:', data.message || data.status);
        syncStatus.instagram = {
          syncing: false,
          lastSync: null,
          error: data.message || data.status,
          status: data.status,
          startedAt: null,
        };
        return { success: false, error: data.message || data.status };
      }

      // Store/update account ID - always update if present to handle reconnections
      if (data.account_id) {
        await chrome.storage.local.set({ instagram_account_id: data.account_id });
        console.log('[DialogBrain] Instagram account ID stored:', data.account_id);
      }

      console.log('[DialogBrain] Instagram cookies synced successfully');
      syncStatus.instagram = {
        syncing: false,
        lastSync: new Date().toISOString(),
        error: null,
        status: data.status || 'connected',
        username: data.username,
        startedAt: null,
      };
      return { success: true, status: data.status, username: data.username };
    } else {
      const errorText = await response.text();
      console.error(`[DialogBrain] Instagram sync failed: ${response.status}`);

      // If 401, auth token is expired - clear it
      if (response.status === 401) {
        console.log('[DialogBrain] Auth token expired (401), clearing...');
        await chrome.storage.local.remove(['auth_token']);
        syncStatus.instagram = {
          syncing: false,
          lastSync: null,
          error: 'Auth expired - please reconnect',
          startedAt: null,
        };
        return { success: false, error: 'Auth expired - please reconnect' };
      }

      // If 404 and we have a stored account ID, it's stale - clear it and retry
      if (response.status === 404 && storage.instagram_account_id) {
        console.log('[DialogBrain] Account not found (404), clearing stale account ID and retrying...');
        await chrome.storage.local.remove(['instagram_account_id']);
        return await syncInstagramCookies(options); // Retry with connect endpoint
      }

      // If Unipile approach failed with 4xx, try extension-direct
      if (useUnipile && !forceExtensionVerify && response.status >= 400 && response.status < 500 && !storage.instagram_account_id) {
        console.log('[DialogBrain] Unipile request failed, trying extension-direct...');
        return await syncInstagramCookies({ useUnipile: false, forceExtensionVerify: true });
      }

      syncStatus.instagram = {
        syncing: false,
        lastSync: null,
        error: `HTTP ${response.status}`,
        startedAt: null,
      };
      return { success: false, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    console.error('[DialogBrain] Instagram sync error:', error.message); // Don't log full error (may contain cookies)
    syncStatus.instagram = {
      syncing: false,
      lastSync: null,
      error: error.message,
      startedAt: null,
    };
    return { success: false, error: error.message };
  }
}

// =============================================================================
// LinkedIn Cookie Sync
// =============================================================================

async function getLinkedInCookies() {
  const cookiePromises = [
    chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' }),
    chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_a' }),
    chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'JSESSIONID' }),
  ];

  const cookies = await Promise.all(cookiePromises);

  return {
    li_at: cookies[0]?.value || null,
    li_a: cookies[1]?.value || null,
    jsessionid: cookies[2]?.value || null,
    user_agent: navigator.userAgent,
  };
}

async function syncLinkedInCookies() {
  // Prevent concurrent syncs
  if (syncStatus.linkedin.syncing) {
    console.log('[DialogBrain] LinkedIn sync already in progress, skipping duplicate request');
    return { success: false, error: 'Sync already in progress', skipped: true };
  }

  // Get auth token with retry (handles race condition)
  const authToken = await getAuthToken(5, 300);
  if (!authToken) {
    console.log('[DialogBrain] No auth token after retries - user not logged in to extension');
    syncStatus.linkedin = { syncing: false, lastSync: null, error: 'Not logged in', startedAt: null };
    return;
  }

  // Get account ID separately
  const storage = await chrome.storage.local.get(['linkedin_account_id']);

  // Get cookies
  const cookies = await getLinkedInCookies();

  if (!cookies.li_at) {
    console.log('[DialogBrain] No LinkedIn session - user not logged in');
    syncStatus.linkedin = { syncing: false, lastSync: null, error: 'Not logged in to LinkedIn', startedAt: null };
    return;
  }

  syncStatus.linkedin.syncing = true;
  syncStatus.linkedin.startedAt = Date.now();

  try {
    const apiUrl = await getApiUrl();
    let endpoint;

    // If we have an existing account ID, use sync endpoint
    if (storage.linkedin_account_id) {
      endpoint = `${apiUrl}/api/channels/linkedin/accounts/${storage.linkedin_account_id}/sync-cookie`;
    } else {
      endpoint = `${apiUrl}/api/channels/linkedin/accounts/connect/cookie`;
    }

    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(cookies),
    });

    if (response.ok) {
      const data = await response.json();

      // Store account ID if this was a connect
      if (data.account_id && !storage.linkedin_account_id) {
        await chrome.storage.local.set({ linkedin_account_id: data.account_id });
      }

      console.log('[DialogBrain] LinkedIn cookies synced successfully');
      syncStatus.linkedin = {
        syncing: false,
        lastSync: new Date().toISOString(),
        error: null,
        status: data.status || 'connected',
        startedAt: null,
      };
    } else {
      console.error(`[DialogBrain] LinkedIn sync failed: ${response.status}`);

      // If 401, auth token is expired - clear it
      if (response.status === 401) {
        console.log('[DialogBrain] Auth token expired (401), clearing...');
        await chrome.storage.local.remove(['auth_token']);
        syncStatus.linkedin = {
          syncing: false,
          lastSync: null,
          error: 'Auth expired - please reconnect',
          startedAt: null,
        };
        return { success: false, error: 'Auth expired - please reconnect' };
      }

      // If 404 and we have a stored account ID, it's stale - clear it and retry
      if (response.status === 404 && storage.linkedin_account_id) {
        console.log('[DialogBrain] LinkedIn account not found (404), clearing stale account ID and retrying...');
        await chrome.storage.local.remove(['linkedin_account_id']);
        return await syncLinkedInCookies(); // Retry with connect endpoint
      }

      syncStatus.linkedin = {
        syncing: false,
        lastSync: null,
        error: `HTTP ${response.status}`,
        startedAt: null,
      };
    }
  } catch (error) {
    console.error('[DialogBrain] LinkedIn sync error:', error.message);
    syncStatus.linkedin = {
      syncing: false,
      lastSync: null,
      error: error.message,
      startedAt: null,
    };
  }
}

// =============================================================================
// Instagram Content Script Message Handler
// =============================================================================

/**
 * Handle messages from Instagram content script.
 */
async function handleInstagramContentScriptMessage(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  const { type, payload } = message;

  console.log(`[DialogBrain Hybrid] Content script message: ${type} from tab ${tabId}`);

  switch (type) {
    case 'CONTENT_SCRIPT_READY':
      // Content script initialized
      if (tabId && instagramHybrid.tabs.has(tabId)) {
        const tabInfo = instagramHybrid.tabs.get(tabId);
        tabInfo.ready = true;
        tabInfo.lastActivity = Date.now();
      } else if (tabId) {
        instagramHybrid.tabs.set(tabId, {
          url: payload?.url,
          ready: true,
          wsConnected: false,
          lastActivity: Date.now(),
        });
      }
      // Trigger initial sync when content script becomes ready (with cooldown)
      const now = Date.now();
      if (now - lastInitialSyncTime > INITIAL_SYNC_COOLDOWN_MS) {
        lastInitialSyncTime = now;
        console.log('[DialogBrain Hybrid] Content script ready, triggering initial message sync');
        syncInstagramMessages().catch(e => console.warn('[DialogBrain Hybrid] Initial sync error:', e.message));
      } else {
        console.log('[DialogBrain Hybrid] Content script ready, skipping sync (cooldown)');
      }
      // Always load drafts when content script becomes ready (for draft panel)
      console.log('[DialogBrain Hybrid] Content script ready, loading drafts via REST API');
      loadDraftsViaRestApi().catch(e => console.warn('[DialogBrain Hybrid] Failed to load drafts:', e.message));
      sendResponse({ success: true });
      break;

    case 'INTERCEPTOR_READY':
      // WebSocket interceptor injected
      console.log('[DialogBrain Hybrid] Interceptor ready in tab', tabId);
      sendResponse({ success: true });
      break;

    case 'WS_CONNECTED':
      // WebSocket connected - content script mode is now fully active
      if (tabId && instagramHybrid.tabs.has(tabId)) {
        const tabInfo = instagramHybrid.tabs.get(tabId);
        tabInfo.wsConnected = true;
        tabInfo.lastActivity = Date.now();
        console.log('[DialogBrain Hybrid] WebSocket connected in tab', tabId);
        updateInstagramHybridMode();
        // Also trigger sync when WebSocket connects for full real-time coverage (with cooldown)
        const wsConnectNow = Date.now();
        if (wsConnectNow - lastInitialSyncTime > INITIAL_SYNC_COOLDOWN_MS) {
          lastInitialSyncTime = wsConnectNow;
          syncInstagramMessages().catch(e => console.warn('[DialogBrain Hybrid] WS connect sync error:', e.message));
        }
      }
      sendResponse({ success: true });
      break;

    case 'WS_DISCONNECTED':
      // WebSocket disconnected
      if (tabId && instagramHybrid.tabs.has(tabId)) {
        const tabInfo = instagramHybrid.tabs.get(tabId);
        tabInfo.wsConnected = false;
        tabInfo.lastActivity = Date.now();
        console.log('[DialogBrain Hybrid] WebSocket disconnected in tab', tabId);
        updateInstagramHybridMode();
      }
      sendResponse({ success: true });
      break;

    case 'IG_DM_EVENT':
      // DM event from interceptor - forward to backend
      await handleInstagramDmEvent(payload);
      sendResponse({ success: true });
      break;

    case 'TRIGGER_INBOX_SYNC':
      // Content script detected DM activity but couldn't parse MQTT
      // Trigger a fetch-based sync to get new messages
      console.log('[DialogBrain Hybrid] Triggering inbox sync due to:', payload?.reason);
      syncInstagramMessages().catch(e => {
        console.warn('[DialogBrain Hybrid] Inbox sync failed:', e.message);
      });
      sendResponse({ success: true });
      break;

    case 'THREAD_CHANGED':
      // User navigated to different thread
      if (tabId && instagramHybrid.tabs.has(tabId)) {
        const tabInfo = instagramHybrid.tabs.get(tabId);
        tabInfo.currentThreadId = payload?.threadId;
        tabInfo.lastActivity = Date.now();
      }
      sendResponse({ success: true });
      break;

    case 'WS_ERROR':
      // WebSocket error - track for diagnostics
      console.warn('[DialogBrain Hybrid] WebSocket error in tab', tabId);
      if (tabId && instagramHybrid.tabs.has(tabId)) {
        const tabInfo = instagramHybrid.tabs.get(tabId);
        tabInfo.wsError = true;
        tabInfo.lastActivity = Date.now();
      }
      sendResponse({ success: true });
      break;

    case 'DOM_ACTIVITY_DETECTED':
      // Fallback polling detected DOM changes - trigger sync
      console.log('[DialogBrain Hybrid] DOM activity detected, triggering sync');
      await handleDomActivityDetected(payload);
      sendResponse({ success: true });
      break;

    case 'GET_AUTO_MODE':
      // Return current autoMode settings from cached state
      const channel = payload?.channel || 'instagram';
      const channelSettings = draftState.autoMode[channel] || { dm_send_mode: 'draft', auto_delay_seconds: 0 };
      console.log(`[DialogBrain Hybrid] GET_AUTO_MODE for ${channel}:`, channelSettings);
      sendResponse({
        success: true,
        autoMode: channelSettings.dm_send_mode === 'auto',
        dm_send_mode: channelSettings.dm_send_mode,
        auto_delay_seconds: channelSettings.auto_delay_seconds
      });
      break;

    case 'GET_PENDING_AUTO_SENDS':
      // Content script is ready and requesting pending auto-send items
      console.log(`[DialogBrain Hybrid] Content script requesting pending auto-sends, queue length: ${draftState.autoSendQueue.length}`);
      sendResponse({
        success: true,
        queue: draftState.autoSendQueue.map(item => ({
          draftId: item.draftId,
          threadId: item.threadId,
          channelRef: item.channelRef,
          text: item.text,
          threadTitle: item.threadTitle,
        })),
      });
      break;

    case 'AUTO_SEND_COMPLETE':
      // Content script finished sending auto-approved draft
      console.log(`[DialogBrain Hybrid] Auto-send complete: draft ${payload?.draftId}, success=${payload?.success}`);
      extensionWS._onAutoSendComplete(payload?.draftId, payload?.success);
      sendResponse({ success: true });
      break;

    case 'AUTO_SEND_QUEUED':
      // Content script queued the draft (tab not visible)
      // Reset processing flag so we don't block on this - content script will process when visible
      console.log(`[DialogBrain Hybrid] Auto-send queued in content script (tab not visible): draft ${payload?.draftId}`);
      draftState.isProcessingQueue = false;
      sendResponse({ success: true });
      break;

    case 'GET_AUTO_SEND_QUEUE':
      // Return current auto-send queue
      sendResponse({
        success: true,
        queue: draftState.autoSendQueue.map(item => ({
          draftId: item.draftId,
          threadTitle: item.threadTitle,
          status: draftState.autoSendQueue[0]?.draftId === item.draftId ? 'sending' : 'queued',
        })),
      });
      break;

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }
}

// Debounce timer for DOM activity sync
let domActivitySyncTimer = null;

// Track last initial sync to avoid duplicate syncs
let lastInitialSyncTime = 0;
const INITIAL_SYNC_COOLDOWN_MS = 10000; // 10 seconds between initial syncs

// =============================================================================
// Instagram Direct API Fetching (Mode A - Extension-Direct)
// =============================================================================

/**
 * Fetch latest Instagram inbox/threads directly from Instagram's API.
 * This runs in browser context, so fingerprint matches.
 */
async function fetchInstagramInbox(limit = 10) {
  const cookies = await getInstagramCookies();
  if (!cookies.sessionid) {
    console.warn('[DialogBrain Hybrid] No Instagram session for inbox fetch');
    return null;
  }

  // Build Cookie header manually - credentials: 'include' doesn't work from service worker
  // because service worker runs in chrome-extension:// origin, not instagram.com
  const cookieHeader = buildCookieHeader(cookies);

  try {
    console.log('[DialogBrain Hybrid] Fetching inbox with manual cookies...', {
      hasSessionid: !!cookies.sessionid,
      hasCsrftoken: !!cookies.csrftoken,
      limit,
    });

    const response = await fetch(`https://i.instagram.com/api/v1/direct_v2/inbox/?limit=${limit}&thread_message_limit=10`, {
      method: 'GET',
      headers: {
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-CSRFToken': cookies.csrftoken || '',
        'Cookie': cookieHeader,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': cookies.user_agent || navigator.userAgent,
        'Referer': 'https://www.instagram.com/',
        'Origin': 'https://www.instagram.com',
      },
      credentials: 'omit', // Don't rely on automatic cookie handling
    });

    console.log('[DialogBrain Hybrid] Inbox fetch response:', response.status);

    if (response.status === 200) {
      const data = await response.json();
      console.log('[DialogBrain Hybrid] Inbox fetch data status:', data.status, 'threads:', data.inbox?.threads?.length);
      if (data.status === 'ok') {
        return data.inbox;
      }
    }

    console.warn('[DialogBrain Hybrid] Inbox fetch failed:', response.status);
    return null;
  } catch (e) {
    console.error('[DialogBrain Hybrid] Inbox fetch error:', e.message);
    return null;
  }
}

/**
 * Build Cookie header string from cookie values.
 */
function buildCookieHeader(cookies) {
  const parts = [];
  if (cookies.sessionid) parts.push(`sessionid=${cookies.sessionid}`);
  if (cookies.csrftoken) parts.push(`csrftoken=${cookies.csrftoken}`);
  if (cookies.ds_user_id) parts.push(`ds_user_id=${cookies.ds_user_id}`);
  if (cookies.mid) parts.push(`mid=${cookies.mid}`);
  return parts.join('; ');
}

/**
 * Fetch messages from a specific Instagram thread.
 */
async function fetchInstagramThreadMessages(threadId, limit = 20) {
  const cookies = await getInstagramCookies();
  if (!cookies.sessionid) {
    return null;
  }

  // Build Cookie header manually - credentials: 'include' doesn't work from service worker
  const cookieHeader = buildCookieHeader(cookies);

  try {
    console.log('[DialogBrain Hybrid] Fetching thread messages:', threadId);

    const response = await fetch(`https://i.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=${limit}`, {
      method: 'GET',
      headers: {
        'X-IG-App-ID': '936619743392459',
        'X-ASBD-ID': '129477',
        'X-IG-WWW-Claim': '0',
        'X-CSRFToken': cookies.csrftoken || '',
        'Cookie': cookieHeader,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': cookies.user_agent || navigator.userAgent,
        'Referer': 'https://www.instagram.com/',
        'Origin': 'https://www.instagram.com',
      },
      credentials: 'omit', // Don't rely on automatic cookie handling
    });

    console.log('[DialogBrain Hybrid] Thread fetch response:', response.status);

    if (response.status === 200) {
      const data = await response.json();
      if (data.thread) {
        return data.thread;
      }
    }

    return null;
  } catch (e) {
    console.error('[DialogBrain Hybrid] Thread fetch error:', e.message);
    return null;
  }
}

/**
 * Forward messages from Instagram thread to backend.
 * @param {string} threadId - Instagram thread ID (short format ~17 digits)
 * @param {string} threadV2Id - Instagram thread_v2_id (long format, optional)
 * @param {Array} messages - Array of message items from Instagram API
 * @param {string} dsUserId - Current user's Instagram user ID
 * @param {Array} threadUsers - Optional array of thread participants from thread.users
 */
async function forwardMessagesToBackend(threadId, threadV2Id, messages, dsUserId, threadUsers = []) {
  const authToken = await getAuthToken();
  if (!authToken) {
    console.warn('[DialogBrain Hybrid] No auth token, cannot forward messages');
    return;
  }

  const apiUrl = await getApiUrl();
  const storage = await chrome.storage.local.get(['instagram_account_id']);

  // Extract participant IDs from thread users (exclude self)
  // This is crucial for matching threads when thread_id formats differ
  const participantIds = (threadUsers || [])
    .map(u => String(u.pk || u.pk_id || u.id || ''))
    .filter(id => id && id !== String(dsUserId));

  // Extract participant names for thread title (exclude self)
  // Prefer full_name, fallback to username
  const otherParticipants = (threadUsers || [])
    .filter(u => String(u.pk || u.pk_id || u.id || '') !== String(dsUserId));
  const participantName = otherParticipants.length > 0
    ? (otherParticipants[0].full_name || otherParticipants[0].username || '')
    : '';

  console.log('[DialogBrain Hybrid] forwardMessagesToBackend:', {
    threadId,
    messageCount: messages?.length,
    dsUserId,
    accountId: storage.instagram_account_id,
    participantIds,
    apiUrl,
  });

  if (!storage.instagram_account_id) {
    console.warn('[DialogBrain Hybrid] No account ID, cannot forward messages');
    return;
  }

  for (const item of messages) {
    const messageId = item.item_id;

    // Check for duplicate locally
    if (messageId && isMessageDuplicate(messageId)) {
      continue;
    }

    // Debug: log the full item structure to see what fields Instagram returns
    console.log('[DialogBrain Hybrid] Item structure:', JSON.stringify(item, null, 2));

    // Extract text - Instagram uses 'text' for text messages
    // For other item types (media, reel_share, etc), text may be elsewhere
    let messageText = '';
    if (item.text) {
      messageText = item.text;
    } else if (item.item_type === 'placeholder' && item.placeholder?.message) {
      messageText = item.placeholder.message;
    } else if (item.item_type === 'reel_share' && item.reel_share?.text) {
      messageText = item.reel_share.text;
    } else if (item.item_type === 'clip' && item.clip?.caption?.text) {
      messageText = item.clip.caption.text;
    } else if (item.item_type === 'media_share') {
      messageText = '[Media]';
    } else if (item.item_type === 'voice_media') {
      messageText = '[Voice Message]';
    } else if (item.item_type === 'animated_media') {
      messageText = '[GIF]';
    }

    // Format event data for backend
    // Include participant_ids for thread matching when thread_id formats differ
    // Include thread_v2_id so backend can validate and use correct format
    const eventData = {
      type: 'direct_message',
      message_id: messageId,
      item_id: messageId,
      thread_id: threadId,
      thread_v2_id: threadV2Id || null,  // Long format ID for reference/validation
      text: messageText,
      timestamp: item.timestamp,
      user_id: String(item.user_id || ''),
      is_outgoing: String(item.user_id) === String(dsUserId),
      item_type: item.item_type,
      participant_ids: participantIds,  // For thread matching
      participant_name: participantName,  // For thread title (full_name or username)
    };

    try {
      await fetch(`${apiUrl}/api/channels/instagram/hybrid/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          account_id: String(storage.instagram_account_id),  // Ensure string for Pydantic
          event_type: 'direct_message',
          event_data: eventData,
          source: 'extension_fetch',
          timestamp: Date.now(),
        }),
      });
    } catch (e) {
      console.error('[DialogBrain Hybrid] Failed to forward message:', e.message);
    }
  }
}

/**
 * Find an active Instagram tab to use for content script operations.
 * Returns the tab ID or null if no Instagram tab is found.
 */
async function findInstagramTab() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
    if (tabs.length > 0) {
      return tabs[0].id;
    }
  } catch (e) {
    console.warn('[DialogBrain Hybrid] Error finding Instagram tab:', e.message);
  }
  return null;
}

/**
 * Send message to content script in an Instagram tab.
 * Returns the response or null if failed.
 */
async function sendToContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      ...message,
      target: 'instagram_content_script',
    });
  } catch (e) {
    console.warn('[DialogBrain Hybrid] Content script message error:', e.message);
    return null;
  }
}

/**
 * Sync Instagram messages by fetching via content script (page context).
 * This bypasses CORS/origin restrictions that block direct API calls from extension.
 * Called when DOM activity is detected or manual refresh is triggered.
 */
async function syncInstagramMessages(threadId = null) {
  try {
    const cookies = await getInstagramCookies();
    const dsUserId = cookies.ds_user_id;

    console.log('[DialogBrain Hybrid] Syncing Instagram messages via content script...', {
      hasSessionId: !!cookies.sessionid,
      dsUserId: dsUserId,
    });

    if (!cookies.sessionid) {
      console.warn('[DialogBrain Hybrid] No Instagram session, cannot sync messages');
      return;
    }

    // Find an Instagram tab to use for fetching
    const tabId = await findInstagramTab();
    if (!tabId) {
      console.warn('[DialogBrain Hybrid] No Instagram tab open, cannot fetch messages via content script');
      // Fall back to direct fetch (may fail with origin error, but worth trying)
      return await syncInstagramMessagesDirectFallback(threadId, dsUserId);
    }

    console.log('[DialogBrain Hybrid] Using Instagram tab', tabId, 'for content script fetch');

    if (threadId) {
      // Fetch specific thread via content script
      const response = await sendToContentScript(tabId, {
        type: 'FETCH_THREAD',
        threadId,
        limit: 20,
      });

      if (response?.success && response.thread?.items) {
        console.log(`[DialogBrain Hybrid] Fetched ${response.thread.items.length} messages from thread ${threadId}`);
        await forwardMessagesToBackend(threadId, response.thread.items, dsUserId);
      } else {
        console.warn('[DialogBrain Hybrid] Failed to fetch thread via content script:', response?.error);
      }
    } else {
      // Fetch inbox via content script - get more threads for initial sync
      const response = await sendToContentScript(tabId, {
        type: 'FETCH_INBOX',
        limit: 20,
      });

      if (response?.success && response.inbox?.threads) {
        console.log(`[DialogBrain Hybrid] Fetched ${response.inbox.threads.length} threads from inbox`);

        for (const thread of response.inbox.threads) {
          // Get items from thread.items array, or use last_permanent_item as fallback
          let items = thread.items || [];

          // Instagram often returns last_permanent_item instead of items array
          // This contains the most recent message in the thread
          if (items.length === 0 && thread.last_permanent_item) {
            items = [thread.last_permanent_item];
            console.log(`[DialogBrain Hybrid] Using last_permanent_item for thread ${thread.thread_id}`);
          }

          if (items.length > 0) {
            console.log(`[DialogBrain Hybrid] Forwarding ${items.length} messages from thread ${thread.thread_id}`);
            // Pass thread.users for participant-based matching when thread IDs differ
            // Pass thread_v2_id for backend validation
            await forwardMessagesToBackend(thread.thread_id, thread.thread_v2_id, items, dsUserId, thread.users);
          } else {
            console.log(`[DialogBrain Hybrid] Thread ${thread.thread_id} has no items or last_permanent_item`);
          }
        }
      } else {
        console.warn('[DialogBrain Hybrid] Failed to fetch inbox via content script:', response?.error);
      }
    }

    console.log('[DialogBrain Hybrid] Instagram message sync completed');
  } catch (e) {
    console.error('[DialogBrain Hybrid] syncInstagramMessages error:', e.message);
  }
}

/**
 * Fallback: try direct API fetch (will likely fail with origin error).
 * This is kept as a backup in case no Instagram tab is available.
 */
async function syncInstagramMessagesDirectFallback(threadId, dsUserId) {
  console.log('[DialogBrain Hybrid] Attempting direct API fetch fallback...');

  if (threadId) {
    const thread = await fetchInstagramThreadMessages(threadId);
    if (thread && thread.items) {
      console.log(`[DialogBrain Hybrid] Direct fetch got ${thread.items.length} messages`);
      // Pass thread.users for participant-based matching, thread_v2_id for validation
      await forwardMessagesToBackend(threadId, thread.thread_v2_id, thread.items, dsUserId, thread.users);
    }
  } else {
    const inbox = await fetchInstagramInbox(20);
    if (inbox && inbox.threads) {
      console.log(`[DialogBrain Hybrid] Direct fetch got ${inbox.threads.length} threads`);
      for (const thread of inbox.threads) {
        const items = thread.items || [];
        if (items.length > 0) {
          // Pass thread.users for participant-based matching, thread_v2_id for validation
          await forwardMessagesToBackend(thread.thread_id, thread.thread_v2_id, items, dsUserId, thread.users);
        }
      }
    }
  }
}

/**
 * Handle DOM activity detection - trigger a sync to fetch new messages.
 * Debounced to avoid too frequent syncs.
 */
async function handleDomActivityDetected(payload) {
  // Debounce: wait 2 seconds before syncing
  if (domActivitySyncTimer) {
    clearTimeout(domActivitySyncTimer);
  }

  domActivitySyncTimer = setTimeout(async () => {
    domActivitySyncTimer = null;

    try {
      const authToken = await getAuthToken();
      if (!authToken) return;

      const apiUrl = await getApiUrl();
      const storage = await chrome.storage.local.get(['instagram_account_id']);

      if (!storage.instagram_account_id) {
        console.warn('[DialogBrain Hybrid] No Instagram account ID for DOM sync');
        return;
      }

      // 1. Sync cookies to keep session fresh
      const response = await fetch(`${apiUrl}/api/channels/instagram/accounts/${storage.instagram_account_id}/sync-cookie`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          ...await getInstagramCookies(),
          trigger: 'dom_activity',
        }),
      });

      if (response.ok) {
        console.log('[DialogBrain Hybrid] Cookie sync completed');
      }

      // 2. Fetch messages directly from Instagram API and forward to backend
      const threadId = payload?.threadId || null;
      await syncInstagramMessages(threadId);

    } catch (e) {
      console.error('[DialogBrain Hybrid] DOM activity sync error:', e.message);
    }
  }, 2000);
}

/**
 * Handle Instagram DM event from content script and forward to backend.
 */
async function handleInstagramDmEvent(payload) {
  if (!payload?.event) return;

  const event = payload.event;

  // Check for duplicate
  const messageId = event.message_id || event.item_id;
  if (messageId && isMessageDuplicate(messageId)) {
    console.log('[DialogBrain Hybrid] Duplicate message, skipping:', messageId);
    return;
  }

  try {
    const authToken = await getAuthToken();
    if (!authToken) return;

    const apiUrl = await getApiUrl();
    const storage = await chrome.storage.local.get(['instagram_account_id']);

    if (!storage.instagram_account_id) {
      console.warn('[DialogBrain Hybrid] No Instagram account ID, cannot forward event');
      return;
    }

    // Forward to backend
    const response = await fetch(`${apiUrl}/api/channels/instagram/hybrid/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        account_id: storage.instagram_account_id,
        event_type: event.type,
        event_data: event,
        source: 'content_script',
        current_url: payload.currentUrl,
        current_thread_id: payload.currentThreadId,
        timestamp: Date.now(),
      }),
    });

    if (response.ok) {
      console.log('[DialogBrain Hybrid] DM event forwarded to backend:', event.type);
    } else {
      console.warn('[DialogBrain Hybrid] Failed to forward event:', response.status);
    }
  } catch (e) {
    console.error('[DialogBrain Hybrid] Error forwarding event:', e.message);
  }
}

// =============================================================================
// Message Handlers (for popup communication)
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    // SET_AUTO_MODE handler (must be at the beginning to avoid issues with long handler chain)
    if (message.type === 'SET_AUTO_MODE') {
    (async () => {
      const enabled = message.enabled;
      const dm_send_mode = enabled ? 'auto' : 'draft';
      console.log(`[DialogBrain] SET_AUTO_MODE: enabled=${enabled}, dm_send_mode=${dm_send_mode}`);

      try {
        // Get auth token first
        const authToken = await getAuthToken();
        if (!authToken) {
          console.warn('[DialogBrain] SET_AUTO_MODE: No auth token, updating local state only');
          if (!draftState.autoMode.instagram) {
            draftState.autoMode.instagram = { dm_send_mode: 'draft', auto_delay_seconds: 0 };
          }
          draftState.autoMode.instagram.dm_send_mode = dm_send_mode;
          await persistDraftState();
          extensionWS._notifyContentScripts('AUTO_MODE_CHANGED', { enabled });
          sendResponse({ success: true, warning: 'No auth token, local state only' });
          return;
        }

        const apiUrl = await getApiUrl();
        console.log(`[DialogBrain] SET_AUTO_MODE: Fetching settings from ${apiUrl}`);

        const getResponse = await fetch(`${apiUrl}/api/auto-reply/settings`, {
          headers: { 'Authorization': `Bearer ${authToken}` },
        });

        if (!getResponse.ok) {
          throw new Error(`Failed to get settings: ${getResponse.status}`);
        }

        const currentSettings = await getResponse.json();
        console.log('[DialogBrain] SET_AUTO_MODE: Current settings fetched');

        const updatedSettings = { ...currentSettings, dm_send_mode };

        const putResponse = await fetch(`${apiUrl}/api/auto-reply/settings`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify(updatedSettings),
        });

        if (!putResponse.ok) {
          throw new Error(`Failed to update settings: ${putResponse.status}`);
        }

        console.log('[DialogBrain] SET_AUTO_MODE: Backend updated successfully');

        if (!draftState.autoMode.instagram) {
          draftState.autoMode.instagram = { dm_send_mode: 'draft', auto_delay_seconds: 0 };
        }
        draftState.autoMode.instagram.dm_send_mode = dm_send_mode;

        await persistDraftState();
        extensionWS._notifyContentScripts('AUTO_MODE_CHANGED', { enabled });

        console.log('[DialogBrain] SET_AUTO_MODE: Success, sending response');
        sendResponse({ success: true });
      } catch (e) {
        console.error('[DialogBrain] SET_AUTO_MODE error:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // ==========================================================================
  // Instagram Content Script Messages
  // ==========================================================================

  // Messages from content script (has source field)
  if (message.source === 'instagram_content_script') {
    handleInstagramContentScriptMessage(message, sender, sendResponse);
    return true;
  }

  // ==========================================================================
  // Original Message Handlers
  // ==========================================================================

  if (message.type === 'GET_STATUS') {
    // Check and reset any stuck syncs before returning status
    checkAndResetStuckSyncs();
    sendResponse({
      instagram: syncStatus.instagram,
      linkedin: syncStatus.linkedin,
      instagramHybrid: {
        mode: instagramHybrid.mode,
        tabsCount: instagramHybrid.tabs.size,
        lastModeChange: instagramHybrid.lastModeChange,
      },
    });
    return true;
  }

  // Manual reset for stuck syncs
  if (message.type === 'RESET_SYNC') {
    const platform = message.platform || 'all';
    console.log(`[DialogBrain] Manual sync reset requested for: ${platform}`);
    if (platform === 'all' || platform === 'instagram') {
      syncStatus.instagram = { syncing: false, lastSync: null, error: null, startedAt: null };
    }
    if (platform === 'all' || platform === 'linkedin') {
      syncStatus.linkedin = { syncing: false, lastSync: null, error: null, startedAt: null };
    }
    sendResponse({ success: true, status: { instagram: syncStatus.instagram, linkedin: syncStatus.linkedin } });
    return true;
  }

  if (message.type === 'MANUAL_SYNC') {
    if (message.platform === 'instagram') {
      syncInstagramCookies()
        .then((result) => {
          console.log('[DialogBrain] Instagram sync completed:', result);
          sendResponse({ success: result?.success ?? false, status: syncStatus.instagram });
        })
        .catch((error) => {
          console.error('[DialogBrain] Instagram sync error in MANUAL_SYNC:', error);
          syncStatus.instagram = { syncing: false, lastSync: null, error: error.message, startedAt: null };
          sendResponse({ success: false, status: syncStatus.instagram, error: error.message });
        });
    } else if (message.platform === 'linkedin') {
      syncLinkedInCookies()
        .then((result) => {
          console.log('[DialogBrain] LinkedIn sync completed:', result);
          sendResponse({ success: result?.success ?? false, status: syncStatus.linkedin });
        })
        .catch((error) => {
          console.error('[DialogBrain] LinkedIn sync error in MANUAL_SYNC:', error);
          syncStatus.linkedin = { syncing: false, lastSync: null, error: error.message, startedAt: null };
          sendResponse({ success: false, status: syncStatus.linkedin, error: error.message });
        });
    } else {
      sendResponse({ success: false, error: 'Unknown platform' });
    }
    return true; // Keep message channel open for async response
  }

  // Sync Instagram messages (fetch from API and forward to backend)
  if (message.type === 'SYNC_MESSAGES') {
    (async () => {
      try {
        console.log('[DialogBrain] Manual message sync requested for', message.platform);
        if (message.platform === 'instagram') {
          await syncInstagramMessages(message.threadId || null);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Unsupported platform' });
        }
      } catch (e) {
        console.error('[DialogBrain] Sync messages error:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (message.type === 'SET_AUTH_TOKEN') {
    const storageData = { auth_token: message.token };
    if (message.refreshToken) {
      storageData.refresh_token = message.refreshToken;
    }
    chrome.storage.local.set(storageData).then(async () => {
      // Clear any cached settings to force re-read
      cachedSettings = null;
      console.log('[DialogBrain] Auth tokens updated and cache cleared');

      // Connect WebSocket for auto-reply events
      await extensionWS.connect();

      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'LOGOUT') {
    chrome.storage.local.remove(['auth_token', 'refresh_token', 'instagram_account_id', 'linkedin_account_id']).then(() => {
      console.log('[DialogBrain] Logged out');
      syncStatus = {
        instagram: { syncing: false, lastSync: null, error: 'Not logged in', startedAt: null },
        linkedin: { syncing: false, lastSync: null, error: 'Not logged in', startedAt: null },
      };
      sendResponse({ success: true });
    });
    return true;
  }

  // Get auto-reply WebSocket status (from content scripts)
  if (message.type === 'GET_AUTOREPLY_STATUS') {
    // If no drafts loaded and WebSocket not connected, try loading via REST API
    const shouldLoadDrafts = draftState.drafts.size === 0 && !extensionWS.isConnected();
    if (shouldLoadDrafts) {
      // Load drafts async and return current state immediately
      loadDraftsViaRestApi().catch(e => console.warn('[DialogBrain] Failed to load drafts on status check:', e.message));
    }

    sendResponse({
      installed: true,
      ...extensionWS.getStatus(),
      drafts: Array.from(draftState.drafts.values()),
    });
    return true;
  }

  // Get pending drafts (from content scripts)
  if (message.type === 'GET_PENDING_DRAFTS') {
    sendResponse({
      installed: true,
      drafts: Array.from(draftState.drafts.values()),
      count: draftState.drafts.size,
    });
    return true;
  }

  // Get draft panel state (from React DraftPanel component)
  if (message.type === 'GET_DRAFT_PANEL_STATE') {
    // If no drafts loaded, try loading via REST API
    if (draftState.drafts.size === 0) {
      loadDraftsViaRestApi().catch(e => console.warn('[DialogBrain] Failed to load drafts on panel state:', e.message));
    }

    sendResponse({
      wsConnected: extensionWS.isConnected(),
      autoMode: draftState.autoMode.instagram?.dm_send_mode === 'auto',
      drafts: Array.from(draftState.drafts.values()),
    });
    return true;
  }

  if (message.type === 'CHECK_COOKIES') {
    (async () => {
      const instagram = await getInstagramCookies();
      const linkedin = await getLinkedInCookies();
      sendResponse({
        instagram: { hasSession: !!instagram.sessionid },
        linkedin: { hasSession: !!linkedin.li_at },
      });
    })();
    return true;
  }

  // Verify Instagram session directly from browser context
  if (message.type === 'VERIFY_INSTAGRAM_SESSION') {
    (async () => {
      const result = await verifyInstagramSession();
      sendResponse(result);
    })();
    return true;
  }

  // Sync with specific approach
  if (message.type === 'SYNC_INSTAGRAM') {
    (async () => {
      const result = await syncInstagramCookies({
        useUnipile: message.useUnipile !== false, // Default true
        forceExtensionVerify: message.forceExtensionVerify || false,
      });
      sendResponse(result);
    })();
    return true;
  }

  // Settings changed - clear cache and log
  if (message.type === 'SETTINGS_CHANGED') {
    cachedSettings = null;
    console.log('[DialogBrain] Settings changed notification received');
    sendResponse({ success: true });
    return true;
  }

  // Get current settings
  if (message.type === 'GET_SETTINGS') {
    (async () => {
      const settings = await getSettings();
      sendResponse(settings);
    })();
    return true;
  }

  // Approve a draft (from content scripts)
  if (message.type === 'APPROVE_DRAFT') {
    (async () => {
      const { draftId, editedText, alreadySent } = message;
      console.log(`[DialogBrain] Approve draft requested from content script: ${draftId}, alreadySent=${alreadySent}`);

      try {
        const draft = draftState.drafts.get(draftId);
        if (!draft && !alreadySent) {
          console.warn(`[DialogBrain] Draft ${draftId} not found in local state`);
        }

        const authToken = await getAuthToken();
        const apiUrl = await getApiUrl();

        // alreadySent=true: message was sent via DOM, mark as 'sent' (skip_send=true)
        // alreadySent=false: user clicked Send, queue for extension (status='approved')
        const requestBody = alreadySent
          ? { edited_text: editedText || null, skip_send: true }
          : { edited_text: editedText || null, queue_for_extension: true };

        const logAction = alreadySent ? 'skip_send=true (mark as sent)' : 'queue_for_extension=true (set approved)';
        console.log(`[DialogBrain] Calling API to approve draft ${draftId}, ${logAction}`);

        const approveResponse = await fetch(`${apiUrl}/api/auto-reply/drafts/${draftId}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify(requestBody),
        });

        if (!approveResponse.ok) {
          const errText = await approveResponse.text();
          console.error(`[DialogBrain] API approve failed: ${approveResponse.status} - ${errText}`);
        } else {
          const newStatus = alreadySent ? 'sent' : 'approved';
          console.log(`[DialogBrain] Draft ${draftId} status updated to ${newStatus} in backend`);
        }

        // Remove from local state after final status (sent) or keep if just approved
        if (alreadySent) {
          draftState.drafts.delete(draftId);
          if (draftState.pendingCounts.instagram > 0) {
            draftState.pendingCounts.instagram--;
          }
          persistDraftState();
        } else {
          // Update local status to approved
          const localDraft = draftState.drafts.get(draftId);
          if (localDraft) {
            localDraft.status = 'approved';
            draftState.drafts.set(draftId, localDraft);
            persistDraftState();
          }
        }

        // Notify content scripts about draft update
        const notifyStatus = alreadySent ? 'sent' : 'approved';
        extensionWS._notifyContentScripts('DRAFT_UPDATED', { draft_id: draftId, status: notifyStatus });

        sendResponse({ success: true });
      } catch (e) {
        console.error('[DialogBrain] Approve draft error:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Reject a draft (from content scripts)
  if (message.type === 'REJECT_DRAFT') {
    (async () => {
      const { draftId } = message;
      console.log(`[DialogBrain] Reject draft requested from content script: ${draftId}`);

      try {
        // Call backend API to reject
        const authToken = await getAuthToken();
        const apiUrl = await getApiUrl();

        const url = `${apiUrl}/api/auto-reply/drafts/${draftId}/reject`;
        console.log(`[DialogBrain] Reject: calling ${url}`);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
          },
        });

        if (!response.ok) {
          const text = await response.text();
          console.error(`[DialogBrain] Reject: API error: ${response.status} ${text}`);
        } else {
          console.log(`[DialogBrain] Draft ${draftId} rejected in backend`);
        }

        // Remove from local state
        draftState.drafts.delete(draftId);
        if (draftState.pendingCounts.instagram > 0) {
          draftState.pendingCounts.instagram--;
        }
        // Persist state changes
        persistDraftState();

        // Notify content scripts about draft update (use DRAFT_UPDATED with status for content script compatibility)
        extensionWS._notifyContentScripts('DRAFT_UPDATED', { draft_id: draftId, status: 'rejected' });

        sendResponse({ success: true });
      } catch (e) {
        console.error('[DialogBrain] Reject draft error:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Regenerate a draft with optional improvement instructions
  if (message.type === 'REGENERATE_DRAFT') {
    (async () => {
      const { draftId, instructions } = message;
      console.log(`[DialogBrain] Regenerate draft requested: ${draftId}, instructions: ${instructions || 'none'}`);

      try {
        const authToken = await getAuthToken();
        if (!authToken) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }

        const apiUrl = await getApiUrl();
        const response = await fetch(`${apiUrl}/api/auto-reply/drafts/${draftId}/regenerate`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ instructions: instructions || null }),
        });

        if (!response.ok) {
          const text = await response.text();
          console.error(`[DialogBrain] Regenerate: API error: ${response.status} ${text}`);
          sendResponse({ success: false, error: `API error: ${response.status}` });
          return;
        }

        const data = await response.json();
        console.log(`[DialogBrain] Draft ${draftId} regenerated successfully`);

        // Update local draft state with new response text
        const draft = draftState.drafts.get(draftId);
        if (draft) {
          draft.responseText = data.response_text;
          draft.editedText = undefined;
          draftState.drafts.set(draftId, draft);
          persistDraftState();
        }

        // Notify content scripts about the update
        extensionWS._notifyContentScripts('DRAFT_UPDATED', {
          draft_id: draftId,
          response_text: data.response_text,
        });

        sendResponse({ success: true, responseText: data.response_text });
      } catch (e) {
        console.error('[DialogBrain] Regenerate draft error:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Edit a draft's text (save to backend and sync)
  if (message.type === 'EDIT_DRAFT') {
    (async () => {
      const { draftId, editedText } = message;
      console.log(`[DialogBrain] Edit draft requested: ${draftId}`);

      try {
        const authToken = await getAuthToken();
        if (!authToken) {
          sendResponse({ success: false, error: 'Not authenticated' });
          return;
        }

        const apiUrl = await getApiUrl();
        const response = await fetch(`${apiUrl}/api/auto-reply/drafts/${draftId}/edit`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ edited_text: editedText }),
        });

        if (!response.ok) {
          const text = await response.text();
          console.error(`[DialogBrain] Edit: API error: ${response.status} ${text}`);
          sendResponse({ success: false, error: `API error: ${response.status}` });
          return;
        }

        const data = await response.json();
        console.log(`[DialogBrain] Draft ${draftId} edited successfully`);

        // Update local draft state with edited text
        const draft = draftState.drafts.get(draftId);
        if (draft) {
          draft.editedText = editedText;
          draftState.drafts.set(draftId, draft);
          persistDraftState();
        }

        // Notify content scripts about the update
        extensionWS._notifyContentScripts('DRAFT_UPDATED', {
          draft_id: draftId,
          status: 'edited',
          edited_text: editedText,
        });

        sendResponse({ success: true, editedText: data.edited_text });
      } catch (e) {
        console.error('[DialogBrain] Edit draft error:', e.message);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Reload drafts from backend (from content scripts)
  if (message.type === 'RELOAD_DRAFTS') {
    (async () => {
      console.log('[DialogBrain] Reload drafts requested from content script');
      await loadDraftsViaRestApi();
      sendResponse({ success: true, drafts: Array.from(draftState.drafts.values()) });
    })();
    return true;
  }

  } catch (e) {
    console.error('[DialogBrain] UNCAUGHT ERROR in message handler:', e);
    console.error('[DialogBrain] Message that caused error:', message?.type, message);
    try {
      sendResponse({ success: false, error: e.message || 'Unknown error' });
    } catch (sendErr) {
      // sendResponse may fail if channel is closed
    }
  }
});

// =============================================================================
// External Message Handlers (for web page communication)
// =============================================================================

// Allow the DialogBrain web app to detect if extension is installed
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Verify sender is from allowed origins
  const allowedOrigins = [
    'https://stage.dialogbrain.com',
    'https://stage.dialogbrain.com',
    'http://localhost:3000',
  ];

  if (!allowedOrigins.some(origin => sender.origin?.startsWith(origin))) {
    console.warn('[DialogBrain] Rejected message from unauthorized origin:', sender.origin);
    sendResponse({ error: 'Unauthorized origin' });
    return;
  }

  if (message.type === 'PING') {
    // Simple ping to check if extension is installed
    sendResponse({
      installed: true,
      version: chrome.runtime.getManifest().version,
    });
    return true;
  }

  if (message.type === 'GET_STATUS') {
    // Check and reset any stuck syncs before returning status
    checkAndResetStuckSyncs();
    // Check cookies and include hasSession in response
    (async () => {
      const instagram = await getInstagramCookies();
      const linkedin = await getLinkedInCookies();
      sendResponse({
        installed: true,
        version: chrome.runtime.getManifest().version,
        instagram: {
          ...syncStatus.instagram,
          hasSession: !!instagram.sessionid
        },
        linkedin: {
          ...syncStatus.linkedin,
          hasSession: !!linkedin.li_at
        },
      });
    })();
    return true;
  }

  if (message.type === 'SET_AUTH_TOKEN') {
    // Auto-detect dev mode based on sender origin
    const isDevMode = sender.origin?.includes('localhost');
    const storageData = {
      auth_token: message.token,
      dev_mode: isDevMode
    };
    if (message.refreshToken) {
      storageData.refresh_token = message.refreshToken;
    }
    chrome.storage.local.set(storageData).then(async () => {
      // Clear cached settings to force re-read with new dev_mode
      cachedSettings = null;
      const apiUrl = isDevMode ? CONFIG.DEV_API_URL : CONFIG.PROD_API_URL;
      console.log(`[DialogBrain] Auth tokens set, dev_mode=${isDevMode}, API=${apiUrl}`);

      // Connect WebSocket for auto-reply events
      await extensionWS.connect();

      sendResponse({ success: true, devMode: isDevMode });
    });
    return true;
  }

  // Handle logout - disconnect WebSocket
  if (message.type === 'DIALOGBRAIN_LOGOUT') {
    (async () => {
      console.log('[DialogBrain] Logout received, disconnecting WebSocket');
      extensionWS.disconnect();
      draftState.drafts.clear();
      draftState.pendingCounts = { instagram: 0, telegram: 0, whatsapp: 0, email: 0 };
      await chrome.storage.local.remove(['auth_token', 'refresh_token', 'instagram_account_id', 'linkedin_account_id']);
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'CHECK_COOKIES') {
    (async () => {
      const instagram = await getInstagramCookies();
      const linkedin = await getLinkedInCookies();
      sendResponse({
        installed: true,
        instagram: { hasSession: !!instagram.sessionid },
        linkedin: { hasSession: !!linkedin.li_at },
      });
    })();
    return true;
  }

  if (message.type === 'TRIGGER_SYNC') {
    (async () => {
      if (message.platform === 'instagram' || message.platform === 'all') {
        await syncInstagramCookies();
      }
      if (message.platform === 'linkedin' || message.platform === 'all') {
        await syncLinkedInCookies();
      }
      sendResponse({
        success: true,
        instagram: syncStatus.instagram,
        linkedin: syncStatus.linkedin,
      });
    })();
    return true;
  }

  // Verify Instagram session directly from browser context
  if (message.type === 'VERIFY_INSTAGRAM_SESSION') {
    (async () => {
      const result = await verifyInstagramSession();
      sendResponse({ installed: true, ...result });
    })();
    return true;
  }

  // Sync Instagram with specific approach
  if (message.type === 'SYNC_INSTAGRAM') {
    (async () => {
      const result = await syncInstagramCookies({
        useUnipile: message.useUnipile !== false, // Default true
        forceExtensionVerify: message.forceExtensionVerify || false,
      });
      sendResponse({ installed: true, ...result, status: syncStatus.instagram });
    })();
    return true;
  }

  // ==========================================================================
  // Instagram Hybrid Mode External Messages
  // ==========================================================================

  // Get hybrid mode status
  if (message.type === 'GET_INSTAGRAM_HYBRID_STATUS') {
    sendResponse({
      installed: true,
      mode: instagramHybrid.mode,
      tabsCount: instagramHybrid.tabs.size,
      lastModeChange: instagramHybrid.lastModeChange,
      pendingSends: instagramHybrid.pendingSends.length,
    });
    return true;
  }

  // Send DM via hybrid mode (uses content script if available)
  if (message.type === 'INSTAGRAM_HYBRID_SEND_DM') {
    (async () => {
      // Always try content script first - sendInstagramDmViaContentScript has its own tab finding logic
      // It will queue the send if no tab is available
      const result = await sendInstagramDmViaContentScript(
        message.threadId,
        message.text
      );

      if (result.success) {
        sendResponse({ installed: true, ...result, mode: 'content_script' });
      } else if (result.queued) {
        // Send was queued because no tab was available
        sendResponse({
          installed: true,
          success: false,
          error: 'No Instagram tab open - please open Instagram in a browser tab',
          mode: 'content_script',
          queued: true,
          fallbackRequired: true,
        });
      } else {
        // Content script failed
        sendResponse({
          installed: true,
          success: false,
          error: result.error || 'Failed to send via extension',
          mode: 'content_script',
          fallbackRequired: true,
        });
      }
    })();
    return true;
  }

  // Enrich Instagram user (get profile info) via extension
  // This runs from browser context so Instagram sees correct IP
  if (message.type === 'INSTAGRAM_ENRICH_USER') {
    (async () => {
      try {
        const userId = message.user_id;
        if (!userId) {
          sendResponse({ success: false, error: 'Missing user_id' });
          return;
        }

        console.log('[DialogBrain] Enriching Instagram user:', userId);

        // Get cookies for the request
        const cookies = await getInstagramCookies();
        if (!cookies.sessionid) {
          sendResponse({ success: false, error: 'Not logged in to Instagram' });
          return;
        }

        // Make request to Instagram API from browser context
        const response = await fetch(`https://i.instagram.com/api/v1/users/${userId}/info/`, {
          method: 'GET',
          headers: {
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '129477',
            'X-CSRFToken': cookies.csrftoken || '',
            'X-IG-WWW-Claim': '0',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.instagram.com/',
            'Origin': 'https://www.instagram.com',
            'User-Agent': cookies.user_agent,
          },
          credentials: 'include', // Include cookies automatically
        });

        if (!response.ok) {
          console.warn('[DialogBrain] Instagram user info failed:', response.status);
          sendResponse({ success: false, error: `HTTP ${response.status}` });
          return;
        }

        const data = await response.json();
        if (data.status !== 'ok') {
          console.warn('[DialogBrain] Instagram API error:', data.message);
          sendResponse({ success: false, error: data.message || 'API error' });
          return;
        }

        const user = data.user || {};
        const result = {
          success: true,
          user_info: {
            id: String(user.pk || user.pk_id || userId),
            username: user.username || '',
            full_name: user.full_name || '',
            biography: user.biography || '',
            profile_pic_url: user.profile_pic_url || user.hd_profile_pic_url_info?.url || '',
            is_verified: user.is_verified || false,
            is_private: user.is_private || false,
            is_business: user.is_business || false,
            follower_count: user.follower_count,
            following_count: user.following_count,
            media_count: user.media_count,
          },
        };

        console.log('[DialogBrain] Enriched Instagram user:', result.user_info.username);
        sendResponse(result);

      } catch (error) {
        console.error('[DialogBrain] Error enriching Instagram user:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  // Like post via hybrid mode
  if (message.type === 'INSTAGRAM_HYBRID_LIKE_POST') {
    (async () => {
      if (instagramHybrid.mode === 'content_script') {
        const result = await likeInstagramPostViaContentScript(message.postUrl);
        sendResponse({ installed: true, ...result, mode: 'content_script' });
      } else {
        sendResponse({
          installed: true,
          success: false,
          error: 'Content script not available',
          mode: 'cookie_api',
          fallbackRequired: true,
        });
      }
    })();
    return true;
  }

  // Comment on post via hybrid mode
  if (message.type === 'INSTAGRAM_HYBRID_COMMENT_POST') {
    (async () => {
      if (instagramHybrid.mode === 'content_script') {
        const result = await commentInstagramPostViaContentScript(
          message.postUrl,
          message.text
        );
        sendResponse({ installed: true, ...result, mode: 'content_script' });
      } else {
        sendResponse({
          installed: true,
          success: false,
          error: 'Content script not available',
          mode: 'cookie_api',
          fallbackRequired: true,
        });
      }
    })();
    return true;
  }

  // Debug handler - query internal state for troubleshooting
  if (message.type === 'DEBUG_INSTAGRAM_STATE') {
    (async () => {
      try {
        const cookies = await getInstagramCookies();
        const storage = await chrome.storage.local.get(['instagram_account_id', 'auth_token', 'dev_mode']);

        // Test content script fetch (the correct approach)
        let contentScriptTest = null;
        let tabId = null;
        try {
          tabId = await findInstagramTab();
          if (tabId) {
            const response = await sendToContentScript(tabId, {
              type: 'FETCH_INBOX',
              limit: 2,
            });
            contentScriptTest = {
              tabFound: true,
              tabId,
              response: response ? {
                success: response.success,
                httpStatus: response.httpStatus,
                threadCount: response.inbox?.threads?.length || 0,
                error: response.error,
              } : { error: 'No response from content script' },
            };
          } else {
            contentScriptTest = { tabFound: false, error: 'No Instagram tab found' };
          }
        } catch (e) {
          contentScriptTest = { tabFound: !!tabId, error: e.message };
        }

        sendResponse({
          installed: true,
          cookies: {
            hasSessionid: !!cookies.sessionid,
            hasCsrftoken: !!cookies.csrftoken,
            hasDsUserId: !!cookies.ds_user_id,
            dsUserId: cookies.ds_user_id || null,
            hasMid: !!cookies.mid,
          },
          storage: {
            instagramAccountId: storage.instagram_account_id || null,
            hasAuthToken: !!storage.auth_token,
            devMode: storage.dev_mode,
          },
          hybridState: {
            mode: instagramHybrid.mode,
            tabsCount: instagramHybrid.tabs.size,
          },
          contentScriptTest,
          timestamp: Date.now(),
        });
      } catch (e) {
        sendResponse({
          installed: true,
          error: e.message,
        });
      }
    })();
    return true;
  }

  // Manual refresh - trigger full sync and content script polling
  if (message.type === 'MANUAL_REFRESH_INSTAGRAM') {
    (async () => {
      console.log('[DialogBrain] Manual refresh requested from frontend');
      try {
        // 1. Trigger cookie sync with backend
        const syncResult = await syncInstagramCookies({
          trigger: 'manual_refresh',
        });

        // 2. Fetch messages directly from Instagram API (Mode A - browser context)
        console.log('[DialogBrain] Fetching messages from Instagram API...');
        await syncInstagramMessages();

        // 3. If content script mode, also notify all Instagram tabs to poll
        if (instagramHybrid.mode === 'content_script') {
          for (const [tabId, tabInfo] of instagramHybrid.tabs) {
            try {
              await chrome.tabs.sendMessage(tabId, {
                type: 'TRIGGER_POLL',
                target: 'instagram_content_script',
                source: 'manual_refresh',
              });
            } catch (e) {
              // Tab may have been closed
            }
          }
        }

        sendResponse({
          installed: true,
          success: true,
          mode: instagramHybrid.mode,
          syncResult: syncResult,
          tabsPolled: instagramHybrid.tabs.size,
        });
      } catch (e) {
        sendResponse({
          installed: true,
          success: false,
          error: e.message,
          mode: instagramHybrid.mode,
        });
      }
    })();
    return true;
  }

  // Fix Instagram thread IDs (fixes threads stored with wrong ID format)
  if (message.type === 'FIX_INSTAGRAM_THREAD_IDS') {
    (async () => {
      console.log('[DialogBrain] Fix thread IDs requested from frontend');
      try {
        const tabId = await findInstagramTab();
        if (!tabId) {
          sendResponse({
            installed: true,
            success: false,
            error: 'No Instagram tab found - please open Instagram in a browser tab',
          });
          return;
        }

        // Get auth token and API URL
        const storage = await chrome.storage.local.get(['auth_token', 'dev_mode']);
        if (!storage.auth_token) {
          sendResponse({
            installed: true,
            success: false,
            error: 'Not authenticated - please login to DialogBrain first',
          });
          return;
        }

        const apiUrl = storage.dev_mode ? CONFIG.DEV_API_URL : CONFIG.PROD_API_URL;

        // Send to content script to fetch inbox and call backend
        const response = await sendToContentScript(tabId, {
          type: 'FIX_THREAD_IDS',
          target: 'instagram_content_script',
          accountId: message.accountId,
          apiUrl: apiUrl,
          authToken: storage.auth_token,
        });

        sendResponse({
          installed: true,
          ...response,
        });
      } catch (e) {
        sendResponse({
          installed: true,
          success: false,
          error: e.message,
        });
      }
    })();
    return true;
  }

  // ==========================================================================
  // Auto-Reply Draft External Messages
  // ==========================================================================

  // Get auto-reply WebSocket status (external messages from web UI)
  if (message.type === 'GET_AUTOREPLY_STATUS') {
    // If no drafts loaded and WebSocket not connected, try loading via REST API
    const shouldLoadDrafts = draftState.drafts.size === 0 && !extensionWS.isConnected();
    if (shouldLoadDrafts) {
      loadDraftsViaRestApi().catch(e => console.warn('[DialogBrain] Failed to load drafts on external status check:', e.message));
    }

    sendResponse({
      installed: true,
      ...extensionWS.getStatus(),
      drafts: Array.from(draftState.drafts.values()),
    });
    return true;
  }

  // Get pending drafts
  if (message.type === 'GET_PENDING_DRAFTS') {
    sendResponse({
      installed: true,
      drafts: Array.from(draftState.drafts.values()),
      count: draftState.drafts.size,
    });
    return true;
  }

  // Reload drafts (retry after failure)
  if (message.type === 'RELOAD_DRAFTS') {
    (async () => {
      console.log('[DialogBrain] Reload drafts requested');
      try {
        // Try WebSocket method first, fall back to REST API
        if (extensionWS.isConnected()) {
          extensionWS._loadInitialDrafts(0);
        } else {
          await loadDraftsViaRestApi();
        }
        sendResponse({ installed: true, success: true });
      } catch (e) {
        console.warn('[DialogBrain] Failed to reload drafts:', e.message);
        sendResponse({ installed: true, success: false, error: e.message });
      }
    })();
    return true;
  }

  // Approve a draft (from external web page - handles full flow including DOM send)
  if (message.type === 'APPROVE_DRAFT') {
    (async () => {
      const { draftId, editedText, alreadySent } = message;
      console.log(`[DialogBrain] Approve draft requested: ${draftId}, alreadySent: ${alreadySent}`);

      try {
        const draft = draftState.drafts.get(draftId);
        if (!draft) {
          // Draft might have already been removed - still try to call the API
          console.log(`[DialogBrain] Draft ${draftId} not in local state, calling API anyway`);
        }

        const authToken = await getAuthToken();
        const apiUrl = await getApiUrl();

        // Step 1: Set status to 'approved' first (queue for extension)
        // This shows "In Queue" in the UI while we send via DOM
        if (!alreadySent) {
          console.log(`[DialogBrain] Calling API to approve draft ${draftId}, queue_for_extension=true (set status=approved)`);
          const queueResponse = await fetch(`${apiUrl}/api/auto-reply/drafts/${draftId}/approve`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              edited_text: editedText || null,
              queue_for_extension: true,  // Set status to 'approved'
            }),
          });

          if (!queueResponse.ok) {
            const errText = await queueResponse.text();
            console.error(`[DialogBrain] API queue failed: ${queueResponse.status} - ${errText}`);
            // Continue with DOM send anyway - draft might have been expired/cancelled
          } else {
            console.log(`[DialogBrain] Draft ${draftId} status set to 'approved' (in queue)`);
          }

          // Update local status to approved
          const localDraft = draftState.drafts.get(draftId);
          if (localDraft) {
            localDraft.status = 'approved';
            draftState.drafts.set(draftId, localDraft);
            persistDraftState();
          }
        }

        let sendSuccess = alreadySent; // If already sent, skip DOM send

        // Step 2: Send via DOM if not already sent
        if (!alreadySent) {
          // Send to content script to navigate and send via DOM
          const tabId = findActiveInstagramTab();
          if (!tabId) {
            sendResponse({ installed: true, success: false, error: 'No active Instagram tab' });
            return;
          }

          const textToSend = editedText || draft?.responseText;
          if (!textToSend) {
            sendResponse({ installed: true, success: false, error: 'No text to send' });
            return;
          }

          // Get thread_id from channel_ref (format: instagram:123456)
          const threadIdMatch = draft?.channelRef?.match(/instagram:(\d+)/);
          const instagramThreadId = threadIdMatch ? threadIdMatch[1] : draft?.threadId;

          const result = await chrome.tabs.sendMessage(tabId, {
            target: 'instagram_content_script',
            type: 'APPROVE_AND_SEND_DRAFT',
            draftId: draftId,
            threadId: instagramThreadId,
            text: textToSend,
          });

          sendSuccess = result?.success;
          if (!sendSuccess) {
            sendResponse({ installed: true, ...result });
            return;
          }
        }

        // Step 3: Mark as 'sent' after successful DOM send
        console.log(`[DialogBrain] Calling API to mark draft ${draftId} as sent, skip_send=true`);
        const sentResponse = await fetch(`${apiUrl}/api/auto-reply/drafts/${draftId}/approve`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            skip_send: true,  // Mark as 'sent'
          }),
        });

        if (!sentResponse.ok) {
          const errText = await sentResponse.text();
          console.error(`[DialogBrain] API mark sent failed: ${sentResponse.status} - ${errText}`);
        } else {
          console.log(`[DialogBrain] Draft ${draftId} marked as 'sent' in backend`);
        }

        // Remove from local state after sent
        draftState.drafts.delete(draftId);
        if (draftState.pendingCounts.instagram > 0) {
          draftState.pendingCounts.instagram--;
        }
        persistDraftState();

        sendResponse({ installed: true, success: sendSuccess });
      } catch (e) {
        console.error('[DialogBrain] Approve draft error:', e.message);
        sendResponse({ installed: true, success: false, error: e.message });
      }
    })();
    return true;
  }

  // Reject a draft (from external web page)
  if (message.type === 'REJECT_DRAFT') {
    (async () => {
      const { draftId } = message;
      console.log(`[DialogBrain External] Reject draft requested: ${draftId}`);

      try {
        // Call backend API to reject
        const authToken = await getAuthToken();
        const apiUrl = await getApiUrl();

        const response = await fetch(`${apiUrl}/api/auto-reply/drafts/${draftId}/reject`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
          },
        });

        if (!response.ok) {
          const text = await response.text();
          console.error(`[DialogBrain External] Reject API error: ${response.status} ${text}`);
        }

        // Remove from local state
        draftState.drafts.delete(draftId);
        if (draftState.pendingCounts.instagram > 0) {
          draftState.pendingCounts.instagram--;
        }
        // Persist state changes
        persistDraftState();

        sendResponse({ installed: true, success: true });
      } catch (e) {
        console.error('[DialogBrain External] Reject draft error:', e.message);
        sendResponse({ installed: true, success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get/update auto-mode settings
  if (message.type === 'GET_AUTOREPLY_SETTINGS') {
    sendResponse({
      installed: true,
      autoMode: draftState.autoMode,
    });
    return true;
  }

  if (message.type === 'UPDATE_AUTOREPLY_SETTINGS') {
    (async () => {
      const { channel, dm_send_mode, auto_delay_seconds } = message;
      console.log(`[DialogBrain] Update auto-reply settings: ${channel} -> ${dm_send_mode}`);

      try {
        // Update backend
        const authToken = await getAuthToken();
        const apiUrl = await getApiUrl();

        // Get current settings first
        const getResponse = await fetch(`${apiUrl}/api/auto-reply/settings`, {
          headers: { 'Authorization': `Bearer ${authToken}` },
        });
        const currentSettings = await getResponse.json();

        // Update the specific channel setting
        const updatedSettings = { ...currentSettings };
        if (channel === 'instagram') {
          updatedSettings.dm_send_mode = dm_send_mode;
          if (auto_delay_seconds !== undefined) {
            updatedSettings.auto_delay_seconds = auto_delay_seconds;
          }
        }

        await fetch(`${apiUrl}/api/auto-reply/settings`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify(updatedSettings),
        });

        // Update local state
        if (draftState.autoMode[channel]) {
          draftState.autoMode[channel].dm_send_mode = dm_send_mode;
          if (auto_delay_seconds !== undefined) {
            draftState.autoMode[channel].auto_delay_seconds = auto_delay_seconds;
          }
        }

        // Notify all content scripts about settings change
        extensionWS._notifyContentScripts('SETTINGS_CHANGED', {
          channel: channel,
          dm_send_mode: dm_send_mode,
          auto_delay_seconds: auto_delay_seconds || 0,
        });

        sendResponse({ installed: true, success: true });
      } catch (e) {
        console.error('[DialogBrain] Update settings error:', e.message);
        sendResponse({ installed: true, success: false, error: e.message });
      }
    })();
    return true;
  }

  // Reconnect WebSocket
  if (message.type === 'RECONNECT_AUTOREPLY_WS') {
    (async () => {
      console.log('[DialogBrain] Reconnect WebSocket requested');
      extensionWS.disconnect();
      await extensionWS.connect();
      sendResponse({ installed: true, success: true, ...extensionWS.getStatus() });
    })();
    return true;
  }
});

// =============================================================================
// Initialization
// =============================================================================

console.log('[DialogBrain] Cookie Sync extension initialized');

// Initial sync on install/update
chrome.runtime.onInstalled.addListener(() => {
  console.log('[DialogBrain] Extension installed/updated, running initial sync');
  // Delay initial sync to allow service worker to fully initialize
  setTimeout(() => {
    syncInstagramCookies();
    syncLinkedInCookies();
  }, 5000);
});

// Connect WebSocket on service worker startup if token exists
(async () => {
  // Phase 1: Restore drafts from storage first (before WebSocket connects)
  // This ensures drafts survive service worker suspension/restart
  await restoreDraftState();

  const authToken = await getAuthToken();
  if (authToken) {
    console.log('[DialogBrain] Auth token found, connecting WebSocket...');
    await extensionWS.connect();

    // Phase 2: ALWAYS load drafts via REST API on startup
    // WebSocket events may be unreliable, so REST API is the source of truth
    console.log('[DialogBrain] Loading drafts via REST API on startup...');
    await loadDraftsViaRestApi();

    // Phase 3: Load auto-reply settings from REST API
    // This ensures autoMode is synced even if storage is empty
    console.log('[DialogBrain] Loading auto-reply settings on startup...');
    await loadSettingsViaRestApi();
  } else {
    console.log('[DialogBrain] No auth token, WebSocket not connected');
  }
})();

/**
 * Load drafts via REST API (fallback when WebSocket is not connected).
 * This ensures drafts are available in the extension even if WebSocket fails.
 */
async function loadDraftsViaRestApi() {
  try {
    const authToken = await getAuthToken();
    if (!authToken) return;

    const apiUrl = await getApiUrl();

    const response = await fetch(`${apiUrl}/api/auto-reply/drafts?limit=50`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      console.warn(`[DialogBrain] Failed to load drafts: HTTP ${response.status}`);
      return;
    }

    const drafts = await response.json();
    const now = Date.now();

    // Filter to Instagram only, actionable statuses, and not expired
    const instagramDrafts = drafts.filter(d =>
      d.channel_type === 'instagram' &&
      (d.status === 'pending' || d.status === 'approved') &&
      (!d.expires_at || new Date(d.expires_at).getTime() > now)
    );

    console.log(`[DialogBrain] Loaded ${instagramDrafts.length} Instagram drafts via REST API`);

    // Separate pending and approved (queue) drafts
    const pendingDrafts = instagramDrafts.filter(d => d.status === 'pending');
    const approvedDrafts = instagramDrafts.filter(d => d.status === 'approved');

    console.log(`[DialogBrain] Pending: ${pendingDrafts.length}, In Queue (approved): ${approvedDrafts.length}`);

    // Update draftState with fresh data from server (always update, server is source of truth)
    let newCount = 0;
    for (const draft of instagramDrafts) {
      const isNew = !draftState.drafts.has(draft.id);
      draftState.drafts.set(draft.id, {
        id: draft.id,
        threadId: draft.thread_id,
        channelAccountId: draft.channel_account_id,
        channelRef: draft.channel_ref,
        channelType: draft.channel_type,
        threadTitle: draft.thread_title,
        triggerSender: draft.trigger_sender_name,
        triggerText: draft.trigger_text,
        responseText: draft.edited_text || draft.response_text,
        createdAt: new Date(draft.created_at),
        expiresAt: new Date(draft.expires_at),
        status: draft.status,
      });
      if (isNew) newCount++;
    }

    // Update pending count
    draftState.pendingCounts.instagram = Array.from(draftState.drafts.values())
      .filter(d => d.channelType === 'instagram').length;

    console.log(`[DialogBrain] REST API loaded ${newCount} new drafts, total: ${draftState.drafts.size}`);

    // Resume sending for approved drafts (they were approved but not yet sent)
    for (const draft of approvedDrafts) {
      console.log(`[DialogBrain] Resuming send for approved draft ${draft.id}`);
      // Add to auto-send queue (already approved, just needs to be sent)
      extensionWS._autoApproveDraft(draft.id, {
        draft_id: draft.id,
        thread_id: draft.thread_id,
        channel_ref: draft.channel_ref,
        channel_type: draft.channel_type,
        response_text: draft.edited_text || draft.response_text,
        thread_title: draft.thread_title,
      });
    }

    // Persist to storage
    await persistDraftState();

    // Notify content scripts
    for (const [tabId] of instagramHybrid.tabs) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          target: 'instagram_content_script',
          source: 'dialogbrain_ws',
          type: 'DRAFTS_LOADED',
          payload: {
            drafts: Array.from(draftState.drafts.values()),
            count: draftState.pendingCounts.instagram,
          },
          timestamp: Date.now(),
        });
      } catch (e) {
        // Tab may be closed
      }
    }
  } catch (e) {
    console.warn('[DialogBrain] Failed to load drafts via REST API:', e.message);
  }
}

/**
 * Load auto-reply settings via REST API.
 * This ensures autoMode is properly synced on startup.
 */
async function loadSettingsViaRestApi() {
  try {
    const authToken = await getAuthToken();
    if (!authToken) return;

    const apiUrl = await getApiUrl();

    const response = await fetch(`${apiUrl}/api/auto-reply/settings`, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      console.warn(`[DialogBrain] Failed to load settings: HTTP ${response.status}`);
      return;
    }

    const settings = await response.json();

    // Update draftState.autoMode for instagram
    if (!draftState.autoMode.instagram) {
      draftState.autoMode.instagram = {};
    }
    draftState.autoMode.instagram.dm_send_mode = settings.dm_send_mode || 'draft';
    draftState.autoMode.instagram.auto_delay_seconds = settings.auto_delay_seconds || 0;

    console.log(`[DialogBrain] Loaded settings via REST API: dm_send_mode=${settings.dm_send_mode}`);

    // Notify content scripts about the loaded settings
    for (const [tabId] of instagramHybrid.tabs) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          target: 'instagram_content_script',
          source: 'dialogbrain_ws',
          type: 'SETTINGS_CHANGED',
          payload: {
            channel: 'instagram',
            dm_send_mode: settings.dm_send_mode || 'draft',
            auto_delay_seconds: settings.auto_delay_seconds || 0,
          },
          timestamp: Date.now(),
        });
      } catch (e) {
        // Tab may be closed
      }
    }
  } catch (e) {
    console.warn('[DialogBrain] Failed to load settings via REST API:', e.message);
  }
}

// Re-connect WebSocket when storage changes (e.g., token refreshed)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.auth_token) {
    if (changes.auth_token.newValue) {
      console.log('[DialogBrain] Auth token changed, reconnecting WebSocket...');
      extensionWS.connect();
    } else {
      console.log('[DialogBrain] Auth token removed, disconnecting WebSocket...');
      extensionWS.disconnect();
    }
  }
});
