/**
 * DialogBrain Cookie Sync - Popup Script
 *
 * SECURITY: NEVER display or log cookie values in the popup.
 * Only show status information.
 */

// DOM elements
const loginSection = document.getElementById('login-section');
const mainSection = document.getElementById('main-section');
const instagramStatus = document.getElementById('instagram-status');
const instagramInfo = document.getElementById('instagram-info');
const instagramSyncBtn = document.getElementById('instagram-sync-btn');
const linkedinStatus = document.getElementById('linkedin-status');
const linkedinInfo = document.getElementById('linkedin-info');
const linkedinSyncBtn = document.getElementById('linkedin-sync-btn');
const logoutBtn = document.getElementById('logout-btn');

// =============================================================================
// Status Display
// =============================================================================

function formatLastSync(dateStr) {
  if (!dateStr) return 'Never';

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;

  return date.toLocaleDateString();
}

function updatePlatformStatus(platform, status, cookies) {
  const statusEl = platform === 'instagram' ? instagramStatus : linkedinStatus;
  const infoEl = platform === 'instagram' ? instagramInfo : linkedinInfo;
  const syncBtn = platform === 'instagram' ? instagramSyncBtn : linkedinSyncBtn;

  // Update status badge
  statusEl.className = 'status-badge';

  if (status.syncing) {
    statusEl.classList.add('status-syncing');
    statusEl.textContent = 'Syncing...';
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
  } else if (status.error === 'Not logged in' || status.error?.includes('Not logged in')) {
    statusEl.classList.add('status-not-logged-in');
    statusEl.textContent = 'Not logged in';
    syncBtn.disabled = true;
    syncBtn.textContent = 'Login Required';
  } else if (!cookies?.hasSession) {
    statusEl.classList.add('status-not-logged-in');
    statusEl.textContent = 'No session';
    syncBtn.disabled = true;
    syncBtn.textContent = `Login to ${platform === 'instagram' ? 'Instagram' : 'LinkedIn'}`;
  } else if (status.status === 'connected' || status.lastSync) {
    statusEl.classList.add('status-connected');
    statusEl.textContent = 'Connected';
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync Now';
  } else if (status.error) {
    statusEl.classList.add('status-disconnected');
    statusEl.textContent = 'Error';
    syncBtn.disabled = false;
    syncBtn.textContent = 'Retry Sync';
  } else {
    statusEl.classList.add('status-not-logged-in');
    statusEl.textContent = 'Not synced';
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync Now';
  }

  // Update info text
  if (status.error && status.error !== 'Not logged in') {
    infoEl.textContent = `Error: ${status.error}`;
  } else if (status.lastSync) {
    infoEl.textContent = `Last sync: ${formatLastSync(status.lastSync)}`;
  } else {
    infoEl.textContent = 'Not synced yet';
  }
}

// =============================================================================
// Initialization
// =============================================================================

async function init() {
  // Check if user is logged in
  const storage = await chrome.storage.local.get(['auth_token']);

  if (!storage.auth_token) {
    // Show login section
    loginSection.style.display = 'block';
    mainSection.style.display = 'none';
    return;
  }

  // Show main section
  loginSection.style.display = 'none';
  mainSection.style.display = 'block';

  // Get current status from background
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (chrome.runtime.lastError) {
      console.error('Failed to get status:', chrome.runtime.lastError);
      return;
    }

    // Check cookie presence
    chrome.runtime.sendMessage({ type: 'CHECK_COOKIES' }, (cookies) => {
      if (chrome.runtime.lastError) {
        console.error('Failed to check cookies:', chrome.runtime.lastError);
        return;
      }

      updatePlatformStatus('instagram', status.instagram || {}, cookies.instagram);
      updatePlatformStatus('linkedin', status.linkedin || {}, cookies.linkedin);
    });
  });
}

// =============================================================================
// Event Handlers
// =============================================================================

instagramSyncBtn.addEventListener('click', () => {
  instagramSyncBtn.disabled = true;
  instagramSyncBtn.textContent = 'Syncing...';
  instagramStatus.className = 'status-badge status-syncing';
  instagramStatus.textContent = 'Syncing...';

  chrome.runtime.sendMessage({ type: 'MANUAL_SYNC', platform: 'instagram' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Sync failed:', chrome.runtime.lastError);
      instagramStatus.className = 'status-badge status-disconnected';
      instagramStatus.textContent = 'Error';
      instagramSyncBtn.disabled = false;
      instagramSyncBtn.textContent = 'Retry Sync';
      return;
    }

    // Re-check cookies and update display
    chrome.runtime.sendMessage({ type: 'CHECK_COOKIES' }, (cookies) => {
      updatePlatformStatus('instagram', response.status || {}, cookies?.instagram);
    });
  });
});

linkedinSyncBtn.addEventListener('click', () => {
  linkedinSyncBtn.disabled = true;
  linkedinSyncBtn.textContent = 'Syncing...';
  linkedinStatus.className = 'status-badge status-syncing';
  linkedinStatus.textContent = 'Syncing...';

  chrome.runtime.sendMessage({ type: 'MANUAL_SYNC', platform: 'linkedin' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Sync failed:', chrome.runtime.lastError);
      linkedinStatus.className = 'status-badge status-disconnected';
      linkedinStatus.textContent = 'Error';
      linkedinSyncBtn.disabled = false;
      linkedinSyncBtn.textContent = 'Retry Sync';
      return;
    }

    // Re-check cookies and update display
    chrome.runtime.sendMessage({ type: 'CHECK_COOKIES' }, (cookies) => {
      updatePlatformStatus('linkedin', response.status || {}, cookies?.linkedin);
    });
  });
});

logoutBtn.addEventListener('click', () => {
  if (!confirm('Disconnect your DialogBrain account from this extension?')) {
    return;
  }

  chrome.runtime.sendMessage({ type: 'LOGOUT' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('Logout failed:', chrome.runtime.lastError);
      return;
    }

    // Show login section
    loginSection.style.display = 'block';
    mainSection.style.display = 'none';
  });
});

// =============================================================================
// Listen for auth token from web app
// =============================================================================

// The web app can send auth token via postMessage or URL params
// This allows seamless login flow from dialogbrain.com

window.addEventListener('message', (event) => {
  // Only accept messages from DialogBrain
  if (!event.origin.includes('dialogbrain.com') && !event.origin.includes('localhost')) {
    return;
  }

  if (event.data.type === 'DIALOGBRAIN_AUTH_TOKEN') {
    chrome.runtime.sendMessage({ type: 'SET_AUTH_TOKEN', token: event.data.token }, () => {
      init(); // Refresh UI
    });
  }
});

// Check for auth token in URL (for redirect-based login)
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');
if (tokenFromUrl) {
  chrome.runtime.sendMessage({ type: 'SET_AUTH_TOKEN', token: tokenFromUrl }, () => {
    // Clear URL params
    window.history.replaceState({}, '', window.location.pathname);
    init();
  });
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
