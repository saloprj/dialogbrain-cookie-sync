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

// API endpoints - use localhost for development
const CONFIG = {
  // Production API
  PROD_API_URL: 'https://api.dialogbrain.com',
  // Development API (uncomment for local testing)
  DEV_API_URL: 'http://localhost:8000',

  // Use development mode flag
  IS_DEV: false, // Set to true for local development

  // Sync settings
  DEBOUNCE_MS: 2000, // Wait 2s for cookie changes to settle
  FALLBACK_SYNC_HOURS: 6, // Periodic sync interval
};

// Get current API URL based on mode
function getApiUrl() {
  return CONFIG.IS_DEV ? CONFIG.DEV_API_URL : CONFIG.PROD_API_URL;
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

// Track sync status
let syncStatus = {
  instagram: { syncing: false, lastSync: null, error: null },
  linkedin: { syncing: false, lastSync: null, error: null },
};

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

async function syncInstagramCookies() {
  // Get auth token
  const storage = await chrome.storage.local.get(['auth_token', 'instagram_account_id']);
  const authToken = storage.auth_token;

  if (!authToken) {
    console.log('[DialogBrain] No auth token - user not logged in to extension');
    syncStatus.instagram = { syncing: false, lastSync: null, error: 'Not logged in' };
    return;
  }

  // Get cookies
  const cookies = await getInstagramCookies();

  if (!cookies.sessionid) {
    console.log('[DialogBrain] No Instagram session - user not logged in');
    syncStatus.instagram = { syncing: false, lastSync: null, error: 'Not logged in to Instagram' };
    return;
  }

  syncStatus.instagram.syncing = true;

  try {
    const apiUrl = getApiUrl();
    let endpoint;
    let method = 'POST';

    // If we have an existing account ID, use sync endpoint
    // Otherwise, use connect endpoint
    if (storage.instagram_account_id) {
      endpoint = `${apiUrl}/api/channels/instagram/accounts/${storage.instagram_account_id}/sync-cookie`;
    } else {
      endpoint = `${apiUrl}/api/channels/instagram/accounts/connect/cookie`;
    }

    const response = await fetch(endpoint, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(cookies), // NEVER log this!
    });

    if (response.ok) {
      const data = await response.json();

      // Store account ID if this was a connect
      if (data.account_id && !storage.instagram_account_id) {
        await chrome.storage.local.set({ instagram_account_id: data.account_id });
      }

      console.log('[DialogBrain] Instagram cookies synced successfully');
      syncStatus.instagram = {
        syncing: false,
        lastSync: new Date().toISOString(),
        error: null,
        status: data.status || 'connected',
      };
    } else {
      const errorText = await response.text();
      console.error(`[DialogBrain] Instagram sync failed: ${response.status}`);
      syncStatus.instagram = {
        syncing: false,
        lastSync: null,
        error: `HTTP ${response.status}`,
      };
    }
  } catch (error) {
    console.error('[DialogBrain] Instagram sync error:', error.message); // Don't log full error (may contain cookies)
    syncStatus.instagram = {
      syncing: false,
      lastSync: null,
      error: error.message,
    };
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
  // Get auth token
  const storage = await chrome.storage.local.get(['auth_token', 'linkedin_account_id']);
  const authToken = storage.auth_token;

  if (!authToken) {
    console.log('[DialogBrain] No auth token - user not logged in to extension');
    syncStatus.linkedin = { syncing: false, lastSync: null, error: 'Not logged in' };
    return;
  }

  // Get cookies
  const cookies = await getLinkedInCookies();

  if (!cookies.li_at) {
    console.log('[DialogBrain] No LinkedIn session - user not logged in');
    syncStatus.linkedin = { syncing: false, lastSync: null, error: 'Not logged in to LinkedIn' };
    return;
  }

  syncStatus.linkedin.syncing = true;

  try {
    const apiUrl = getApiUrl();
    let endpoint;

    // If we have an existing account ID, use sync endpoint
    if (storage.linkedin_account_id) {
      endpoint = `${apiUrl}/api/channels/linkedin/accounts/${storage.linkedin_account_id}/sync-cookie`;
    } else {
      endpoint = `${apiUrl}/api/channels/linkedin/accounts/connect/cookie`;
    }

    const response = await fetch(endpoint, {
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
      };
    } else {
      console.error(`[DialogBrain] LinkedIn sync failed: ${response.status}`);
      syncStatus.linkedin = {
        syncing: false,
        lastSync: null,
        error: `HTTP ${response.status}`,
      };
    }
  } catch (error) {
    console.error('[DialogBrain] LinkedIn sync error:', error.message);
    syncStatus.linkedin = {
      syncing: false,
      lastSync: null,
      error: error.message,
    };
  }
}

// =============================================================================
// Message Handlers (for popup communication)
// =============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATUS') {
    sendResponse({
      instagram: syncStatus.instagram,
      linkedin: syncStatus.linkedin,
    });
    return true;
  }

  if (message.type === 'MANUAL_SYNC') {
    if (message.platform === 'instagram') {
      syncInstagramCookies().then(() => {
        sendResponse({ success: true, status: syncStatus.instagram });
      });
    } else if (message.platform === 'linkedin') {
      syncLinkedInCookies().then(() => {
        sendResponse({ success: true, status: syncStatus.linkedin });
      });
    }
    return true; // Keep message channel open for async response
  }

  if (message.type === 'SET_AUTH_TOKEN') {
    chrome.storage.local.set({ auth_token: message.token }).then(() => {
      console.log('[DialogBrain] Auth token updated');
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'LOGOUT') {
    chrome.storage.local.remove(['auth_token', 'instagram_account_id', 'linkedin_account_id']).then(() => {
      console.log('[DialogBrain] Logged out');
      syncStatus = {
        instagram: { syncing: false, lastSync: null, error: 'Not logged in' },
        linkedin: { syncing: false, lastSync: null, error: 'Not logged in' },
      };
      sendResponse({ success: true });
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
});

// =============================================================================
// External Message Handlers (for web page communication)
// =============================================================================

// Allow the DialogBrain web app to detect if extension is installed
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Verify sender is from allowed origins
  const allowedOrigins = [
    'https://dialogbrain.com',
    'https://app.dialogbrain.com',
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
    sendResponse({
      installed: true,
      version: chrome.runtime.getManifest().version,
      instagram: syncStatus.instagram,
      linkedin: syncStatus.linkedin,
    });
    return true;
  }

  if (message.type === 'SET_AUTH_TOKEN') {
    chrome.storage.local.set({ auth_token: message.token }).then(() => {
      console.log('[DialogBrain] Auth token set from web app');
      sendResponse({ success: true });
    });
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
