// ============================================
// script.js - FIXED: Pair Code Priority
// ============================================

// DOM Elements
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
const qrCodeTab = document.getElementById('qr-code-tab');
const pairCodeTab = document.getElementById('pair-code-tab');
const qrCodeContent = document.getElementById('qr-code-content');
const pairCodeContent = document.getElementById('pair-code-content');
const connectButton = document.getElementById('connect-button');
const closeModalButton = document.getElementById('close-modal-button');
const phoneInput = document.getElementById('phone-number-input');
const phoneInputContainer = document.getElementById('phone-input-container');

// State
let activeAccount = null;
const accountsData = new Map();
let currentPollingInterval = null;
let pendingSessionId = null;

// ============================================
// PAIR CODE TAB - DEFAULT ACTIVE
// ============================================

function showPairCodeSection() {
    // Update tabs
    pairCodeTab.classList.add('tab-active', 'bg-green-600');
    qrCodeTab.classList.remove('tab-active', 'bg-green-600');
    
    // Show pair code content
    pairCodeContainer.classList.remove('hidden');
    qrCodeContainer.classList.add('hidden');
    
    // Show phone input
    if (phoneInputContainer) {
        phoneInputContainer.classList.remove('hidden');
    }
    
    // Update button
    connectButton.textContent = 'Get Pair Code';
    connectButton.dataset.method = 'pair';
}

function showQrCodeSection() {
    qrCodeTab.classList.add('tab-active', 'bg-green-600');
    pairCodeTab.classList.remove('tab-active', 'bg-green-600');
    
    qrCodeContainer.classList.remove('hidden');
    pairCodeContainer.classList.add('hidden');
    
    if (phoneInputContainer) {
        phoneInputContainer.classList.add('hidden');
    }
    
    connectButton.textContent = 'Connect with QR Code';
    connectButton.dataset.method = 'qr';
}

// ============================================
// CONNECT BUTTON HANDLER
// ============================================

if (connectButton) {
    connectButton.addEventListener('click', async () => {
        const method = connectButton.dataset.method;
        
        if (method === 'pair') {
            // PAIR CODE FLOW
            const phoneNumber = document.getElementById('phone-number-input')?.value?.trim();
            
            if (!phoneNumber) {
                alert('Please enter your phone number with country code\nExample: 8801712345678');
                return;
            }
            
            connectButton.textContent = 'Generating Pair Code...';
            connectButton.disabled = true;
            
            try {
                const response = await fetch('/api/connect/pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber: phoneNumber })
                });
                
                const data = await response.json();
                console.log('Pair response:', data);
                
                if (data.success && data.pairCode) {
                    // Show pair code
                    displayPairCode(data.pairCode);
                    pendingSessionId = data.sessionId;
                    startPolling(data.sessionId, 'pair');
                } else if (data.status === 'qr_fallback') {
                    // Fallback to QR
                    showQrCodeSection();
                    qrCodeContent.innerHTML = '<div class="text-center"><div class="spinner"></div><p class="mt-2">Generating QR code...</p></div>';
                    pendingSessionId = data.sessionId;
                    startPolling(data.sessionId, 'qr');
                } else {
                    throw new Error(data.message || 'Failed');
                }
                
            } catch (error) {
                alert('Error: ' + error.message);
                connectButton.textContent = 'Get Pair Code';
                connectButton.disabled = false;
            }
            
        } else if (method === 'qr') {
            // QR CODE FLOW
            connectButton.textContent = 'Generating QR...';
            connectButton.disabled = true;
            
            try {
                const response = await fetch('/api/connect/qr', { method: 'POST' });
                const data = await response.json();
                
                if (data.qr) {
                    displayQRCode(data.qr);
                    pendingSessionId = data.sessionId;
                    startPolling(data.sessionId, 'qr');
                } else {
                    qrCodeContent.innerHTML = '<div class="text-center"><div class="spinner"></div><p>Waiting for QR code...</p></div>';
                    pendingSessionId = data.sessionId;
                    startPolling(data.sessionId, 'qr');
                }
                
            } catch (error) {
                alert('Error: ' + error.message);
                connectButton.textContent = 'Connect with QR Code';
                connectButton.disabled = false;
            }
        }
    });
}

// ============================================
// DISPLAY FUNCTIONS
// ============================================

