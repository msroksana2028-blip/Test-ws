// ============================================
// script.js - WhatsApp Multi-Account Manager
// COMPLETE VERSION WITH ALL LOGIC
// ============================================

// --- DOM Elements ---
const accountsList = document.getElementById('accounts-list');
const mainContent = document.getElementById('main-content');
const addAccountModal = document.getElementById('add-account-modal');
const qrCodeContainer = document.getElementById('qr-code-container');
const pairCodeContainer = document.getElementById('pair-code-container');
const messageForm = document.getElementById('message-form');
const messageLog = document.getElementById('message-log');
const accountDetailsSection = document.getElementById('account-details-section');
const welcomeSection = document.getElementById('welcome-section');
const accountStatusElement = document.getElementById('account-status');
const accountPhoneElement = document.getElementById('account-phone');
const disconnectButton = document.getElementById('disconnect-button');
const refreshQrButton = document.getElementById('refresh-qr-button');
const qrCodeTab = document.getElementById('qr-code-tab');
const pairCodeTab = document.getElementById('pair-code-tab');
const qrCodeContent = document.getElementById('qr-code-content');
const pairCodeContent = document.getElementById('pair-code-content');
const connectButton = document.getElementById('connect-button');
const closeModalButton = document.getElementById('close-modal-button');
const addAccountButtonHeader = document.getElementById('add-account-button-header');
const addAccountButtonSidebar = document.getElementById('add-account-button-sidebar');

// --- State Management ---
let activeAccount = null;                    // Currently selected account ID
const accountsData = new Map();              // Stores all account data: Map<id, accountObject>
let currentPollingInterval = null;           // Reference to active polling interval
let pendingSessionId = null;                 // Session ID for connection in progress
let pendingMethod = null;                    // Connection method ('qr' or 'pair')

// ============================================
// SECTION 1: ACCOUNT MANAGEMENT FUNCTIONS
// ============================================

/**
 * Updates the entire UI to show details for a specific account
 * @param {string} accountId - The ID of the account to display
 */
function displayAccountDetails(accountId) {
    // Validate account exists
    if (!accountsData.has(accountId)) {
        console.error("Account not found:", accountId);
        return;
    }

    // Update active account state
    activeAccount = accountId;
    const account = accountsData.get(accountId);

    // Show account details, hide welcome screen
    accountDetailsSection.classList.remove('hidden');
    welcomeSection.classList.add('hidden');
    mainContent.classList.remove('hidden');

    // Update account information display
    accountPhoneElement.textContent = account.phone || 'Connecting...';
    accountStatusElement.textContent = account.status || 'connecting';
    accountStatusElement.className = `status-indicator ${account.status || 'connecting'}`;

    // Show QR code section (default view)
    showQrCodeSection();
    pairCodeContainer.classList.add('hidden');

    // Load messages for this account
    fetchMessages(accountId);

    // Update sidebar selection highlight
    renderAccountsList();
}

/**
 * Fetches messages from backend for a specific account
 * @param {string} accountId - Account to fetch messages for
 */
async function fetchMessages(accountId) {
    // Show loading state
    messageLog.innerHTML = '<p class="text-gray-400 text-center p-4">Loading messages...</p>';
    
    try {
        const response = await fetch(`/api/messages/${accountId}`);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch messages: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Clear loading placeholder
        messageLog.innerHTML = '';
        
        // Check if there are messages
        if (data.messages && data.messages.length > 0) {
            data.messages.forEach(msg => {
                addMessageToLog(msg.text, msg.direction, msg.timestamp);
            });
        } else {
            messageLog.innerHTML = '<p class="text-gray-500 text-center p-4">No messages yet</p>';
        }
        
    } catch (error) {
        console.error('Error fetching messages:', error);
        messageLog.innerHTML = '<p class="text-red-400 text-center p-4">Failed to load messages</p>';
    }
}

