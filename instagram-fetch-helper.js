/**
 * Instagram Fetch Helper
 *
 * This script is injected into Instagram's page context (main world)
 * to fetch data from Instagram's private API.
 *
 * It works around CSP restrictions by being loaded as a separate file
 * via web_accessible_resources.
 */

(function() {
  'use strict';

  // Avoid double-injection
  if (window.__dialogbrain_fetch_helper_installed) {
    return;
  }
  window.__dialogbrain_fetch_helper_installed = true;

  console.log('[DialogBrain] Fetch helper initializing...');

  /**
   * Get the WWW-Claim from sessionStorage (primary) or localStorage (fallback).
   * Instagram stores this in sessionStorage after user interaction.
   */
  function getWwwClaim() {
    try {
      // Primary: sessionStorage (where Instagram actually stores it)
      const sessionClaim = sessionStorage.getItem('www-claim-v2');
      if (sessionClaim) {
        console.log('[DialogBrain Fetch] Got WWW-Claim from sessionStorage');
        return sessionClaim;
      }

      // Fallback: localStorage
      const localClaim = localStorage.getItem('www-claim-v2');
      if (localClaim) {
        console.log('[DialogBrain Fetch] Got WWW-Claim from localStorage');
        return localClaim;
      }
    } catch (e) {
      console.warn('[DialogBrain Fetch] Error getting WWW-Claim:', e);
    }
    return '0';
  }

  /**
   * Listen for fetch requests from content script via postMessage.
   */
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'dialogbrain_fetch_request') return;

    const { requestId, action, params } = event.data;
    console.log('[DialogBrain Fetch] Request:', action, requestId);

    try {
      let result;

      switch (action) {
        case 'FETCH_INBOX':
          result = await fetchInbox(params.limit || 10);
          break;
        case 'FETCH_THREAD':
          result = await fetchThread(params.threadId, params.limit || 20);
          break;
        case 'SEND_MESSAGE':
          result = await sendMessage(params.threadId, params.text);
          break;
        default:
          result = { success: false, error: `Unknown action: ${action}` };
      }

      window.postMessage({
        source: 'dialogbrain_page_fetch',
        requestId,
        result,
      }, '*');

    } catch (e) {
      console.error('[DialogBrain Fetch] Error:', e);
      window.postMessage({
        source: 'dialogbrain_page_fetch',
        requestId,
        result: { success: false, error: e.message },
      }, '*');
    }
  });

  /**
   * Fetch inbox from Instagram's private API.
   */
  async function fetchInbox(limit = 10) {
    // Get X-IG-WWW-Claim from storage (sessionStorage first, then localStorage)
    const wwwClaim = getWwwClaim();

    // Get CSRF token from cookie
    let csrfToken = '';
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'csrftoken') {
          csrfToken = value;
          break;
        }
      }
    } catch (e) {}

    console.log('[DialogBrain Fetch] Fetching inbox with claim:', wwwClaim, 'csrf:', !!csrfToken);

    // Use www.instagram.com (same-origin) to avoid CORS issues
    // i.instagram.com is cross-origin and gets blocked
    const response = await fetch(
      `https://www.instagram.com/api/v1/direct_v2/inbox/?limit=${limit}&thread_message_limit=10`,
      {
        method: 'GET',
        headers: {
          'X-IG-App-ID': '936619743392459',
          'X-ASBD-ID': '129477',
          'X-IG-WWW-Claim': wwwClaim,
          'X-CSRFToken': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        credentials: 'include',
      }
    );

    let data;
    const responseText = await response.text();
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.log('[DialogBrain Fetch] Non-JSON response:', responseText.substring(0, 200));
      return {
        success: false,
        httpStatus: response.status,
        inbox: null,
        error: 'Invalid JSON response',
        responsePreview: responseText.substring(0, 200),
      };
    }

    console.log('[DialogBrain Fetch] Inbox response:', response.status, data.status, 'threads:', data.inbox?.threads?.length);
    // Diagnostic: log first thread structure
    if (data.inbox?.threads?.length > 0) {
      const t = data.inbox.threads[0];
      console.log('[DialogBrain Fetch] Thread[0] keys:', Object.keys(t).join(', '));
      console.log('[DialogBrain Fetch] Thread[0] items:', Array.isArray(t.items) ? t.items.length : typeof t.items);
      console.log('[DialogBrain Fetch] Thread[0] last_permanent_item:', t.last_permanent_item ? 'present' : 'null');
      if (t.items && t.items.length > 0) {
        console.log('[DialogBrain Fetch] Thread[0].items[0]:', JSON.stringify(t.items[0]).substring(0, 200));
      } else if (t.last_permanent_item) {
        console.log('[DialogBrain Fetch] Thread[0].last_permanent_item:', JSON.stringify(t.last_permanent_item).substring(0, 200));
      }
    }

    return {
      success: response.ok && data.status === 'ok',
      httpStatus: response.status,
      inbox: data.inbox || null,
      error: data.message || null,
    };
  }

  /**
   * Fetch specific thread from Instagram's private API.
   */
  async function fetchThread(threadId, limit = 20) {
    // Get X-IG-WWW-Claim from storage (sessionStorage first, then localStorage)
    const wwwClaim = getWwwClaim();

    // Get CSRF token from cookie
    let csrfToken = '';
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'csrftoken') {
          csrfToken = value;
          break;
        }
      }
    } catch (e) {}

    console.log('[DialogBrain Fetch] Fetching thread with claim:', wwwClaim, 'csrf:', !!csrfToken);

    // Use www.instagram.com (same-origin) to avoid CORS issues
    const response = await fetch(
      `https://www.instagram.com/api/v1/direct_v2/threads/${threadId}/?limit=${limit}`,
      {
        method: 'GET',
        headers: {
          'X-IG-App-ID': '936619743392459',
          'X-ASBD-ID': '129477',
          'X-IG-WWW-Claim': wwwClaim,
          'X-CSRFToken': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        credentials: 'include',
      }
    );

    let data;
    const responseText = await response.text();
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.log('[DialogBrain Fetch] Thread non-JSON response:', responseText.substring(0, 200));
      return {
        success: false,
        httpStatus: response.status,
        thread: null,
        error: 'Invalid JSON response',
        responsePreview: responseText.substring(0, 200),
      };
    }

    console.log('[DialogBrain Fetch] Thread response:', response.status, data.status, 'items:', data.thread?.items?.length);

    return {
      success: response.ok && data.status === 'ok',
      httpStatus: response.status,
      thread: data.thread || null,
      error: data.message || null,
    };
  }

  /**
   * Send message to a thread via Instagram's private API.
   * Uses the same endpoint as the mobile app.
   */
  async function sendMessage(threadId, text) {
    if (!threadId || !text) {
      return {
        success: false,
        error: 'threadId and text are required',
      };
    }

    // Get CSRF token from cookie
    let csrfToken = '';
    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'csrftoken') {
          csrfToken = value;
          break;
        }
      }
    } catch (e) {}

    // Get X-IG-WWW-Claim from storage (sessionStorage first, then localStorage)
    const wwwClaim = getWwwClaim();

    // Generate unique client context for message deduplication
    const clientContext = crypto.randomUUID();

    console.log('[DialogBrain Fetch] Sending message to thread:', threadId, 'csrf:', !!csrfToken, 'claim:', wwwClaim?.substring(0, 20));

    // Build form data (Instagram expects application/x-www-form-urlencoded)
    const formData = new URLSearchParams();
    formData.append('action', 'send_item');
    formData.append('thread_ids', JSON.stringify([threadId]));
    formData.append('client_context', clientContext);
    formData.append('text', text);

    try {
      const response = await fetch(
        'https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-IG-App-ID': '936619743392459',
            'X-ASBD-ID': '129477',
            'X-IG-WWW-Claim': wwwClaim,
            'X-CSRFToken': csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          credentials: 'include',
          body: formData.toString(),
        }
      );

      let data;
      const responseText = await response.text();
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        console.log('[DialogBrain Fetch] Send non-JSON response:', responseText.substring(0, 200));
        return {
          success: false,
          httpStatus: response.status,
          error: 'Invalid JSON response',
          responsePreview: responseText.substring(0, 200),
        };
      }

      console.log('[DialogBrain Fetch] Send response:', response.status, data.status);

      if (response.ok && data.status === 'ok') {
        // Extract message ID from response
        const payload = data.payload || {};
        const messageId = payload.item_id || payload.timestamp || clientContext;

        return {
          success: true,
          httpStatus: response.status,
          messageId: messageId,
          clientContext: clientContext,
        };
      } else {
        return {
          success: false,
          httpStatus: response.status,
          error: data.message || data.error_type || 'Send failed',
        };
      }
    } catch (e) {
      console.error('[DialogBrain Fetch] Send error:', e);
      return {
        success: false,
        error: e.message,
      };
    }
  }

  // Notify that fetch helper is ready
  window.postMessage({
    source: 'dialogbrain_fetch_helper',
    type: 'FETCH_HELPER_READY',
    timestamp: Date.now(),
  }, '*');

  console.log('[DialogBrain] Fetch helper installed');

})();
