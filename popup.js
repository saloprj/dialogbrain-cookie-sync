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
const connectBtn = document.getElementById('connect-btn');
const settingsLink = document.getElementById('settings-link');
const loginForm = document.getElementById('login-form');
const loginEmail = document.getElementById('login-email');
const loginPassword = document.getElementById('login-password');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

// URLs for different environments
const PROD_URL = 'https://dialogbrain.com';
const DEV_URL = 'http://localhost:3000';
const PROD_API_URL = 'https://api.dialogbrain.com';
const DEV_API_URL = 'http://localhost:8000';

// Get API URL based on dev mode
async function getApiUrl() {
  const settings = await chrome.storage.local.get(['dev_mode']);

  // Also auto-detect if user has localhost tab open
  let hasLocalhostTab = false;
  try {
    const tabs = await chrome.tabs.query({ url: ['http://localhost:*/*', 'http://127.0.0.1:*/*'] });
    hasLocalhostTab = tabs.length > 0;
  } catch (e) {
    // tabs permission may not be available
  }

  const useDevMode = settings.dev_mode || hasLocalhostTab;
  return useDevMode ? DEV_API_URL : PROD_API_URL;
}

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
  // Check dev mode and update URLs
  // Also auto-detect if user has localhost tab open
  const settings = await chrome.storage.local.get(['dev_mode', 'auth_token']);

  // Auto-detect: check if any tab is on localhost
  let hasLocalhostTab = false;
  try {
    const tabs = await chrome.tabs.query({ url: ['http://localhost:*/*', 'http://127.0.0.1:*/*'] });
    hasLocalhostTab = tabs.length > 0;
  } catch (e) {
    // tabs permission may not be available
  }

  const useDevMode = settings.dev_mode || hasLocalhostTab;
  const baseUrl = useDevMode ? DEV_URL : PROD_URL;

  if (connectBtn) {
    connectBtn.href = baseUrl;
  }
  if (settingsLink) {
    settingsLink.href = `${baseUrl}/settings`;
  }

  if (!settings.auth_token) {
    // Show login section and reset form
    loginSection.style.display = 'block';
    mainSection.style.display = 'none';
    // Reset login form state
    if (loginForm) loginForm.reset();
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }
    if (loginError) loginError.textContent = '';
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

// Login form handler
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  if (!email || !password) {
    loginError.textContent = 'Please enter email and password';
    return;
  }

  // Disable form while logging in
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in...';
  loginError.textContent = '';

  try {
    const apiUrl = await getApiUrl();
    const response = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (!response.ok) {
      // Handle specific error codes
      if (data.detail?.error_code === 'verification_required') {
        throw new Error('Please verify your email first');
      }
      throw new Error(data.detail || data.message || 'Login failed');
    }

    // Check for 2FA required
    if (data.status === '2fa_required') {
      throw new Error('2FA login not supported in extension. Please login via web app.');
    }

    // Store tokens via background script
    const isDevMode = apiUrl.includes('localhost');
    chrome.runtime.sendMessage({
      type: 'SET_AUTH_TOKEN',
      token: data.accessToken,
      refreshToken: data.refreshToken
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to store token:', chrome.runtime.lastError);
        loginError.textContent = 'Failed to save login. Please try again.';
        loginBtn.disabled = false;
        loginBtn.textContent = 'Login';
        return;
      }

      // Store dev_mode preference
      chrome.storage.local.set({ dev_mode: isDevMode });

      // Success - refresh UI
      init();
    });

  } catch (error) {
    console.error('Login error:', error);
    loginError.textContent = error.message;
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login';
  }
});

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