function displayPairCode(code) {
    pairCodeContent.innerHTML = `
        <div class="text-center p-4">
            <div class="bg-gray-700 rounded-lg p-6 mb-4">
                <p class="text-gray-400 text-sm mb-2">Your Pair Code:</p>
                <p class="text-5xl font-mono font-bold text-green-400 tracking-widest">${code}</p>
            </div>
            <div class="bg-gray-700 rounded-lg p-4 text-left">
                <p class="text-sm font-semibold text-green-400 mb-2">📱 How to connect:</p>
                <ol class="text-sm text-gray-300 space-y-2 list-decimal list-inside">
                    <li>Open WhatsApp on your phone</li>
                    <li>Tap <b>⋮</b> or <b>Settings</b></li>
                    <li>Select <b>Linked Devices</b></li>
                    <li>Tap <b>Link a Device</b></li>
                    <li>Enter this code: <b class="text-green-400">${code}</b></li>
                </ol>
            </div>
            <div class="mt-4">
                <span class="inline-block w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></span>
                <span class="text-sm text-yellow-500 ml-2">Waiting for you to enter code...</span>
            </div>
        </div>
    `;
    connectButton.textContent = 'Waiting for connection...';
}

function displayQRCode(qrBase64) {
    qrCodeContent.innerHTML = `
        <div class="text-center">
            <img src="data:image/png;base64,${qrBase64}" 
                 alt="QR Code" 
                 style="width: 256px; height: 256px; border: 3px solid #25D366; border-radius: 12px; padding: 10px; background: white;">
            <p class="text-sm text-gray-400 mt-3">Scan with WhatsApp</p>
            <p class="text-xs text-gray-500 mt-1">Settings → Linked Devices → Link a Device</p>
        </div>
    `;
    connectButton.textContent = 'Scan QR Code';
}

// ============================================
// POLLING FUNCTION
// ============================================

function startPolling(sessionId, method) {
    stopPolling();
    
    currentPollingInterval = setInterval(async () => {
        try {
            const response = await fetch(`/api/connection-status/${sessionId}`);
            const data = await response.json();
            
            console.log('Status:', data.status);
            
            if (data.status === 'connected') {
                stopPolling();
                handleConnected(data);
            } else if (data.status === 'disconnected' || data.status === 'not_found') {
                stopPolling();
                alert('Connection failed or disconnected');
                connectButton.textContent = method === 'pair' ? 'Get Pair Code' : 'Connect with QR Code';
                connectButton.disabled = false;
            } else if (data.status === 'qr_ready' && data.qr && method === 'qr') {
                displayQRCode(data.qr);
            }
            
        } catch (error) {
            console.error('Polling error:', error);
        }
    }, 3000);
}

function stopPolling() {
    if (currentPollingInterval) {
        clearInterval(currentPollingInterval);
        currentPollingInterval = null;
    }
}

function handleConnected(data) {
    const account = {
        id: data.id,
        phone: data.phone || 'Connected',
        status: 'connected'
    };
    
    accountsData.set(data.id, account);
    closeAddAccountModal();
    displayAccountDetails(data.id);
    alert('✅ Connected successfully!');
}

// ============================================
// MODAL HANDLERS
// ============================================

function openAddAccountModal() {
    stopPolling();
    addAccountModal.classList.remove('hidden');
    showPairCodeSection(); // Default to pair code
    connectButton.disabled = false;
    pairCodeContent.innerHTML = '<p class="text-gray-400 text-center p-4">Enter phone number and click "Get Pair Code"</p>';
    qrCodeContent.innerHTML = '<p class="text-gray-400 text-center p-4">Click "Connect with QR Code" to generate</p>';
}

function closeAddAccountModal() {
    addAccountModal.classList.add('hidden');
    stopPolling();
}

// ============================================
// EVENT LISTENERS
// ============================================

if (pairCodeTab) pairCodeTab.addEventListener('click', showPairCodeSection);
if (qrCodeTab) qrCodeTab.addEventListener('click', showQrCodeSection);
if (closeModalButton) closeModalButton.addEventListener('click', closeAddAccountModal);

// Add Account buttons
document.querySelectorAll('[id*="add-account"]').forEach(btn => {
    btn.addEventListener('click', openAddAccountModal);
});

// Welcome button
document.getElementById('welcome-add-account')?.addEventListener('click', openAddAccountModal);

// Close modal on backdrop click
addAccountModal?.addEventListener('click', (e) => {
    if (e.target === addAccountModal) closeAddAccountModal();
});

// Initial load
fetchAccounts();

async function fetchAccounts() {
    try {
        const response = await fetch('/api/accounts');
        const accounts = await response.json();
        
        accountsData.clear();
        accounts.forEach(acc => accountsData.set(acc.id, acc));
        
        if (accounts.length > 0) {
            displayAccountDetails(accounts[0].id);
        } else {
            welcomeSection?.classList.remove('hidden');
            accountDetailsSection?.classList.add('hidden');
        }
        
        renderAccountsList();
    } catch (error) {
        console.error('Fetch accounts error:', error);
    }
}

// More functions... (keep your existing displayAccountDetails, renderAccountsList, etc.)

// Initialize
console.log('✅ WhatsApp Manager Ready - Pair Code Priority Mode');