/**
 * Adds a single message to the chat log UI
 * @param {string} message - Message text content
 * @param {string} type - 'sent' or 'received'
 * @param {string} timestamp - Optional timestamp string
 */
function addMessageToLog(message, type = 'sent', timestamp = null) {
    const messageElement = document.createElement('div');
    
    // Set alignment and color based on message type
    const alignment = type === 'sent' ? 'ml-auto bg-green-500' : 'mr-auto bg-gray-700';
    messageElement.className = `message ${type} mb-3 p-3 rounded-lg max-w-xs break-words ${alignment}`;
    
    // Create message content with optional timestamp
    messageElement.innerHTML = `
        <p class="text-sm">${escapeHtml(message)}</p>
        ${timestamp ? `<span class="text-xs opacity-75 block mt-1">${formatTimestamp(timestamp)}</span>` : ''}
    `;
    
    messageLog.appendChild(messageElement);
    messageLog.scrollTop = messageLog.scrollHeight; // Auto-scroll to bottom
}

/**
 * Renders the sidebar list of all connected accounts
 */
function renderAccountsList() {
    // Clear existing list
    accountsList.innerHTML = '';
    
    // Check if there are any accounts
    if (accountsData.size === 0) {
        accountsList.innerHTML = '<p class="text-gray-500 text-center p-4">No accounts connected</p>';
        return;
    }
    
    // Create list item for each account
    accountsData.forEach((account, id) => {
        const accountItem = document.createElement('div');
        
        // Highlight active account
        const isActive = id === activeAccount;
        accountItem.className = `account-item p-3 mb-2 rounded cursor-pointer flex items-center justify-between transition-colors duration-200 ${
            isActive ? 'bg-green-600 text-white' : 'hover:bg-gray-700 text-gray-300'
        }`;
        accountItem.dataset.accountId = id;
        
        // Account item content
        accountItem.innerHTML = `
            <div class="flex items-center">
                <i class="fas fa-user-circle mr-2 text-lg"></i>
                <span class="truncate">${escapeHtml(account.phone || 'Connecting...')}</span>
            </div>
            <span class="status-indicator status-${account.status || 'connecting'}" 
                  title="${account.status || 'connecting'}"></span>
        `;
        
        // Click handler to switch accounts
        accountItem.addEventListener('click', () => {
            displayAccountDetails(id);
        });
        
        accountsList.appendChild(accountItem);
    });
}

// ============================================
// SECTION 2: MODAL & TAB MANAGEMENT
// ============================================

/**
 * Switches modal to show QR code method
 */
function showQrCodeSection() {
    // Update tab styling
    qrCodeTab.classList.add('tab-active', 'bg-green-600', 'text-white');
    qrCodeTab.classList.remove('bg-gray-200', 'text-gray-700');
    pairCodeTab.classList.add('bg-gray-200', 'text-gray-700');
    pairCodeTab.classList.remove('tab-active', 'bg-green-600', 'text-white');
    
    // Show/hide content sections
    qrCodeContent.classList.remove('hidden');
    pairCodeContent.classList.add('hidden');
    qrCodeContainer.classList.remove('hidden');
    pairCodeContainer.classList.add('hidden');
    
    // Update connect button
    connectButton.textContent = "Connect with QR Code";
    connectButton.dataset.method = "qr";
}

/**
 * Switches modal to show pair code method
 */
function showPairCodeSection() {
    // Update tab styling
    pairCodeTab.classList.add('tab-active', 'bg-green-600', 'text-white');
    pairCodeTab.classList.remove('bg-gray-200', 'text-gray-700');
    qrCodeTab.classList.add('bg-gray-200', 'text-gray-700');
    qrCodeTab.classList.remove('tab-active', 'bg-green-600', 'text-white');
    
    // Show/hide content sections
    pairCodeContent.classList.remove('hidden');
    qrCodeContent.classList.add('hidden');
    pairCodeContainer.classList.remove('hidden');
    qrCodeContainer.classList.add('hidden');
    
    // Update connect button
    connectButton.textContent = "Connect with Pair Code";
    connectButton.dataset.method = "pair";
}

