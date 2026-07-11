// ============================================
// server.js - WhatsApp Multi-Account Backend
// ============================================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Baileys imports
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@adiwajshing/baileys');

const pino = require('pino');
const NodeCache = require('node-cache'); // You may need to install this

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// STATE MANAGEMENT
// ============================================

// Store active WhatsApp sessions
const sessions = new Map(); // Map<sessionId, { sock, state, creds, keys }>
const connectionStates = new Map(); // Map<sessionId, { status, phone, qr, pairCode }>
const pendingConnections = new Map(); // Map<sessionId, { method, timeout }>

// Store messages (in production, use a database)
const messageStore = new Map(); // Map<accountId, Array<messages>>

// ============================================
// BAILEYS SESSION MANAGEMENT
// ============================================

/**
 * Creates a new WhatsApp session
 * @param {string} sessionId - Unique session identifier
 * @returns {Object} Session object
 */
async function createSession(sessionId) {
    try {
        // Use file-based auth state
        const { state, saveCreds } = await useMultiFileAuthState(`sessions/${sessionId}`);
        
        // Fetch latest Baileys version
        const { version } = await fetchLatestBaileysVersion();
        
        // Create socket connection
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            logger: pino({ level: 'silent' }),
            syncFullHistory: false
        });
        
        // Store session data
        sessions.set(sessionId, {
            sock,
            state,
            saveCreds,
            creds: state.creds,
            keys: state.keys
        });
        
        // Set up event handlers
        setupEventHandlers(sessionId, sock, saveCreds);
        
        return sock;
    } catch (error) {
        console.error(`Error creating session ${sessionId}:`, error);
        throw error;
    }
}

/**
 * Sets up event handlers for a WhatsApp socket
 */
