/**
 * Instagram WebSocket/MQTT Interceptor
 *
 * This script is injected into Instagram's page context (main world)
 * to intercept WebSocket connections and capture real-time DM messages.
 *
 * IMPORTANT: This file is injected via content script, NOT loaded as a module.
 * It runs in Instagram's page context with access to page's WebSocket instances.
 *
 * Data Flow:
 *   Instagram MQTT → WebSocket.onmessage → parseMessage → postMessage → Content Script
 */

(function() {
  'use strict';

  // Avoid double-injection
  if (window.__dialogbrain_ws_interceptor_installed) {
    return;
  }
  window.__dialogbrain_ws_interceptor_installed = true;

  console.log('[DialogBrain] WebSocket interceptor initializing...');

  // Store original WebSocket constructor
  const OriginalWebSocket = window.WebSocket;

  // Track intercepted connections
  const interceptedConnections = new Set();

  /**
   * Check if this WebSocket URL is Instagram's realtime messaging connection.
   * Instagram uses MQTT over WebSocket for DMs.
   */
  function isInstagramRealtimeUrl(url) {
    if (!url) return false;
    return (
      url.includes('edge-chat') ||
      url.includes('mqtt') ||
      url.includes('realtime') ||
      url.includes('wss://edge-chat.instagram.com') ||
      url.includes('wss://mqtt.facebook.com')
    );
  }

  /**
   * Parse Instagram MQTT message payload.
   * Instagram uses a binary MQTT format with /ig_message_sync topic.
   *
   * Format: <binary header>/ig_message_sync<digit>[{JSON array}]
   * Example: /ig_message_sync4[{"data":{"slide_delta_processor":[...]}}]
   *
   * Returns parsed message data or null if not a DM message.
   */
  function parseInstagramMessage(data) {
    try {
      // Handle ArrayBuffer
      if (data instanceof ArrayBuffer) {
        const textDecoder = new TextDecoder('utf-8');
        const text = textDecoder.decode(data);

        // Instagram uses /ig_message_sync topic for DM updates
        // Format: /ig_message_sync<digit>[{json}]
        if (text.includes('/ig_message_sync')) {
          // Find JSON array in the message (starts with '[')
          const arrayStart = text.indexOf('[');
          const arrayEnd = text.lastIndexOf(']');

          if (arrayStart >= 0 && arrayEnd > arrayStart) {
            const jsonStr = text.substring(arrayStart, arrayEnd + 1);
            try {
              const parsed = JSON.parse(jsonStr);
              // Return with special type to indicate it's from ig_message_sync
              return {
                type: 'ig_message_sync',
                data: parsed,
              };
            } catch (e) {
              // JSON parse failed, but we know it's DM-related
              console.log('[DialogBrain] ig_message_sync detected but JSON parse failed');
            }
          }

          // Couldn't parse but detected ig_message_sync - trigger fallback
          return {
            type: 'mqtt_raw',
            hasDirectMessage: true,
            raw: text.substring(0, 500),
          };
        }

        // Try to find JSON object payload in binary data
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');

        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const jsonStr = text.substring(jsonStart, jsonEnd + 1);
          try {
            return JSON.parse(jsonStr);
          } catch (e) {
            // Not valid JSON
          }
        }

        // Also try JSON array
        const arrayStart = text.indexOf('[');
        const arrayEnd = text.lastIndexOf(']');

        if (arrayStart >= 0 && arrayEnd > arrayStart) {
          const jsonStr = text.substring(arrayStart, arrayEnd + 1);
          try {
            return JSON.parse(jsonStr);
          } catch (e) {
            // Not valid JSON
          }
        }

        // Instagram sometimes sends messages in a specific format
        // Look for DM-related indicators - trigger fallback sync
        const hasDmIndicator =
          text.includes('direct_v2') ||
          text.includes('inbox') ||
          text.includes('thread_id') ||
          text.includes('item_id') ||
          text.includes('thread_fbid') ||
          text.includes('SlideUQPPNewMessage') ||
          text.includes('sender_fbid') ||
          (text.includes('direct') && text.includes('message'));

        if (hasDmIndicator) {
          console.log('[DialogBrain] Detected DM activity in binary MQTT, will trigger sync');
          return {
            type: 'mqtt_raw',
            hasDirectMessage: true,
            raw: text.substring(0, 500),
          };
        }

        return null;
      }

      // Handle Blob
      if (data instanceof Blob) {
        // We'll need to read this asynchronously - signal to retry
        return { type: 'blob_pending', size: data.size };
      }

      // Handle string (JSON or text)
      if (typeof data === 'string') {
        // Try JSON parse
        if (data.startsWith('{') || data.startsWith('[')) {
          try {
            return JSON.parse(data);
          } catch (e) {
            // Not valid JSON
          }
        }

        // Check for DM indicators in text
        if (data.includes('direct_v2') || data.includes('message') || data.includes('thread_fbid')) {
          return {
            type: 'text_raw',
            hasDirectMessage: true,
            raw: data.substring(0, 500),
          };
        }
      }

      return null;
    } catch (e) {
      console.warn('[DialogBrain] Message parse error:', e.message);
      return null;
    }
  }

  /**
   * Extract DM-relevant data from parsed Instagram message.
   * Returns structured DM event or null.
   */
  function extractDmEvent(parsed) {
    if (!parsed) return null;

    try {
      // Handle ig_message_sync format (new Instagram format)
      // Structure: { type: 'ig_message_sync', data: [{"data":{"slide_delta_processor":[...]}}] }
      if (parsed.type === 'ig_message_sync' && Array.isArray(parsed.data)) {
        const messages = [];

        for (const item of parsed.data) {
          const deltas = item?.data?.slide_delta_processor;
          if (!Array.isArray(deltas)) continue;

          for (const delta of deltas) {
            // Handle new message
            if (delta.__typename === 'SlideUQPPNewMessage' && delta.message) {
              const msg = delta.message;
              messages.push({
                message_id: msg.id || msg.offline_threading_id,
                thread_id: msg.thread_fbid,
                sender_id: msg.sender_fbid,
                timestamp: msg.timestamp_ms,
                text: msg.text,
              });
            }

            // Handle other delta types that indicate message activity
            if (delta.__typename === 'SlideUQPPMessageReaction' ||
                delta.__typename === 'SlideUQPPMessageDelete' ||
                delta.__typename === 'SlideUQPPReadReceipt') {
              // These also indicate thread activity
              if (delta.thread_fbid || delta.message?.thread_fbid) {
                messages.push({
                  thread_id: delta.thread_fbid || delta.message?.thread_fbid,
                  activity_type: delta.__typename,
                });
              }
            }
          }
        }

        if (messages.length > 0) {
          console.log('[DialogBrain] Parsed ig_message_sync:', messages.length, 'messages');
          return {
            type: 'ig_message_sync',
            messages: messages,
            thread_id: messages[0].thread_id,
          };
        }

        // Couldn't extract messages but we know it's DM-related
        return {
          type: 'dm_activity_detected',
          raw_type: 'ig_message_sync_unparsed',
        };
      }

      // Handle direct thread update
      if (parsed.data?.direct_v2_inbox) {
        const inbox = parsed.data.direct_v2_inbox;
        return {
          type: 'inbox_update',
          unseen_count: inbox.unseen_count,
          unseen_count_ts: inbox.unseen_count_ts,
          pending_requests_total: inbox.pending_requests_total,
        };
      }

      // Handle thread update (new message in thread)
      if (parsed.data?.direct_v2_thread) {
        const thread = parsed.data.direct_v2_thread;
        return {
          type: 'thread_update',
          thread_id: thread.thread_id,
          thread_v2_id: thread.thread_v2_id,
          items: thread.items?.map(item => ({
            item_id: item.item_id,
            item_type: item.item_type,
            text: item.text,
            timestamp: item.timestamp,
            user_id: item.user_id,
            is_sent_by_viewer: item.is_sent_by_viewer,
          })),
        };
      }

      // Handle individual message
      if (parsed.data?.message || parsed.message) {
        const msg = parsed.data?.message || parsed.message;
        return {
          type: 'direct_message',
          message_id: msg.item_id || msg.message_id || msg.id,
          thread_id: msg.thread_id,
          text: msg.text,
          timestamp: msg.timestamp,
          user_id: msg.user_id,
          is_outgoing: msg.is_sent_by_viewer,
        };
      }

      // Handle presence update
      if (parsed.presence) {
        return {
          type: 'presence',
          user_id: parsed.presence.user_id,
          is_active: parsed.presence.is_active,
          last_activity_at_ms: parsed.presence.last_activity_at_ms,
        };
      }

      // Handle typing indicator
      if (parsed.typing_indicator) {
        return {
          type: 'typing',
          thread_id: parsed.typing_indicator.thread_id,
          user_id: parsed.typing_indicator.user_id,
          is_typing: parsed.typing_indicator.is_typing,
        };
      }

      // Raw DM indicator found but couldn't parse structure
      if (parsed.hasDirectMessage) {
        return {
          type: 'dm_activity_detected',
          raw_type: parsed.type,
        };
      }

      return null;
    } catch (e) {
      console.warn('[DialogBrain] DM extraction error:', e.message);
      return null;
    }
  }

  /**
   * Post DM event to content script via window.postMessage.
   */
  function notifyContentScript(eventType, payload) {
    window.postMessage({
      source: 'dialogbrain_ws_interceptor',
      type: eventType,
      payload: payload,
      timestamp: Date.now(),
    }, '*');
  }

  /**
   * Process incoming WebSocket message without blocking.
   * Uses setTimeout to avoid interfering with Instagram's message handling.
   */
  function processMessageAsync(ws, data) {
    // Process in next tick to not block original handler
    setTimeout(() => {
      try {
        const parsed = parseInstagramMessage(data);

        // Debug: Log what we're parsing
        if (data instanceof ArrayBuffer) {
          const textDecoder = new TextDecoder('utf-8');
          const text = textDecoder.decode(data);
          // Only log if it might contain message data
          if (text.includes('message') || text.includes('direct') || text.includes('thread') || text.includes('inbox')) {
            console.log('[DialogBrain] WS data contains potential DM content, parsed:', parsed?.type || 'null');
            // Debug: Show more details if parsing failed
            if (!parsed || parsed.type === 'mqtt_raw' || parsed.type === 'text_raw') {
              console.log('[DialogBrain] Raw WS data sample (first 300 chars):', text.substring(0, 300));
            }
          }
        }

        const dmEvent = extractDmEvent(parsed);

        if (dmEvent) {
          console.log('[DialogBrain] DM event captured:', dmEvent.type);
          notifyContentScript('DIALOGBRAIN_IG_MESSAGE', dmEvent);
        }
      } catch (e) {
        // Silently ignore processing errors to not affect Instagram
      }
    }, 0);
  }

  /**
   * Create a proxied WebSocket that intercepts messages.
   * IMPORTANT: We use a non-blocking approach to avoid interfering with Instagram.
   */
  function createProxiedWebSocket(url, protocols) {
    const ws = protocols
      ? new OriginalWebSocket(url, protocols)
      : new OriginalWebSocket(url);

    const isRealtimeConnection = isInstagramRealtimeUrl(url);

    if (isRealtimeConnection) {
      console.log('[DialogBrain] Intercepting Instagram realtime connection:', url.substring(0, 50) + '...');
      interceptedConnections.add(ws);

      // Notify content script of connection
      notifyContentScript('DIALOGBRAIN_IG_WS_CONNECTED', {
        url: url.substring(0, 100),
        timestamp: Date.now(),
      });

      // Use a non-invasive message listener that doesn't interfere with Instagram
      // We add our own listener separately instead of wrapping their handler
      ws.addEventListener('message', function(event) {
        try {
          let data = event.data;

          // Handle Blob - read asynchronously without blocking
          if (data instanceof Blob) {
            data.arrayBuffer().then(buffer => {
              processMessageAsync(ws, buffer);
            }).catch(() => {
              // Ignore blob read errors
            });
          } else {
            processMessageAsync(ws, data);
          }
        } catch (e) {
          // Silently ignore to not affect Instagram
        }
      });

      // Track connection open
      ws.addEventListener('open', function(event) {
        console.log('[DialogBrain] Instagram realtime connection opened');
        notifyContentScript('DIALOGBRAIN_IG_WS_CONNECTED', {
          url: url.substring(0, 100),
          readyState: ws.readyState,
          timestamp: Date.now(),
        });
      });

      // Track connection close
      ws.addEventListener('close', function(event) {
        interceptedConnections.delete(ws);
        console.log('[DialogBrain] Instagram realtime connection closed:', event.code, event.reason || '(no reason)');
        notifyContentScript('DIALOGBRAIN_IG_WS_DISCONNECTED', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          timestamp: Date.now(),
        });
      });

      // Track connection errors
      ws.addEventListener('error', function(event) {
        console.warn('[DialogBrain] Instagram realtime connection error');
        notifyContentScript('DIALOGBRAIN_IG_WS_ERROR', {
          timestamp: Date.now(),
        });
      });
    }

    return ws;
  }

  // Create WebSocket proxy
  window.WebSocket = new Proxy(OriginalWebSocket, {
    construct(target, args) {
      const [url, protocols] = args;
      return createProxiedWebSocket(url, protocols);
    },
    get(target, prop) {
      // Pass through static properties like OPEN, CLOSED, CONNECTING, prototype, etc.
      return target[prop];
    },
    // Make instanceof work correctly
    getPrototypeOf(target) {
      return OriginalWebSocket.prototype;
    },
  });

  // Note: We don't need to assign prototype - the Proxy's get handler passes it through

  // Expose connection status to content script
  window.__dialogbrain_getWsStatus = function() {
    return {
      interceptorInstalled: true,
      activeConnections: interceptedConnections.size,
    };
  };

  console.log('[DialogBrain] WebSocket interceptor installed successfully');

  // Notify content script that interceptor is ready
  notifyContentScript('DIALOGBRAIN_IG_INTERCEPTOR_READY', {
    timestamp: Date.now(),
  });

})();