/**
 * Opens the add account modal with default settings
 */
function openAddAccountModal() {
    // Stop any existing polling
    stopPolling();
    
    // Reset modal state
    addAccountModal.classList.remove('hidden');
    qrCodeContent.innerHTML = '<p class="text-gray-400 text-center p-8">Click "Connect" to generate QR code</p>';
    pairCodeContent.textContent = '';
    pairCodeContent.classList.add('hidden');
    
    // Reset button state
    connectButton.textContent = "Connect with QR Code";
    connectButton.disabled = false;
    connectButton.dataset.method = "qr";
    
    // Show QR section by default
    showQrCodeSection();
}

/**
 * Closes the add account modal
 */
function closeAddAccountModal() {
    addAccountModal.classList.add('hidden');
    stopPolling(); // Stop any active polling
}

// ============================================
// SECTION 3: CONNECTION MANAGEMENT
// ============================================

/**
 * Initiates WhatsApp connection using selected method
 */
async function initiateConnection() {
    const method = connectButton.dataset.method;
    
    // Update UI to show connecting state
    connectButton.textContent = 'Connecting...';
    connectButton.disabled = true;
    
    try {
        // Determine API endpoint based on method
        const endpoint = method === 'qr' ? '/api/connect/qr' : '/api/connect/pair';
        const response = await fetch(endpoint, { method: 'POST' });
        
        // Handle HTTP errors
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Connection failed');
        }
        
        const data = await response.json();
        
        // Store session info for polling
        pendingSessionId = data.sessionId;
        pendingMethod = method;
        
        // Display connection method specific UI
        if (method === 'qr') {
            displayQRCode(data.qr);
        } else if (method === 'pair') {
            displayPairCode(data.pairCode);
        }
        
        // Start polling for connection status
        startPolling(data.sessionId, method);
        
    } catch (error) {
        console.error('Connection error:', error);
        handleConnectionError(error.message);
    }
}

/**
 * Displays QR code in the modal
 * @param {string} qrBase64 - Base64 encoded QR code image
 */
function displayQRCode(qrBase64) {
    qrCodeContent.innerHTML = `
        <div class="text-center">
            <img src="data:image/png;base64,${qrBase64}" 
                 alt="WhatsApp QR Code" 
                 class="mx-auto w-64 h-64 border-2 border-green-500 rounded-lg">
            <p class="text-sm text-gray-400 mt-2">Scan with WhatsApp on your phone</p>
        </div>
    `;
}

/**
 * Displays pair code in the modal
 * @param {string} code - The pair code string
 */
function displayPairCode(code) {
    pairCodeContent.textContent = code;
    pairCodeContent.classList.remove('hidden');
    pairCodeContent.className = 'text-4xl font-mono font-bold text-center p-4 bg-gray-700 rounded-lg text-green-400 tracking-widest';
}

/**
 * Starts polling for connection status
 * @param {string} sessionId - Session to poll for
 * @param {string} method - Connection method used
 */
function startPolling(sessionId, method) {
    // Clear any existing polling
    stopPolling();
    
    // Start new polling interval (every 2 seconds)
    currentPollingInterval = setInterval(async () => {
        try {
            const response = await fetch(`/api/connection-status/${sessionId}`);
            
            if (!response.ok) {
                throw new Error('Status check failed');
            }
            
            const data = await response.json();
            
            // Handle different connection states
            switch (data.status) {
                case 'connected':
                    handleSuccessfulConnection(data);
                    break;
                    
                case 'error':
                case 'disconnected':
                case 'timeout':
                    handleFailedConnection(data.status);
                    break;
                    
                case 'connecting':
                case 'qr_read':
                    // Still waiting, continue polling
                    console.log(`Connection status: ${data.status}`);
                    break;
                    
                default:
                    console.log('Unknown status:', data.status);
            }
            
        } catch (error) {
            console.error('Polling error:', error);
            handleConnectionError('Lost connection to server');
        }
    }, 2000); // Poll every 2 seconds
}