function setupEventHandlers(sessionId, sock, saveCreds) {
    
    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // QR code received - connection is waiting
            const qrCode = await generateQRCode(qr);
            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'qr',
                qr: qrCode
            });
            console.log(`[${sessionId}] QR Code generated`);
        }
        
        if (connection === 'open') {
            // Connection successful
            const phoneNumber = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
            connectionStates.set(sessionId, {
                status: 'connected',
                phone: sock.user?.name || phoneNumber,
                connectedAt: new Date().toISOString()
            });
            
            // Initialize message store for this account
            if (!messageStore.has(sessionId)) {
                messageStore.set(sessionId, []);
            }
            
            console.log(`[${sessionId}] Connected as ${sock.user?.name || phoneNumber}`);
        }
        
        if (connection === 'close') {
            // Connection closed
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'disconnected'
            });
            
            console.log(`[${sessionId}] Connection closed. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // Attempt to reconnect
                setTimeout(() => createSession(sessionId), 3000);
            } else {
                // User logged out
                sessions.delete(sessionId);
                connectionStates.delete(sessionId);
                console.log(`[${sessionId}] Session terminated`);
            }
        }
    });
    
    // Handle credential updates
    sock.ev.on('creds.update', saveCreds);
    
    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        
        if (!msg.key.fromMe && msg.message) {
            // Incoming message
            const messageText = msg.message.conversation || 
                              msg.message.extendedTextMessage?.text || 
                              'Media message';
            
            const messageData = {
                id: msg.key.id,
                from: msg.key.remoteJid,
                text: messageText,
                timestamp: msg.messageTimestamp,
                direction: 'received'
            };
            
            // Store message
            const messages = messageStore.get(sessionId) || [];
            messages.push(messageData);
            messageStore.set(sessionId, messages.slice(-100)); // Keep last 100 messages
            
            console.log(`[${sessionId}] Message from ${msg.key.remoteJid}: ${messageText}`);
        }
    });
}

/**
 * Generates QR code as base64 image
 */
async function generateQRCode(qrString) {
    try {
        const QRCode = require('qrcode');
        const qrImage = await QRCode.toDataURL(qrString);
        return qrImage.split(',')[1]; // Return base64 without header
    } catch (error) {
        console.error('Error generating QR code:', error);
        throw error;
    }
}

// ============================================
// API ROUTES
// ============================================

/**
 * GET /api/accounts
 * Returns all connected accounts
 */
app.get('/api/accounts', (req, res) => {
    const accounts = [];
    
    connectionStates.forEach((state, sessionId) => {
        if (state.status === 'connected') {
            accounts.push({
                id: sessionId,
                phone: state.phone,
                status: 'connected',
                connectedAt: state.connectedAt
            });
        }
    });
    
    res.json(accounts);
});

/**
 * POST /api/connect/qr
 * Initiates QR code connection
 */
app.post('/api/connect/qr', async (req, res) => {
    try {
        const sessionId = uuidv4();
        
        // Initialize connection state
        connectionStates.set(sessionId, {
            status: 'initializing',
            method: 'qr'
        });
        
        // Create session (this will generate QR code)
        await createSession(sessionId);
        
        // Set timeout for connection (2 minutes)
        const timeout = setTimeout(() => {
            if (connectionStates.get(sessionId)?.status !== 'connected') {
                connectionStates.set(sessionId, {
                    status: 'timeout',
                    method: 'qr'
                });
                sessions.delete(sessionId);
            }
            pendingConnections.delete(sessionId);
        }, 120000);
        
        pendingConnections.set(sessionId, { method: 'qr', timeout });
        
        res.json({
            sessionId,
            status: 'initializing',
            message: 'QR code session created'
        });
        
    } catch (error) {
        console.error('QR connection error:', error);
        res.status(500).json({
            message: 'Failed to create QR connection',
            error: error.message
        });
    }
});

/**
 * POST /api/connect/pair
 * Initiates pair code connection
 */
app.post('/api/connect/pair', async (req, res) => {
    try {
        const sessionId = uuidv4();
        const phoneNumber = req.body.phoneNumber;
        
        if (!phoneNumber) {
            return res.status(400).json({ message: 'Phone number required' });
        }
        
        // Initialize connection state
        connectionStates.set(sessionId, {
            status: 'initializing',
            method: 'pair'
        });
        
        // Create session first
        await createSession(sessionId);
        
        // Request pair code
        const sock = sessions.get(sessionId)?.sock;
        if (!sock) {
            throw new Error('Failed to create session');
        }
        
        // Request pairing code (Note: This feature may vary based on Baileys version)
        const code = await sock.requestPairingCode(phoneNumber);
        
        connectionStates.set(sessionId, {
            ...connectionStates.get(sessionId),
            status: 'pairing',
            pairCode: code
        });
        
        // Set timeout
        const timeout = setTimeout(() => {
            if (connectionStates.get(sessionId)?.status !== 'connected') {
                connectionStates.set(sessionId, {
                    status: 'timeout',
                    method: 'pair'
                });
                sessions.delete(sessionId);
            }
            pendingConnections.delete(sessionId);
        }, 120000);
        
        pendingConnections.set(sessionId, { method: 'pair', timeout });
        
        res.json({
            sessionId,
            pairCode: code,
            status: 'pairing',
            message: 'Pair code generated'
        });
        
    } catch (error) {
        console.error('Pair code connection error:', error);
        res.status(500).json({
            message: 'Failed to create pair code connection',
            error: error.message
        });
    }
});

/**
 * GET /api/connection-status/:sessionId
 * Polls connection status
 */
app.get('/api/connection-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const state = connectionStates.get(sessionId);
    
    if (!state) {
        return res.status(404).json({
            status: 'error',
            message: 'Session not found'
        });
    }
    
    res.json({
        sessionId,
        status: state.status,
        qr: state.qr || null,
        pairCode: state.pairCode || null,
        phone: state.phone || null,
        id: sessionId // Client expects this on successful connection
    });
});

/**
 * POST /api/send-message
 * Sends a WhatsApp message
 */
app.post('/api/send-message', async (req, res) => {
    try {
        const { id, to, text } = req.body;
        
        // Validate inputs
        if (!id || !to || !text) {
            return res.status(400).json({
                message: 'Missing required fields: id, to, text'
            });
        }
        
        // Get session
        const session = sessions.get(id);
        if (!session || !session.sock) {
            return res.status(404).json({
                message: 'Account not connected'
            });
        }
        
        // Send message
        const sock = session.sock;
        const result = await sock.sendMessage(to, { text });
        
        // Store sent message
        const messages = messageStore.get(id) || [];
        messages.push({
            id: result.key.id,
            to: to,
            text: text,
            timestamp: Date.now() / 1000,
            direction: 'sent'
        });
        messageStore.set(id, messages.slice(-100));
        
        res.json({
            success: true,
            messageId: result.key.id,
            timestamp: result.messageTimestamp
        });
        
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({
            message: 'Failed to send message',
            error: error.message
        });
    }
});

/**
 * GET /api/messages/:accountId
 * Returns message history for an account
 */
app.get('/api/messages/:accountId', (req, res) => {
    const { accountId } = req.params;
    const messages = messageStore.get(accountId) || [];
    
    res.json({
        accountId,
        messages: messages.slice(-50), // Return last 50 messages
        total: messages.length
    });
});

/**
 * POST /api/disconnect/:accountId
 * Disconnects an account
 */
app.post('/api/disconnect/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        const session = sessions.get(accountId);
        
        if (session && session.sock) {
            // Logout and close connection
            await session.sock.logout();
            await session.sock.end();
        }
        
        // Clean up
        sessions.delete(accountId);
        connectionStates.delete(accountId);
        messageStore.delete(accountId);
        
        // Clean up session files (optional)
        const fs = require('fs').promises;
        const sessionPath = `./sessions/${accountId}`;
        try {
            await fs.rm(sessionPath, { recursive: true, force: true });
        } catch (err) {
            console.error('Error deleting session files:', err);
        }
        
        res.json({
            success: true,
            message: 'Account disconnected successfully'
        });
        
    } catch (error) {
        console.error('Disconnect error:', error);
        res.status(500).json({
            message: 'Failed to disconnect account',
            error: error.message
        });
    }
});

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        connectedAccounts: Array.from(connectionStates.values())
            .filter(s => s.status === 'connected').length
    });
});

// ============================================
// SERVE FRONTEND
// ============================================

// Serve the main HTML file for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   WhatsApp Multi-Account Manager       ║
    ║   Server running on port ${PORT}         ║
    ║   http://localhost:${PORT}              ║
    ╚════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    
    // Disconnect all sessions
    for (const [sessionId, session] of sessions) {
        try {
            await session.sock.logout();
            await session.sock.end();
        } catch (error) {
            console.error(`Error disconnecting ${sessionId}:`, error);
        }
    }
    
    console.log('All sessions closed. Goodbye!');
    process.exit(0);
});
