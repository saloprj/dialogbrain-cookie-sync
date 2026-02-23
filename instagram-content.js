/**
 * Instagram Content Script for DialogBrain
 *
 * Responsibilities:
 * - Inject WebSocket interceptor into page context
 * - Receive DM events from interceptor via postMessage
 * - Relay events to background.js via chrome.runtime.sendMessage
 * - Handle DOM-based message sending when instructed
 * - Track page state (which thread is open, etc.)
 *
 * Data Flow:
 *   Incoming: instagram-ws-interceptor.js → postMessage → this script → background.js
 *   Outgoing: background.js → this script → DOM manipulation → Instagram
 */

(function() {
  'use strict';

  // Generate unique instance ID for this script load
  // Used to detect stale listeners after extension reload
  const INSTANCE_ID = Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  // Check for existing instance and invalidate it
  if (window.__dialogbrain_content_script_installed) {
    console.log('[DialogBrain Content] Previous instance detected, invalidating:', window.__dialogbrain_instance_id);
    // Mark old instance as stale - old listeners will check this and exit early
    window.__dialogbrain_instance_stale = true;
  }

  // Store current instance ID
  window.__dialogbrain_instance_id = INSTANCE_ID;
  window.__dialogbrain_instance_stale = false;
  window.__dialogbrain_content_script_installed = true;

  // Clear any existing intervals from previous instance
  if (window.__dialogbrain_tracking_interval) {
    clearInterval(window.__dialogbrain_tracking_interval);
    window.__dialogbrain_tracking_interval = null;
  }
  if (window.__dialogbrain_fallback_interval) {
    clearInterval(window.__dialogbrain_fallback_interval);
    window.__dialogbrain_fallback_interval = null;
  }

  console.log('[DialogBrain Content] Instagram content script initializing, instance:', INSTANCE_ID);

  // =============================================================================
  // State
  // =============================================================================

  const state = {
    interceptorReady: false,
    wsConnected: false,
    wsError: false,
    currentThreadId: null,
    lastActivity: Date.now(),
    lastWsDisconnect: null,
    pendingSends: [], // Queue of messages to send via DOM
  };

  // =============================================================================
  // Utility Functions
  // =============================================================================

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Pending message storage key
  const PENDING_MESSAGE_KEY = 'dialogbrain_pending_dm';

  /**
   * Store a pending message in localStorage for sending after navigation.
   * Includes retry count to prevent infinite loops.
   */
  function storePendingMessage(threadId, text, retryCount = 0) {
    try {
      const pending = {
        threadId,
        text,
        timestamp: Date.now(),
        retryCount,
      };
      localStorage.setItem(PENDING_MESSAGE_KEY, JSON.stringify(pending));
      console.log('[DialogBrain Content] Stored pending message for thread:', threadId, 'retry:', retryCount);
    } catch (e) {
      console.error('[DialogBrain Content] Failed to store pending message:', e);
    }
  }

  /**
   * Retrieve and clear pending message from localStorage.
   * Returns null if no pending message or if it's too old (> 30 seconds).
   */
  function getPendingMessage() {
    try {
      const data = localStorage.getItem(PENDING_MESSAGE_KEY);
      if (!data) return null;

      localStorage.removeItem(PENDING_MESSAGE_KEY);

      const pending = JSON.parse(data);
      // Expire pending messages after 30 seconds
      if (Date.now() - pending.timestamp > 30000) {
        console.log('[DialogBrain Content] Pending message expired');
        return null;
      }

      return pending;
    } catch (e) {
      console.error('[DialogBrain Content] Failed to get pending message:', e);
      return null;
    }
  }

  /**
   * Check for and process any pending messages after page load.
   * Has a max retry limit to prevent infinite navigation loops.
   * Uses human-like delays and behavior simulation to avoid detection.
   */
  async function processPendingMessage() {
    const MAX_RETRIES = 2;

    // If we're on the login page, clear any pending messages and stop
    if (location.pathname.includes('/accounts/login')) {
      localStorage.removeItem(PENDING_MESSAGE_KEY);
      console.log('[DialogBrain Content] On login page, cleared pending message');
      return;
    }

    const pending = getPendingMessage();
    if (!pending) return;

    const retryCount = pending.retryCount || 0;
    console.log('[DialogBrain Content] Found pending message for thread:', pending.threadId, 'retry:', retryCount);

    // Check if we've exceeded max retries
    if (retryCount >= MAX_RETRIES) {
      console.error('[DialogBrain Content] Max retries exceeded for pending message, giving up');
      return;
    }

    // === HUMAN SIMULATION: Wait for page to fully load ===
    // Initial wait for page DOM to be ready
    await sleep(2000);

    // Simulate human "reading" the page - random delay 3-8 seconds
    const readTime = 3000 + Math.random() * 5000;
    console.log('[DialogBrain Content] Simulating read time:', Math.round(readTime/1000), 'seconds');
    await sleep(readTime);

    // Check if we're on the correct thread now
    const currentThread = getCurrentThreadId();
    if (currentThread !== pending.threadId) {
      console.warn('[DialogBrain Content] Current thread mismatch, expected:', pending.threadId, 'got:', currentThread);

      // Add longer delay before navigation to seem more human
      const navDelay = 1000 + Math.random() * 2000;
      console.log('[DialogBrain Content] Waiting before navigation:', Math.round(navDelay/1000), 'seconds');
      await sleep(navDelay);

      // Try SPA navigation first
      const spaSuccess = await navigateToThreadSPA(pending.threadId);

      if (spaSuccess) {
        // SPA navigation worked - we're on the right thread now, proceed to send
        console.log('[DialogBrain Content] SPA navigation succeeded, proceeding to send');
        // Clear the pending message since we'll handle it right here
        localStorage.removeItem(PENDING_MESSAGE_KEY);
      } else {
        // SPA navigation failed - fallback to page reload
        console.log('[DialogBrain Content] SPA navigation failed, using page reload');
        storePendingMessage(pending.threadId, pending.text, retryCount + 1);
        location.href = `https://www.instagram.com/direct/t/${pending.threadId}/`;
        return;
      }
    }

    // === HUMAN SIMULATION: Scroll and mouse activity before typing ===
    await simulateHumanActivity();

    // Try to send the message with human-like typing
    console.log('[DialogBrain Content] Sending pending message with human simulation...');
    const result = await sendMessageViaDomHumanlike(pending.threadId, pending.text);
    console.log('[DialogBrain Content] Pending message result:', result);
  }

  /**
   * Simulate human-like activity before taking action.
   * Includes scrolling, mouse movements, and random delays.
   */
  async function simulateHumanActivity() {
    console.log('[DialogBrain Content] Simulating human activity...');

    // Random small scroll (humans often scroll a bit when looking at chat)
    const scrollAmount = Math.floor(Math.random() * 100) - 50; // -50 to +50
    window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    await sleep(300 + Math.random() * 500);

    // Simulate mouse movement by triggering mousemove events at random positions
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: x,
        clientY: y,
        bubbles: true
      }));
      await sleep(100 + Math.random() * 200);
    }

    // Small pause after "looking around"
    await sleep(500 + Math.random() * 1000);
    console.log('[DialogBrain Content] Human activity simulation complete');
  }

  /**
   * Send a DM via DOM manipulation with human-like behavior.
   * This version includes realistic typing delays and pauses.
   */
  async function sendMessageViaDomHumanlike(threadId, text) {
    try {
      console.log(`[DialogBrain Content] Sending DM via DOM (humanlike) to thread ${threadId}`);

      // Find message input
      const inputSelectors = [
        'div[role="textbox"][aria-label="Message"]',
        'div[role="textbox"][contenteditable="true"]',
        'main div[role="textbox"]',
        'div[aria-label*="Message"][contenteditable="true"]',
        'textarea[placeholder*="Message"]',
        'textarea[aria-label*="Message"]',
      ];

      const result = await waitForAnySelector(inputSelectors, 8000);
      if (!result) {
        return { success: false, error: 'Message input not found' };
      }

      const input = result.element;
      console.log(`[DialogBrain Content] Found input, starting human-like typing...`);

      // Simulate clicking on the input (human would click before typing)
      input.click();
      await sleep(200 + Math.random() * 300);

      // Focus with slight delay
      input.focus();
      await sleep(100 + Math.random() * 200);

      // Type with human-like delays (slower, with occasional pauses)
      await typeHumanlike(input, text);

      // Pause after typing (human reads what they wrote)
      const reviewTime = 500 + Math.random() * 1500;
      console.log('[DialogBrain Content] Reviewing message for:', Math.round(reviewTime), 'ms');
      await sleep(reviewTime);

      // Find and click send button
      const sendSelectors = [
        'button[aria-label="Send"]',
        'div[role="button"][aria-label="Send"]',
      ];

      await sleep(200);
      const sendResult = await waitForAnySelector(sendSelectors, 3000);

      if (sendResult) {
        let sendBtn = sendResult.element;
        if (sendBtn.tagName === 'svg' || sendBtn.tagName === 'path') {
          sendBtn = sendBtn.closest('button') || sendBtn.closest('div[role="button"]') || sendBtn.parentElement;
        }

        // Small delay before clicking send (human hesitation)
        await sleep(100 + Math.random() * 300);
        sendBtn.click();
        await sleep(500);
      } else {
        // Try Enter key
        await sendViaEnterKey(input);
        await sleep(500);
      }

      // Verify message was sent
      const finalContent = (input.textContent || input.value || '').trim();
      const wasCleared = finalContent === '' || finalContent === 'Message...' || !finalContent.includes(text.substring(0, 10));

      if (!wasCleared) {
        console.warn('[DialogBrain Content] Message may not have been sent');
        return { success: false, error: 'Message may not have been sent' };
      }

      console.log('[DialogBrain Content] Message sent successfully (humanlike)');
      return { success: true, method: 'dom-humanlike' };

    } catch (e) {
      console.error('[DialogBrain Content] Humanlike DOM send error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Type text with human-like variable delays and occasional pauses.
   */
  async function typeHumanlike(element, text) {
    element.focus();
    await sleep(50);

    // Clear existing content
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    await sleep(30);
    document.execCommand('delete', false, null);
    await sleep(50);

    // Type character by character with variable human-like delays
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      document.execCommand('insertText', false, char);

      // Variable delay based on character type
      let delay;
      if (char === ' ') {
        // Slightly longer pause at word boundaries
        delay = 80 + Math.random() * 120; // 80-200ms
      } else if ('.!?'.includes(char)) {
        // Longer pause at sentence boundaries
        delay = 150 + Math.random() * 250; // 150-400ms
      } else {
        // Normal typing speed
        delay = 40 + Math.random() * 80; // 40-120ms
      }

      // Occasional longer pause (thinking)
      if (Math.random() < 0.05) { // 5% chance
        delay += 200 + Math.random() * 500; // Add 200-700ms
      }

      await sleep(delay);
    }

    // Final input event
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(100);
  }

  /**
   * Wait for an element to appear in the DOM.
   * Returns the element or null if timeout.
   */
  async function waitForSelector(selector, timeout = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
      await sleep(100);
    }

    return null;
  }

  /**
   * Wait for any of multiple selectors to appear.
   * Returns { element, selector } or null if timeout.
   */
  async function waitForAnySelector(selectors, timeout = 5000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          return { element, selector };
        }
      }
      await sleep(100);
    }

    return null;
  }

  /**
   * Extract current thread ID from URL if on a DM thread page.
   */
  function getCurrentThreadId() {
    const match = location.pathname.match(/\/direct\/t\/(\d+)/);
    return match ? match[1] : null;
  }

  /**
   * Check if we're on Instagram Direct messages page.
   */
  function isOnDirectPage() {
    return location.pathname.includes('/direct/');
  }

  /**
   * Navigate to a thread using SPA navigation (no page reload).
   * Tries multiple strategies:
   * 1. Click on thread link in sidebar
   * 2. Use history.pushState + dispatch navigation event
   * 3. Fallback to location.href (page reload)
   *
   * @param {string} threadId - Instagram thread ID
   * @returns {Promise<boolean>} - true if SPA navigation succeeded
   */
  async function navigateToThreadSPA(threadId) {
    const targetUrl = `/direct/t/${threadId}/`;
    const fullUrl = `https://www.instagram.com${targetUrl}`;

    console.log(`[DialogBrain Content] Attempting SPA navigation to thread: ${threadId}`);

    // Strategy 1: Find and click thread link in sidebar
    // Look for links in the inbox/thread list that match the thread ID
    const threadLinks = document.querySelectorAll(`a[href*="/direct/t/${threadId}"]`);
    if (threadLinks.length > 0) {
      console.log(`[DialogBrain Content] Found ${threadLinks.length} thread link(s), clicking first one`);
      const link = threadLinks[0];

      // Simulate human click
      link.dispatchEvent(new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true,
        ctrlKey: false,
        metaKey: false,
      }));

      // Wait and verify navigation happened
      await sleep(500);
      if (getCurrentThreadId() === threadId) {
        console.log(`[DialogBrain Content] SPA navigation via click succeeded`);
        return true;
      }
    }

    // Strategy 2: Use React Router navigation via history
    // Instagram uses React with client-side routing
    try {
      console.log(`[DialogBrain Content] Trying history.pushState navigation`);

      // Push state first
      history.pushState(null, '', targetUrl);

      // Dispatch popstate event to trigger React Router
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));

      // Wait and check if React updated the view
      await sleep(300);

      // Check if Instagram's React app responded to the navigation
      // by looking for the message input which appears when in a thread
      const messageInput = document.querySelector('[role="textbox"][contenteditable="true"]');
      if (messageInput && getCurrentThreadId() === threadId) {
        console.log(`[DialogBrain Content] SPA navigation via pushState succeeded`);
        return true;
      }

      // Also check if URL matches (even if input not found yet)
      if (location.pathname === targetUrl) {
        // Give React a bit more time to render
        await sleep(500);
        const inputAfterWait = document.querySelector('[role="textbox"][contenteditable="true"]');
        if (inputAfterWait) {
          console.log(`[DialogBrain Content] SPA navigation via pushState succeeded (delayed)`);
          return true;
        }
      }
    } catch (e) {
      console.log(`[DialogBrain Content] pushState navigation failed:`, e.message);
    }

    // Strategy 3: If we're already on direct page, navigate to inbox first then thread
    // This can help Instagram's router pick up the navigation
    if (isOnDirectPage()) {
      try {
        console.log(`[DialogBrain Content] Trying via inbox intermediate navigation`);
        history.pushState(null, '', '/direct/inbox/');
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
        await sleep(200);

        history.pushState(null, '', targetUrl);
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
        await sleep(500);

        if (getCurrentThreadId() === threadId) {
          console.log(`[DialogBrain Content] SPA navigation via inbox intermediate succeeded`);
          return true;
        }
      } catch (e) {
        console.log(`[DialogBrain Content] Inbox intermediate navigation failed:`, e.message);
      }
    }

    console.log(`[DialogBrain Content] SPA navigation failed, will use page reload`);
    return false;
  }

  // =============================================================================
  // Inject WebSocket Interceptor
  // =============================================================================

  function injectInterceptor() {
    // Create script element to inject into page context (main world)
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('instagram-ws-interceptor.js');
    script.type = 'text/javascript';

    script.onload = function() {
      console.log('[DialogBrain Content] WebSocket interceptor script injected');
      script.remove();
    };

    script.onerror = function(e) {
      console.error('[DialogBrain Content] Failed to inject interceptor:', e);
    };

    // Inject into document head as early as possible
    (document.head || document.documentElement).appendChild(script);
  }

  // =============================================================================
  // Message Handling from Interceptor
  // =============================================================================

  function handleInterceptorMessage(event) {
    // Check if this instance is stale (extension was reloaded)
    if (window.__dialogbrain_instance_id !== INSTANCE_ID) {
      return;
    }

    // Only accept messages from our interceptor
    if (event.source !== window || event.data?.source !== 'dialogbrain_ws_interceptor') {
      return;
    }

    const { type, payload, timestamp } = event.data;
    state.lastActivity = Date.now();

    switch (type) {
      case 'DIALOGBRAIN_IG_INTERCEPTOR_READY':
        console.log('[DialogBrain Content] Interceptor ready');
        state.interceptorReady = true;
        notifyBackground('INTERCEPTOR_READY', { timestamp });
        break;

      case 'DIALOGBRAIN_IG_WS_CONNECTED':
        console.log('[DialogBrain Content] WebSocket connected');
        state.wsConnected = true;
        notifyBackground('WS_CONNECTED', payload);
        break;

      case 'DIALOGBRAIN_IG_WS_DISCONNECTED':
        console.log('[DialogBrain Content] WebSocket disconnected:', payload?.code, payload?.reason || '');
        state.wsConnected = false;
        state.lastWsDisconnect = Date.now();
        notifyBackground('WS_DISCONNECTED', payload);
        // Start fallback polling when WS disconnects
        startFallbackPolling();
        break;

      case 'DIALOGBRAIN_IG_WS_ERROR':
        console.warn('[DialogBrain Content] WebSocket error');
        state.wsError = true;
        notifyBackground('WS_ERROR', payload);
        break;

      case 'DIALOGBRAIN_IG_MESSAGE':
        console.log('[DialogBrain Content] DM event received:', payload?.type);
        handleDmEvent(payload);
        // Reset fallback polling since WS is working
        state.wsConnected = true;
        stopFallbackPolling();
        break;

      default:
        // Unknown message type
        break;
    }
  }

  // =============================================================================
  // Fallback Polling (when WebSocket is unreliable)
  // =============================================================================

  let lastKnownThreadState = null;

  /**
   * Start periodic DOM polling as fallback when WebSocket is disconnected.
   */
  function startFallbackPolling() {
    if (window.__dialogbrain_fallback_interval) return; // Already running

    console.log('[DialogBrain Content] Starting fallback DOM polling');

    // Poll every 5 seconds
    window.__dialogbrain_fallback_interval = setInterval(() => {
      // Check if this instance is stale
      if (window.__dialogbrain_instance_id !== INSTANCE_ID) {
        stopFallbackPolling();
        return;
      }
      if (state.wsConnected) {
        stopFallbackPolling();
        return;
      }
      pollForNewMessages();
    }, 5000);

    // Also poll immediately
    pollForNewMessages();
  }

  /**
   * Stop fallback polling when WebSocket reconnects.
   */
  function stopFallbackPolling() {
    if (window.__dialogbrain_fallback_interval) {
      console.log('[DialogBrain Content] Stopping fallback polling (WS reconnected)');
      clearInterval(window.__dialogbrain_fallback_interval);
      window.__dialogbrain_fallback_interval = null;
    }
  }

  /**
   * Poll DOM for new messages in the current thread.
   * This is a fallback when WebSocket interception fails.
   */
  function pollForNewMessages() {
    if (!isOnDirectPage()) return;

    try {
      // Get current thread info from DOM
      const threadId = getCurrentThreadId();
      if (!threadId) return;

      // Find message container
      const messageContainer = document.querySelector('[role="main"]');
      if (!messageContainer) return;

      // Get thread list to detect unread indicators
      const threadList = document.querySelectorAll('[role="listitem"]');
      const currentState = {
        threadId,
        threadCount: threadList.length,
        timestamp: Date.now(),
      };

      // Check for unread indicators (blue dots)
      let hasUnread = false;
      threadList.forEach(item => {
        // Instagram shows unread with a blue dot or bold text
        const unreadIndicator = item.querySelector('[aria-label*="unread"], [class*="unread"]');
        if (unreadIndicator) {
          hasUnread = true;
        }
      });

      // If state changed, notify background to trigger a sync
      if (lastKnownThreadState) {
        const changed = (
          currentState.threadCount !== lastKnownThreadState.threadCount ||
          hasUnread
        );

        if (changed) {
          console.log('[DialogBrain Content] DOM change detected, notifying background');
          notifyBackground('DOM_ACTIVITY_DETECTED', {
            threadId,
            hasUnread,
            previousCount: lastKnownThreadState.threadCount,
            currentCount: currentState.threadCount,
          });
        }
      }

      lastKnownThreadState = currentState;
    } catch (e) {
      // Ignore DOM polling errors
    }
  }

  /**
   * Process DM event and relay to background.
   */
  function handleDmEvent(dmEvent) {
    if (!dmEvent) return;

    // Handle ig_message_sync - new Instagram format with parsed messages
    if (dmEvent.type === 'ig_message_sync') {
      console.log('[DialogBrain Content] ig_message_sync received:', dmEvent.messages?.length || 0, 'messages');
      // Debounce - only sync once per 3 seconds (faster than dm_activity since we know it's real)
      const now = Date.now();
      if (!state.lastActivitySync || now - state.lastActivitySync > 3000) {
        state.lastActivitySync = now;
        // Trigger inbox fetch via background to sync new messages
        notifyBackground('TRIGGER_INBOX_SYNC', {
          reason: 'ig_message_sync',
          thread_id: dmEvent.thread_id,
          messages: dmEvent.messages,
          currentUrl: location.href,
          currentThreadId: getCurrentThreadId(),
        });
      }
      return;
    }

    // If we detected DM activity but couldn't parse it, trigger a fetch sync
    // This handles cases where Instagram's binary MQTT format has changed
    if (dmEvent.type === 'dm_activity_detected') {
      console.log('[DialogBrain Content] DM activity detected but unparseable, triggering fetch sync');
      // Debounce - only sync once per 5 seconds
      const now = Date.now();
      if (!state.lastActivitySync || now - state.lastActivitySync > 5000) {
        state.lastActivitySync = now;
        // Trigger inbox fetch via background to sync new messages
        notifyBackground('TRIGGER_INBOX_SYNC', {
          reason: 'dm_activity_detected',
          currentUrl: location.href,
          currentThreadId: getCurrentThreadId(),
        });
      }
      return;
    }

    // Relay to background
    notifyBackground('IG_DM_EVENT', {
      event: dmEvent,
      currentUrl: location.href,
      currentThreadId: getCurrentThreadId(),
    });
  }

  // =============================================================================
  // Communication with Background
  // =============================================================================

  function notifyBackground(type, payload) {
    chrome.runtime.sendMessage({
      source: 'instagram_content_script',
      type: type,
      payload: payload,
      url: location.href,
      timestamp: Date.now(),
    }).catch(e => {
      // Background may not be ready yet
      console.warn('[DialogBrain Content] Failed to notify background:', e.message);
    });
  }

  // =============================================================================
  // DOM-based Actions (Sending DMs, Likes, Comments)
  // =============================================================================

  /**
   * Simulate human-like typing into an input element.
   * Handles both textarea and contenteditable div (React's controlled inputs).
   */
  async function typeIntoInput(input, text, slowly = true) {
    input.focus();
    await sleep(50);

    // Check if it's a contenteditable div (Instagram's message input)
    const isContentEditable = input.getAttribute('contenteditable') === 'true' ||
                               input.getAttribute('role') === 'textbox';

    if (isContentEditable) {
      // For contenteditable divs (Instagram's React input)
      await typeIntoContentEditable(input, text, slowly);
    } else {
      // For regular textarea/input
      await typeIntoRegularInput(input, text, slowly);
    }
  }

  /**
   * Type into a contenteditable div (Instagram's message input).
   * Uses a combination of methods to ensure React picks up the changes.
   */
  async function typeIntoContentEditable(element, text, slowly = true) {
    element.focus();
    await sleep(50);

    // Clear existing content by selecting all and deleting
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    await sleep(30);

    // Delete selected content
    document.execCommand('delete', false, null);
    await sleep(30);

    // Find the paragraph element inside (Instagram wraps content in <p>)
    let targetElement = element.querySelector('p') || element;

    if (slowly) {
      // Type character by character
      for (let i = 0; i < text.length; i++) {
        const char = text[i];

        // Use insertText command which works well with React
        // execCommand already triggers input event, so we don't dispatch another
        document.execCommand('insertText', false, char);

        await sleep(20 + Math.random() * 40); // 20-60ms between chars
      }
    } else {
      // Insert all at once - execCommand triggers its own input event
      document.execCommand('insertText', false, text);
    }

    // Dispatch a generic input event to notify React the value changed
    // Use a plain Event (not InputEvent with insertText) to avoid duplication
    element.dispatchEvent(new Event('input', { bubbles: true }));

    // Final blur and focus to ensure React state is updated
    await sleep(50);
    element.blur();
    await sleep(30);
    element.focus();
    await sleep(50);
  }

  /**
   * Type into a regular textarea or input element.
   */
  async function typeIntoRegularInput(input, text, slowly = true) {
    input.focus();

    // Clear existing content
    input.select?.();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    if (slowly) {
      for (const char of text) {
        document.execCommand('insertText', false, char);
        await sleep(30 + Math.random() * 70);
      }
    } else {
      document.execCommand('insertText', false, text);
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(50);
  }

  /**
   * Send a DM via Instagram's API (no navigation required).
   * Returns { success: boolean, error?: string, messageId?: string }
   */
  async function sendMessageViaApi(threadId, text) {
    // Ensure fetch helper is ready (required for page context communication)
    if (!fetchHelperReady) {
      console.log('[DialogBrain Content] Waiting for fetch helper...');
      const ready = await waitForFetchHelper();
      if (!ready) {
        console.error('[DialogBrain Content] Fetch helper not ready for send');
        return { success: false, error: 'Fetch helper not ready' };
      }
    }

    try {
      console.log(`[DialogBrain Content] Sending DM via API to thread ${threadId}`);

      // Use fetch helper to send message
      const result = await sendFetchRequest('SEND_MESSAGE', { threadId, text });

      if (result.success) {
        console.log('[DialogBrain Content] Message sent via API, messageId:', result.messageId);
        return {
          success: true,
          messageId: result.messageId,
          clientContext: result.clientContext,
        };
      } else {
        console.error('[DialogBrain Content] API send failed:', result.error);
        return {
          success: false,
          error: result.error || 'API send failed',
        };
      }
    } catch (e) {
      console.error('[DialogBrain Content] API send error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Send a DM via DOM manipulation.
   * Returns { success: boolean, error?: string, navigationRequired?: boolean }
   */
  async function sendMessageViaDom(threadId, text) {
    try {
      console.log(`[DialogBrain Content] Sending DM via DOM to thread ${threadId}`);

      // Check if we need to navigate to a different thread
      const currentThread = getCurrentThreadId();
      if (currentThread !== threadId) {
        const threadUrl = `https://www.instagram.com/direct/t/${threadId}/`;
        console.log(`[DialogBrain Content] Need to navigate to thread: ${threadUrl}`);

        // Store the pending message so it can be sent after navigation
        storePendingMessage(threadId, text);

        // === HUMAN SIMULATION: Add random delay before navigation ===
        // Humans don't instantly navigate - they "decide" first
        const preNavDelay = 500 + Math.random() * 1500; // 0.5-2 seconds
        console.log(`[DialogBrain Content] Human delay before navigation: ${Math.round(preNavDelay)}ms`);

        setTimeout(() => {
          location.href = threadUrl;
        }, preNavDelay);

        return {
          success: false,
          error: 'Navigation required',
          navigationRequired: true,
          targetThread: threadId
        };
      }

      // Find message input - Instagram uses contenteditable div with role="textbox"
      // The input is inside the conversation area, not in navigation
      const inputSelectors = [
        // Primary: contenteditable textbox (current Instagram UI)
        'div[role="textbox"][aria-label="Message"]',
        'div[role="textbox"][contenteditable="true"]',
        // Fallback: any textbox in the main area
        'main div[role="textbox"]',
        'div[aria-label*="Message"][contenteditable="true"]',
        // Legacy: textarea (older UI)
        'textarea[placeholder*="Message"]',
        'textarea[aria-label*="Message"]',
      ];

      console.log('[DialogBrain Content] Looking for message input...');
      const result = await waitForAnySelector(inputSelectors, 8000);

      if (!result) {
        console.error('[DialogBrain Content] Message input not found with any selector');
        return { success: false, error: 'Message input not found' };
      }

      const input = result.element;
      console.log(`[DialogBrain Content] Found input with selector: ${result.selector}`);

      // Get initial content to compare later
      const initialContent = input.textContent || '';
      console.log('[DialogBrain Content] Initial input content:', initialContent.substring(0, 50));

      // Type the message
      await typeIntoInput(input, text, false); // Use fast typing for reliability
      await sleep(300);

      // Verify text was entered - only use alternative if completely empty
      const currentContent = (input.textContent || input.innerText || input.value || '').trim();
      console.log('[DialogBrain Content] Current input content after typing:', currentContent.substring(0, 50));

      // Only try alternative if the content is completely empty (typing failed entirely)
      // Don't try if there's any content to avoid duplication
      if (currentContent.length === 0) {
        console.warn('[DialogBrain Content] Input appears completely empty, trying alternative method');
        await tryAlternativeInput(input, text);
        await sleep(200);
      } else {
        console.log('[DialogBrain Content] Text entered successfully, length:', currentContent.length);
      }

      // Find and click send button
      // Instagram shows "Send" button when there's text, otherwise shows voice/media buttons
      const sendSelectors = [
        // Primary: Send button that appears when text is entered
        'button[aria-label="Send"]',
        'div[role="button"][aria-label="Send"]',
        'button svg[aria-label="Send"]',
        // The send button might be identified by its icon
        'button:has(svg[aria-label="Send"])',
        // Fallback: submit button
        'button[type="submit"]',
      ];

      console.log('[DialogBrain Content] Looking for send button...');

      // Wait a bit for send button to appear (it shows when there's text)
      await sleep(200);

      const sendResult = await waitForAnySelector(sendSelectors, 3000);

      if (sendResult) {
        let sendBtn = sendResult.element;
        console.log(`[DialogBrain Content] Found send button: ${sendResult.selector}`);

        // If we found an SVG or element inside button, get the clickable parent
        if (sendBtn.tagName === 'svg' || sendBtn.tagName === 'path') {
          sendBtn = sendBtn.closest('button') || sendBtn.closest('div[role="button"]') || sendBtn.parentElement;
        }

        // Click the send button
        console.log('[DialogBrain Content] Clicking send button...');
        sendBtn.click();
        await sleep(300);
      } else {
        // Try pressing Enter as fallback
        console.log('[DialogBrain Content] Send button not found, trying Enter key');
        await sendViaEnterKey(input);
      }

      await sleep(500);

      // Verify message was sent (input should be cleared or have placeholder text)
      const finalContent = (input.textContent || input.value || '').trim();
      const wasCleared = finalContent === '' || finalContent === 'Message...' || !finalContent.includes(text.substring(0, 10));

      if (!wasCleared) {
        console.warn('[DialogBrain Content] Input not cleared - message may not have been sent');
        // Try Enter key as last resort
        await sendViaEnterKey(input);
        await sleep(500);

        const retryContent = (input.textContent || input.value || '').trim();
        if (retryContent.includes(text.substring(0, 10))) {
          return { success: false, error: 'Message may not have been sent - input not cleared after retry' };
        }
      }

      console.log('[DialogBrain Content] Message sent successfully via DOM');
      return { success: true, method: 'dom' };

    } catch (e) {
      console.error('[DialogBrain Content] DOM send error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Try alternative method to input text using direct manipulation + React events.
   */
  async function tryAlternativeInput(element, text) {
    console.log('[DialogBrain Content] Trying alternative input method...');

    // Focus the element
    element.focus();
    await sleep(50);

    // For contenteditable, try setting innerHTML directly then triggering events
    const paragraph = element.querySelector('p') || element;

    // Create a new text node
    paragraph.innerHTML = text;

    // Dispatch a series of events to notify React
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    });
    element.dispatchEvent(inputEvent);

    // Also try the beforeinput event
    const beforeInputEvent = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text
    });
    element.dispatchEvent(beforeInputEvent);

    // Trigger change event
    element.dispatchEvent(new Event('change', { bubbles: true }));

    await sleep(100);
  }

  /**
   * Send message by pressing Enter key with proper event simulation.
   */
  async function sendViaEnterKey(input) {
    console.log('[DialogBrain Content] Sending via Enter key...');

    input.focus();
    await sleep(50);

    // Simulate keydown, keypress, and keyup for Enter
    const keydownEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });

    const keypressEvent = new KeyboardEvent('keypress', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });

    const keyupEvent = new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });

    input.dispatchEvent(keydownEvent);
    await sleep(10);
    input.dispatchEvent(keypressEvent);
    await sleep(10);
    input.dispatchEvent(keyupEvent);
    await sleep(100);
  }

  /**
   * Like a post via DOM manipulation.
   * Returns { success: boolean, error?: string }
   */
  async function likePostViaDom(postUrl) {
    try {
      console.log(`[DialogBrain Content] Liking post: ${postUrl}`);

      // Navigate if not on the post
      if (!location.href.includes(postUrl)) {
        location.href = postUrl;
        await sleep(2000);
      }

      // Find like button (both unliked and liked states)
      const likeSelectors = [
        'svg[aria-label="Like"]',
        'span[class*="LikeButton"] svg',
        'button svg[aria-label="Like"]',
        'div[role="button"] svg[aria-label="Like"]',
      ];

      const unlikeSelectors = [
        'svg[aria-label="Unlike"]',
      ];

      // Check if already liked
      const unlikeBtn = document.querySelector(unlikeSelectors[0]);
      if (unlikeBtn) {
        console.log('[DialogBrain Content] Post already liked');
        return { success: true, alreadyLiked: true };
      }

      const result = await waitForAnySelector(likeSelectors, 5000);

      if (!result) {
        return { success: false, error: 'Like button not found' };
      }

      let likeBtn = result.element;

      // Get clickable parent
      if (likeBtn.tagName === 'svg') {
        likeBtn = likeBtn.closest('button') || likeBtn.closest('div[role="button"]') || likeBtn.parentElement;
      }

      likeBtn.click();
      await sleep(500);

      // Verify like was registered
      const nowUnlike = document.querySelector(unlikeSelectors[0]);
      if (!nowUnlike) {
        return { success: false, error: 'Like may not have registered' };
      }

      console.log('[DialogBrain Content] Post liked successfully');
      return { success: true };

    } catch (e) {
      console.error('[DialogBrain Content] Like error:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Comment on a post via DOM manipulation.
   * Returns { success: boolean, error?: string }
   */
  async function commentOnPostViaDom(postUrl, text) {
    try {
      console.log(`[DialogBrain Content] Commenting on post: ${postUrl}`);

      // Navigate if not on the post
      if (!location.href.includes(postUrl)) {
        location.href = postUrl;
        await sleep(2000);
      }

      // Find comment input
      const commentSelectors = [
        'textarea[aria-label="Add a comment\u2026"]',
        'textarea[placeholder*="Add a comment"]',
        'form textarea',
      ];

      const result = await waitForAnySelector(commentSelectors, 5000);

      if (!result) {
        return { success: false, error: 'Comment input not found' };
      }

      const input = result.element;

      // Click to expand if needed (some UIs collapse the input)
      input.click();
      await sleep(300);

      // Type comment
      await typeIntoInput(input, text, true);
      await sleep(200);

      // Find and click post button
      const postSelectors = [
        'button[type="submit"]',
        'div[role="button"]:has(svg)',
        'button:contains("Post")',
      ];

      const postBtn = document.querySelector('button[type="submit"]');

      if (postBtn) {
        postBtn.click();
        await sleep(1000);
      } else {
        // Try Enter key
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          ctrlKey: true, // Ctrl+Enter often submits
          bubbles: true,
        }));
        await sleep(1000);
      }

      console.log('[DialogBrain Content] Comment posted');
      return { success: true };

    } catch (e) {
      console.error('[DialogBrain Content] Comment error:', e);
      return { success: false, error: e.message };
    }
  }

  // =============================================================================
  // Fetch Data from Page Context (bypasses extension origin restrictions)
  // =============================================================================

  // Pending fetch requests waiting for page context responses
  const pendingPageFetches = new Map();
  let fetchRequestId = 0;
  let fetchHelperReady = false;

  /**
   * Listen for fetch responses from injected page-context scripts.
   */
  window.addEventListener('message', (event) => {
    // Check if this instance is stale (extension was reloaded)
    if (window.__dialogbrain_instance_id !== INSTANCE_ID) {
      return;
    }

    if (event.source !== window) return;
    if (!event.data) return;

    // Handle fetch helper ready notification
    if (event.data.source === 'dialogbrain_fetch_helper' && event.data.type === 'FETCH_HELPER_READY') {
      console.log('[DialogBrain Content] Fetch helper is ready');
      fetchHelperReady = true;
      return;
    }

    // Handle fetch responses
    if (event.data.source !== 'dialogbrain_page_fetch') return;

    const { requestId, result } = event.data;
    const pending = pendingPageFetches.get(requestId);
    if (pending) {
      pendingPageFetches.delete(requestId);
      pending.resolve(result);
    }
  });

  /**
   * Inject the fetch helper script into page context.
   * Uses web_accessible_resources to bypass CSP.
   */
  function injectFetchHelper() {
    const scriptUrl = chrome.runtime.getURL('instagram-fetch-helper.js');
    console.log('[DialogBrain Content] Injecting fetch helper from:', scriptUrl);

    const script = document.createElement('script');
    script.src = scriptUrl;
    script.type = 'text/javascript';

    script.onload = function() {
      console.log('[DialogBrain Content] Fetch helper script injected successfully');
      script.remove();
    };

    script.onerror = function(e) {
      console.error('[DialogBrain Content] Failed to inject fetch helper:', e);
    };

    (document.head || document.documentElement).appendChild(script);
    console.log('[DialogBrain Content] Fetch helper script element added to DOM');
  }

  /**
   * Wait for fetch helper to be ready.
   */
  async function waitForFetchHelper(timeout = 5000) {
    if (fetchHelperReady) return true;

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      if (fetchHelperReady) return true;
      await sleep(100);
    }
    return false;
  }

  /**
   * Send fetch request to page context via postMessage.
   * Returns a promise that resolves with the fetch result.
   */
  function sendFetchRequest(action, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++fetchRequestId;

      const timeout = setTimeout(() => {
        pendingPageFetches.delete(requestId);
        reject(new Error('Page fetch timeout'));
      }, 15000);

      pendingPageFetches.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
      });

      window.postMessage({
        source: 'dialogbrain_fetch_request',
        requestId,
        action,
        params,
      }, '*');
    });
  }

  /**
   * Fetch inbox from Instagram's API via page context.
   * This bypasses the CORS/origin issues when fetching from extension context.
   */
  async function fetchInboxFromPageContext(limit = 10) {
    // Ensure fetch helper is ready
    if (!fetchHelperReady) {
      console.log('[DialogBrain Content] Waiting for fetch helper...');
      const ready = await waitForFetchHelper();
      if (!ready) {
        console.error('[DialogBrain Content] Fetch helper not ready');
        return { success: false, error: 'Fetch helper not ready' };
      }
    }

    try {
      const result = await sendFetchRequest('FETCH_INBOX', { limit });
      console.log('[DialogBrain Content] Inbox fetch result:', result.success, result.inbox?.threads?.length);
      return result;
    } catch (e) {
      console.error('[DialogBrain Content] Inbox fetch failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * Normalize thread channel_refs by fetching inbox and sending to backend.
   * This normalizes threads to use thread_v2_id format for cross-provider consistency.
   */
  async function fixThreadIds(accountId, apiUrl, authToken) {
    console.log('[DialogBrain Content] Starting thread ID fix for account:', accountId);

    // Fetch inbox to get all threads with both IDs
    const inboxResult = await fetchInboxFromPageContext(50);  // Fetch more threads
    if (!inboxResult.success || !inboxResult.inbox?.threads) {
      console.error('[DialogBrain Content] Failed to fetch inbox for fix:', inboxResult.error);
      return { success: false, error: inboxResult.error || 'Failed to fetch inbox' };
    }

    const threads = inboxResult.inbox.threads;
    console.log('[DialogBrain Content] Fetched', threads.length, 'threads for fix');

    // Send threads to backend for fix
    try {
      const response = await fetch(`${apiUrl}/api/channels/instagram/hybrid/fix-thread-ids`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          account_id: accountId,
          threads: threads.map(t => ({
            thread_id: t.thread_id,
            thread_v2_id: t.thread_v2_id,
          })),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[DialogBrain Content] Backend fix request failed:', response.status, errorText);
        return { success: false, error: `Backend error: ${response.status}` };
      }

      const result = await response.json();
      console.log('[DialogBrain Content] Thread ID fix result:', result);
      return result;
    } catch (e) {
      console.error('[DialogBrain Content] Fix request failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * Fetch specific thread from Instagram's API via page context.
   */
  async function fetchThreadFromPageContext(threadId, limit = 20) {
    // Ensure fetch helper is ready
    if (!fetchHelperReady) {
      console.log('[DialogBrain Content] Waiting for fetch helper...');
      const ready = await waitForFetchHelper();
      if (!ready) {
        console.error('[DialogBrain Content] Fetch helper not ready');
        return { success: false, error: 'Fetch helper not ready' };
      }
    }

    try {
      const result = await sendFetchRequest('FETCH_THREAD', { threadId, limit });
      console.log('[DialogBrain Content] Thread fetch result:', result.success, result.thread?.items?.length);
      return result;
    } catch (e) {
      console.error('[DialogBrain Content] Thread fetch failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  // =============================================================================
  // Handle Messages from Background
  // =============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Check if this instance is stale (extension was reloaded)
    if (window.__dialogbrain_instance_id !== INSTANCE_ID) {
      console.log('[DialogBrain Content] Ignoring message - stale instance');
      return;
    }

    if (message.target !== 'instagram_content_script') {
      return;
    }

    console.log('[DialogBrain Content] Received from background:', message.type);

    switch (message.type) {
      case 'GET_STATUS':
        sendResponse({
          interceptorReady: state.interceptorReady,
          wsConnected: state.wsConnected,
          currentThreadId: getCurrentThreadId(),
          isOnDirectPage: isOnDirectPage(),
          url: location.href,
        });
        return true;

      case 'SEND_DM':
        (async () => {
          // Try API-based sending first (no navigation required)
          const apiResult = await sendMessageViaApi(message.threadId, message.text);
          if (apiResult.success) {
            sendResponse(apiResult);
            return;
          }

          // Fall back to DOM manipulation if API fails
          console.log('[DialogBrain Content] API send failed, falling back to DOM:', apiResult.error);
          const domResult = await sendMessageViaDom(message.threadId, message.text);
          sendResponse(domResult);
        })();
        return true; // Keep channel open for async response

      case 'LIKE_POST':
        (async () => {
          const result = await likePostViaDom(message.postUrl);
          sendResponse(result);
        })();
        return true;

      case 'COMMENT_POST':
        (async () => {
          const result = await commentOnPostViaDom(message.postUrl, message.text);
          sendResponse(result);
        })();
        return true;

      case 'NAVIGATE_TO_THREAD':
        (async () => {
          const threadUrl = `https://www.instagram.com/direct/t/${message.threadId}/`;
          location.href = threadUrl;
          await sleep(1000);
          sendResponse({ success: true });
        })();
        return true;

      case 'PING':
        sendResponse({ pong: true, timestamp: Date.now() });
        return true;

      case 'TRIGGER_POLL':
        // Manual refresh requested - immediately poll for new messages
        console.log('[DialogBrain Content] Manual poll triggered');
        pollForNewMessages();
        // Also notify background of current state
        notifyBackground('DOM_ACTIVITY_DETECTED', {
          threadId: getCurrentThreadId(),
          manual: true,
          source: message.source || 'unknown',
        });
        sendResponse({ success: true, polled: true });
        return true;

      case 'GET_USERNAME':
        // Extract logged-in username from Instagram DOM (no API calls needed)
        (() => {
          try {
            // Known Instagram paths that are NOT usernames
            const knownPaths = new Set([
              '', 'explore', 'reels', 'direct', 'accounts', 'stories',
              'p', 'tv', 'reel', 'live', 'nametag', 'about', 'press',
              'api', 'developer', 'legal', 'terms', 'privacy',
            ]);

            // Method 1 (locale-independent, most reliable):
            // Find profile picture <img> whose alt contains a username that
            // matches a parent <a> link with /<username>/ href pattern.
            // Works for all languages: "Фото профиля rkomaro", "rkomaro's profile picture", etc.
            const allImgs = document.querySelectorAll('img[alt]');
            for (const img of allImgs) {
              const link = img.closest('a[href]');
              if (!link) continue;
              const href = link.getAttribute('href');
              const hrefMatch = href && href.match(/^\/([a-zA-Z0-9_.]+)\/$/);
              if (hrefMatch && !knownPaths.has(hrefMatch[1])) {
                // Verify the alt text contains this username (profile pictures always do)
                if (img.alt.includes(hrefMatch[1])) {
                  sendResponse({ success: true, username: hrefMatch[1] });
                  return;
                }
              }
            }

            // Method 2 (locale-independent fallback):
            // Scan ALL links for /<username>/ pattern excluding known paths.
            // The sidebar always has exactly one user-specific link (profile).
            const allLinks = [...document.querySelectorAll('a[href]')];
            const candidates = [];
            for (const a of allLinks) {
              const href = a.getAttribute('href');
              const match = href && href.match(/^\/([a-zA-Z0-9_.]+)\/$/);
              if (match && !knownPaths.has(match[1])) {
                candidates.push(match[1]);
              }
            }
            // If exactly one unique username found, it's the logged-in user
            const uniqueUsernames = [...new Set(candidates)];
            if (uniqueUsernames.length === 1) {
              sendResponse({ success: true, username: uniqueUsernames[0] });
              return;
            }

            // Method 3: Look for logged-in user data in Instagram's embedded JSON
            const scripts = document.querySelectorAll('script[type="application/json"]');
            for (const script of scripts) {
              try {
                const text = script.textContent || '';
                const viewerMatch = text.match(/"viewer"\s*:\s*\{[^}]*"username"\s*:\s*"([a-zA-Z0-9_.]+)"/);
                if (viewerMatch) {
                  sendResponse({ success: true, username: viewerMatch[1] });
                  return;
                }
              } catch (_) {}
            }

            sendResponse({ success: false, error: 'Username not found in DOM' });
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
        })();
        return true;

      case 'FETCH_INBOX':
        // Fetch inbox from page context (bypasses extension origin restrictions)
        (async () => {
          console.log('[DialogBrain Content] Fetching inbox from page context...');
          const result = await fetchInboxFromPageContext(message.limit || 10);
          sendResponse(result);
        })();
        return true;

      case 'FETCH_THREAD':
        // Fetch specific thread from page context
        (async () => {
          console.log('[DialogBrain Content] Fetching thread from page context:', message.threadId);
          const result = await fetchThreadFromPageContext(message.threadId, message.limit || 20);
          sendResponse(result);
        })();
        return true;

      case 'FIX_THREAD_IDS':
        // Fetch inbox and send to backend to fix thread IDs
        (async () => {
          console.log('[DialogBrain Content] Fixing thread IDs...');
          const result = await fixThreadIds(message.accountId, message.apiUrl, message.authToken);
          sendResponse(result);
        })();
        return true;

      case 'APPROVE_AND_SEND_DRAFT':
        // Approve and send a draft message with human simulation
        (async () => {
          console.log('[DialogBrain Content] Approve and send draft:', message.draftId);
          const result = await sendMessageViaDomHumanlike(message.threadId, message.text);
          sendResponse(result);
        })();
        return true;

      default:
        sendResponse({ error: 'Unknown message type' });
        return true;
    }
  });

  // =============================================================================
  // Page State Tracking
  // =============================================================================

  function trackPageState() {
    // Update current thread ID
    const newThreadId = getCurrentThreadId();
    if (newThreadId !== state.currentThreadId) {
      state.currentThreadId = newThreadId;
      notifyBackground('THREAD_CHANGED', {
        threadId: newThreadId,
        url: location.href,
      });
    }
  }

  // =============================================================================
  // Initialization
  // =============================================================================

  // Listen for messages from injected interceptor
  window.addEventListener('message', handleInterceptorMessage);

  // Inject the WebSocket interceptor
  injectInterceptor();

  // Inject the fetch helper for API calls
  injectFetchHelper();

  // Track page state changes
  window.__dialogbrain_tracking_interval = setInterval(trackPageState, 1000);

  // Notify background that content script is ready
  notifyBackground('CONTENT_SCRIPT_READY', {
    url: location.href,
    isDirectPage: isOnDirectPage(),
    currentThreadId: getCurrentThreadId(),
  });

  console.log('[DialogBrain Content] Instagram content script initialized');

  // Check for any pending messages that need to be sent after navigation
  setTimeout(() => {
    processPendingMessage();
  }, 2000);

  // =============================================================================
  // Auto-Reply Support Functions (for React Panel)
  // =============================================================================

  // Queue for auto-approve drafts waiting for tab to become visible
  const autoApproveQueue = [];
  let isProcessingAutoQueue = false;
  // Track draft IDs that have been processed or are being processed (prevents duplicates)
  const processedOrProcessingDraftIds = new Set();

  /**
   * Process queued auto-approve drafts when tab becomes visible
   */
  async function processAutoApproveQueue() {
    // Check if this instance is stale
    if (window.__dialogbrain_instance_id !== INSTANCE_ID) {
      return;
    }
    if (isProcessingAutoQueue) return;
    if (autoApproveQueue.length === 0) return;
    if (document.visibilityState !== 'visible') return;

    isProcessingAutoQueue = true;
    console.log('[DialogBrain Content] Tab visible, processing', autoApproveQueue.length, 'queued auto-approves');

    while (autoApproveQueue.length > 0 && document.visibilityState === 'visible') {
      // Check if this instance is stale during processing
      if (window.__dialogbrain_instance_id !== INSTANCE_ID) {
        console.log('[DialogBrain Content] Instance became stale during queue processing');
        break;
      }
      const payload = autoApproveQueue.shift();
      // Track this draft as being processed (prevents re-adding from GET_PENDING_AUTO_SENDS)
      processedOrProcessingDraftIds.add(payload.draftId);

      // Notify DraftPanel that this draft is now sending
      try {
        chrome.runtime.sendMessage({
          source: 'instagram_content_script',
          type: 'AUTO_SEND_STARTED',
          payload: { draftId: payload.draftId },
        });
      } catch (e) {
        // Ignore
      }

      try {
        await sendAutoApproveDraft(payload);
      } catch (e) {
        console.error('[DialogBrain Content] Failed to process queued auto-approve:', e);
        // Notify failure so UI can update
        try {
          chrome.runtime.sendMessage({
            source: 'instagram_content_script',
            type: 'AUTO_SEND_COMPLETE',
            payload: { draftId: payload.draftId, success: false },
          });
        } catch (e2) {
          // Ignore
        }
      }
      // Small delay between sends to avoid rate limiting
      if (autoApproveQueue.length > 0) {
        await sleep(2000);
      }
    }

    isProcessingAutoQueue = false;
  }

  // Listen for tab visibility change
  document.addEventListener('visibilitychange', () => {
    // Check if this instance is stale
    if (window.__dialogbrain_instance_id !== INSTANCE_ID) {
      return;
    }
    if (document.visibilityState === 'visible') {
      console.log('[DialogBrain Content] Tab became visible, checking auto-approve queue');
      processAutoApproveQueue();
    }
  });

  /**
   * Handle auto-approve draft (when auto-mode is enabled)
   * This is called from background script when auto-mode triggers
   *
   * IMPORTANT: Always adds to queue and processes serially to prevent
   * concurrent DOM manipulations that cause garbled messages.
   */
  function handleAutoApproveDraft(payload) {
    console.log('[DialogBrain Content] Auto-approving draft:', payload.draftId, 'tab visible:', document.visibilityState === 'visible');

    // Check if already in queue or being processed to prevent duplicates
    if (autoApproveQueue.some(item => item.draftId === payload.draftId)) {
      console.log('[DialogBrain Content] Draft', payload.draftId, 'already in queue, skipping');
      return;
    }
    if (processedOrProcessingDraftIds.has(payload.draftId)) {
      console.log('[DialogBrain Content] Draft', payload.draftId, 'already processed or processing, skipping');
      return;
    }

    // Always add to queue for serial processing
    autoApproveQueue.push(payload);
    // Also track in set to prevent re-adding if shifted before another message arrives
    processedOrProcessingDraftIds.add(payload.draftId);
    console.log('[DialogBrain Content] Added draft', payload.draftId, 'to queue, length:', autoApproveQueue.length);

    // If tab not visible, notify background
    if (document.visibilityState !== 'visible') {
      try {
        chrome.runtime.sendMessage({
          source: 'instagram_content_script',
          type: 'AUTO_SEND_QUEUED',
          payload: { draftId: payload.draftId, queueLength: autoApproveQueue.length },
        });
      } catch (e) {
        // Ignore
      }
      return;
    }

    // Tab is visible - trigger queue processing (will be serialized)
    processAutoApproveQueue();
  }

  /**
   * Actually send the auto-approved draft
   */
  async function sendAutoApproveDraft(payload) {
    console.log('[DialogBrain Content] Sending auto-approved draft:', payload.draftId);

    // Helper to notify background of completion
    const notifyComplete = (success) => {
      try {
        if (!chrome.runtime?.id) return;
        chrome.runtime.sendMessage({
          source: 'instagram_content_script',
          type: 'AUTO_SEND_COMPLETE',
          payload: { draftId: payload.draftId, success },
        });
      } catch (e) {
        console.warn('[DialogBrain Content] Failed to notify auto-send complete:', e);
      }
    };

    try {
      // Extract Instagram thread ID from channel_ref (format: "instagram:12345")
      const channelRefMatch = payload.channelRef?.match(/instagram:(\d+)/);
      const instagramThreadId = channelRefMatch ? channelRefMatch[1] : payload.threadId;

      // Check if we're on the correct thread
      const currentThread = getCurrentThreadId();

      if (currentThread !== String(instagramThreadId)) {
        console.log(`[DialogBrain Content] Auto-approve: Need to navigate from ${currentThread} to ${instagramThreadId}`);

        // Add human-like delay before navigation
        const preNavDelay = 500 + Math.random() * 1000;
        await sleep(preNavDelay);

        // Try SPA navigation first
        const spaSuccess = await navigateToThreadSPA(instagramThreadId);

        if (spaSuccess) {
          console.log('[DialogBrain Content] Auto-approve: SPA navigation succeeded');
          // Wait for page to stabilize
          await sleep(1000);
        } else {
          // SPA failed - fallback to page reload
          console.log('[DialogBrain Content] Auto-approve: Falling back to page reload');
          storePendingMessage(instagramThreadId, payload.text);
          localStorage.setItem('dialogbrain_pending_draft_id', String(payload.draftId));
          location.href = `https://www.instagram.com/direct/t/${instagramThreadId}/`;
          return; // processPendingMessage will handle after navigation
        }
      }

      // Now we're on the correct thread - send the message
      const sendResult = await sendMessageViaDomHumanlike(instagramThreadId, payload.text);

      if (sendResult.success) {
        // Notify background that send was successful (alreadySent=true since we just sent it)
        chrome.runtime.sendMessage({
          type: 'APPROVE_DRAFT',
          draftId: payload.draftId,
          alreadySent: true, // Message was already sent via DOM, just call API
        });

        // Notify background that auto-send completed successfully
        notifyComplete(true);
      } else {
        console.error('[DialogBrain Content] Auto-approve send failed:', sendResult.error);
        // Notify background that auto-send failed
        notifyComplete(false);
      }
    } catch (e) {
      console.error('[DialogBrain Content] Auto-approve error:', e);
      // Notify background that auto-send failed
      notifyComplete(false);
    }
  }

  // Listen for messages from background (only for auto-approve)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Check if this instance is stale (extension was reloaded)
    if (window.__dialogbrain_instance_id !== INSTANCE_ID) {
      return;
    }

    if (!message || message.target !== 'instagram_content_script') return;
    if (message.source !== 'dialogbrain_ws') return;

    // Only handle AUTO_APPROVE_DRAFT - React panel handles other draft events
    if (message.type === 'AUTO_APPROVE_DRAFT' && message.payload) {
      handleAutoApproveDraft(message.payload);
    }
  });

  // Pull model: Request pending auto-sends from background
  // This ensures we process items even if background sent them before we were ready
  setTimeout(() => {
    try {
      if (!chrome.runtime?.id) return;

      chrome.runtime.sendMessage(
        { source: 'instagram_content_script', type: 'GET_PENDING_AUTO_SENDS' },
        (response) => {
          if (chrome.runtime.lastError) {
            console.log('[DialogBrain Content] Failed to get pending auto-sends:', chrome.runtime.lastError.message);
            return;
          }
          if (response?.success && response.queue?.length > 0) {
            console.log(`[DialogBrain Content] Processing ${response.queue.length} pending auto-sends`);
            for (const item of response.queue) {
              handleAutoApproveDraft(item);
            }
          }
        }
      );
    } catch (e) {
      // Ignore - extension context may be invalid
    }
  }, 500); // Small delay to ensure everything is initialized

  // Check for pending draft approval after navigation
  async function checkPendingDraftApproval() {
    const pendingDraftId = localStorage.getItem('dialogbrain_pending_draft_id');
    if (pendingDraftId) {
      localStorage.removeItem('dialogbrain_pending_draft_id');

      // Wait for send to complete (processPendingMessage handles this)
      // After a delay, assume send was successful and approve the draft
      setTimeout(() => {
        try {
          // Check if extension context is still valid
          if (!chrome.runtime?.id) {
            console.log('[DialogBrain] Extension context invalidated, skipping draft approval');
            return;
          }
          const draftId = parseInt(pendingDraftId, 10);
          chrome.runtime.sendMessage({
            type: 'APPROVE_DRAFT',
            draftId: draftId,
            alreadySent: true, // Message was already sent via DOM, just call API
          });

          // Notify background that auto-send completed (for queue processing)
          chrome.runtime.sendMessage({
            source: 'instagram_content_script',
            type: 'AUTO_SEND_COMPLETE',
            payload: { draftId: draftId, success: true },
          });
        } catch (e) {
          console.log('[DialogBrain] Extension context invalidated:', e.message);
        }
      }, 5000);
    }
  }

  // Initialize after page loads
  setTimeout(() => {
    checkPendingDraftApproval();
  }, 2000);

  // Expose functions for React panel to use
  window.__dialogbrain_api = {
    sendMessageViaDom: sendMessageViaDomHumanlike,
    navigateToThread: navigateToThreadSPA,
    getCurrentThreadId: getCurrentThreadId,
    storePendingMessage: storePendingMessage,
  };

})();