/**
 * Stops the active polling interval
 */
function stopPolling() {
    if (currentPollingInterval) {
        clearInterval(currentPollingInterval);
        currentPollingInterval = null;
    }
}

/**
 * Handles successful WhatsApp connection
 * @param {object} data - Connection response data
 */
function handleSuccessfulConnection(data) {
    // Stop polling
    stopPolling();
    
    // Update local state with new account
    const newAccount = {
        id: data.id,
        phone: data.phone,
        status: 'connected',
        name: data.name || data.phone
    };
    accountsData.set(data.id, newAccount);
    
    // Close modal
    closeAddAccountModal();
    
    // Switch to new account
    displayAccountDetails(data.id);
    
    // Show success notification
    showNotification('Account connected successfully!', 'success');
    
    // Reset connect button (for next use)
    connectButton.textContent = "Connect with QR Code";
    connectButton.disabled = false;
}

/**
 * Handles failed connection attempt
 * @param {string} status - Failure status
 */
function handleFailedConnection(status) {
    stopPolling();
    
    // Update UI to show failure
    qrCodeContent.innerHTML = `
        <div class="text-center text-red-400 p-8">
            <i class="fas fa-exclamation-circle text-4xl mb-2"></i>
            <p>Connection ${status}</p>
            <button onclick="openAddAccountModal()" 
                    class="mt-4 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700">
                Try Again
            </button>
        </div>
    `;
    pairCodeContent.textContent = 'Connection failed';
    
    // Reset button
    connectButton.textContent = "Connect with QR Code";
    connectButton.disabled = false;
    
    showNotification(`Connection failed: ${status}`, 'error');
}

/**
 * Handles connection errors
 * @param {string} message - Error message
 */
function handleConnectionError(message) {
    stopPolling();
    
    // Update UI
    qrCodeContent.innerHTML = `
        <div class="text-center text-red-400 p-8">
            <i class="fas fa-times-circle text-4xl mb-2"></i>
            <p>Error: ${escapeHtml(message)}</p>
        </div>
    `;
    
    // Reset button
    connectButton.textContent = "Connect with QR Code";
    connectButton.disabled = false;
    
    showNotification(message, 'error');
}

// ============================================
// SECTION 4: MESSAGING FUNCTIONALITY
// ============================================

/**
 * Handles sending a WhatsApp message
 * @param {Event} e - Form submit event
 */
async function handleSendMessage(e) {
    e.preventDefault();
    
    // Validate active account
    if (!activeAccount) {
        showNotification('Please select an account first', 'warning');
        return;
    }
    
    // Get form values
    const recipientInput = document.getElementById('recipient-number');
    const messageInput = document.getElementById('message-text');
    const recipient = recipientInput.value.trim();
    const message = messageInput.value.trim();
    
    // Validate inputs
    if (!recipient || !message) {
        showNotification('Please enter recipient number and message', 'warning');
        return;
    }
    
    // Format recipient number
    const formattedRecipient = formatPhoneNumber(recipient);
    
    // Disable send button while processing
    const sendButton = messageForm.querySelector('button[type="submit"]');
    const originalButtonText = sendButton.textContent;
    sendButton.textContent = 'Sending...';
    sendButton.disabled = true;
    
    try {
        const response = await fetch('/api/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: activeAccount,
                to: formattedRecipient,
                text: message,
            }),
        });
        
        const data = await response.json();
        
        if (response.ok) {
            // Add message to chat log
            addMessageToLog(message, 'sent', new Date().toISOString());
            
            // Clear message input
            messageInput.value = '';
            
            // Show success
            showNotification('Message sent successfully!', 'success');
        } else {
            throw new Error(data.message || 'Failed to send message');
        }
        
    } catch (error) {
        console.error('Send message error:', error);
        showNotification(`Failed to send: ${error.message}`, 'error');
    } finally {
        // Restore button state
        sendButton.textContent = originalButtonText;
        sendButton.disabled = false;
    }
}

/**
 * Formats a phone number for WhatsApp API
 * @param {string} input - Raw phone number input
 * @returns {string} Formatted number (e.g., "1234567890@s.whatsapp.net")
 */
function formatPhoneNumber(input) {
    // Remove all non-numeric characters
    let cleaned = input.replace(/\D/g, '');
    
    // Handle country code (assume 1 for US if not specified)
    if (cleaned.length <= 10) {
        cleaned = '1' + cleaned; // Add US country code
    }
    
    return `${cleaned}@s.whatsapp.net`;
}

// ============================================
// SECTION 5: DISCONNECT & ACCOUNT REMOVAL
// ============================================

/**
 * Disconnects the currently active WhatsApp account
 */
async function disconnectAccount() {
    // Validate active account
    if (!activeAccount) {
        showNotification('No account selected', 'warning');
        return;
    }
    
    const accountPhone = accountsData.get(activeAccount)?.phone || activeAccount;
    
    // Confirm disconnect
    const confirmed = confirm(`Are you sure you want to disconnect ${accountPhone}?\nThis will remove the account from this dashboard.`);
    
    if (!confirmed) return;
    
    try {
        const response = await fetch(`/api/disconnect/${activeAccount}`, {
            method: 'POST'
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Disconnect failed');
        }
        
        // Remove account from local state
        accountsData.delete(activeAccount);
        
        // Reset active account
        activeAccount = null;
        
        // Update UI
        accountDetailsSection.classList.add('hidden');
        welcomeSection.classList.remove('hidden');
        
        // Refresh account list
        renderAccountsList();
        
        showNotification('Account disconnected successfully', 'success');
        
    } catch (error) {
        console.error('Disconnect error:', error);
        showNotification(`Failed to disconnect: ${error.message}`, 'error');
    }
}

// ============================================
// SECTION 6: BACKEND DATA FETCHING
// ============================================

/**
 * Fetches all connected accounts from backend
 */
async function fetchAccounts() {
    try {
        const response = await fetch('/api/accounts');
        
        if (!response.ok) {
            throw new Error(`Failed to fetch accounts: ${response.status}`);
        }
        
        const accounts = await response.json();
        
        // Update local state
        accountsData.clear();
        
        if (accounts && accounts.length > 0) {
            accounts.forEach(account => {
                accountsData.set(account.id, {
                    id: account.id,
                    phone: account.phone,
                    name: account.name || account.phone,
                    status: account.status || 'connected'
                });
            });
            
            // Select first account if none active, or refresh current
            if (!activeAccount || !accountsData.has(activeAccount)) {
                displayAccountDetails(accounts[0].id);
            } else {
                displayAccountDetails(activeAccount);
            }
        } else {
            // No accounts, show welcome
            activeAccount = null;
            accountDetailsSection.classList.add('hidden');
            welcomeSection.classList.remove('hidden');
        }
        
        renderAccountsList();
        
    } catch (error) {
        console.error('Error fetching accounts:', error);
        showNotification('Failed to load accounts', 'error');
    }
}

// ============================================
// SECTION 7: UTILITY FUNCTIONS
// ============================================

/**
 * Escapes HTML to prevent XSS
 * @param {string} unsafe - Unsafe string
 * @returns {string} Escaped HTML string
 */
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Formats timestamp for display
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Formatted time string
 */
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    // If today, show time only
    if (diff < 86400000 && date.getDate() === now.getDate()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // If this week, show day and time
    if (diff < 604800000) {
        return date.toLocaleDateString([], { weekday: 'short' }) + ' ' + 
               date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // Otherwise show full date
    return date.toLocaleDateString();
}

/**
 * Shows a notification message
 * @param {string} message - Notification text
 * @param {string} type - 'success', 'error', 'warning', 'info'
 */
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    const colors = {
        success: 'bg-green-500',
        error: 'bg-red-500',
        warning: 'bg-yellow-500',
        info: 'bg-blue-500'
    };
    
    notification.className = `fixed top-4 right-4 ${colors[type]} text-white px-6 py-3 rounded-lg shadow-lg z-50 
                              transition-opacity duration-300 opacity-0`;
    notification.innerHTML = `
        <div class="flex items-center">
            <i class="fas fa-${type === 'success' ? 'check-circle' : 
                           type === 'error' ? 'exclamation-circle' : 
                           type === 'warning' ? 'exclamation-triangle' : 'info-circle'} mr-2"></i>
            <span>${escapeHtml(message)}</span>
        </div>
    `;
    
    document.body.appendChild(notification);
    
    // Fade in
    setTimeout(() => {
        notification.classList.remove('opacity-0');
    }, 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.classList.add('opacity-0');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// ============================================
// SECTION 8: EVENT LISTENERS SETUP
// ============================================

function setupEventListeners() {
    // Add Account buttons
    if (addAccountButtonHeader) {
        addAccountButtonHeader.addEventListener('click', openAddAccountModal);
    }
    
    if (addAccountButtonSidebar) {
        addAccountButtonSidebar.addEventListener('click', openAddAccountModal);
    }
    
    // Close modal button
    if (closeModalButton) {
        closeModalButton.addEventListener('click', closeAddAccountModal);
    }
    
    // Close modal on backdrop click
    addAccountModal.addEventListener('click', (e) => {
        if (e.target === addAccountModal) {
            closeAddAccountModal();
        }
    });
    
    // Tab switching
    if (qrCodeTab) {
        qrCodeTab.addEventListener('click', showQrCodeSection);
    }
    
    if (pairCodeTab) {
        pairCodeTab.addEventListener('click', showPairCodeSection);
    }
    
    // Connect button
    if (connectButton) {
        connectButton.addEventListener('click', initiateConnection);
    }
    
    // Refresh QR button
    if (refreshQrButton) {
        refreshQrButton.addEventListener('click', () => {
            if (pendingSessionId && pendingMethod) {
                initiateConnection(); // Re-initiate connection
            }
        });
    }
    
    // Message form submission
    if (messageForm) {
        messageForm.addEventListener('submit', handleSendMessage);
    }
    
    // Disconnect button
    if (disconnectButton) {
        disconnectButton.addEventListener('click', disconnectAccount);
    }
    
    // Keyboard shortcut to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !addAccountModal.classList.contains('hidden')) {
            closeAddAccountModal();
        }
    });
}

// ============================================
// SECTION 9: INITIALIZATION
// ============================================

/**
 * Initializes the application
 */
function initializeApp() {
    console.log('WhatsApp Manager initializing...');
    
    // Set up all event listeners
    setupEventListeners();
    
    // Load initial data
    fetchAccounts();
    
    // Set up auto-refresh (every 30 seconds)
    setInterval(() => {
        if (activeAccount) {
            fetchMessages(activeAccount);
        }
    }, 30000);
    
    console.log('WhatsApp Manager initialized successfully');
}

// Start the application when DOM is ready
document.addEventListener('DOMContentLoaded', initializeApp);

// ============================================
// EXPORT FOR TESTING (if needed)
// ============================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        displayAccountDetails,
        renderAccountsList,
        fetchMessages,
        addMessageToLog,
        showQrCodeSection,
        showPairCodeSection,
        initiateConnection,
        handleSendMessage,
        disconnectAccount,
        fetchAccounts
    };
}
