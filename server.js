// ============================================
// server.js - WhatsApp Multi-Account Backend
// Render Deployment Ready
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// CORRECT Baileys import - using @whiskeysockets
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

const pino = require('pino');

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// RENDER SPECIFIC SETUP
// ============================================

// Use /tmp for sessions on Render (ephemeral storage)
const isRender = process.env.RENDER === 'true';
const sessionPath = isRender ? '/tmp/sessions' : './sessions';

// Create sessions directory if it doesn't exist
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log(`Created sessions directory at: ${sessionPath}`);
}

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// HEALTH CHECK (Render requires this)
// ============================================

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        sessions: sessions.size,
        connectedAccounts: Array.from(connectionStates.values())
            .filter(s => s.status === 'connected').length
    });
});

// ============================================
// STATE MANAGEMENT
// ============================================

const sessions = new Map(); // Map<sessionId, { sock, state, saveCreds }>
const connectionStates = new Map(); // Map<sessionId, { status, qr, pairCode, phone }>
const pendingConnections = new Map(); // Map<sessionId, { method, timeout }>
const messageStore = new Map(); // Map<accountId, Array<messages>>

// ============================================
// BAILEYS SESSION MANAGEMENT
// ============================================

async function createSession(sessionId) {
    try {
        const sessionDir = path.join(sessionPath, sessionId);
        
        // Use file-based auth state
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        
        // Fetch latest Baileys version
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using Baileys version: ${version}, isLatest: ${isLatest}`);
        
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
        
        console.log(`Session created: ${sessionId}`);
        return sock;
        
    } catch (error) {
        console.error(`Error creating session ${sessionId}:`, error);
        throw error;
    }
}

function setupEventHandlers(sessionId, sock, saveCreds) {
    
    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // QR Code received
        if (qr) {
            try {
                const QRCode = require('qrcode');
                const qrImage = await QRCode.toDataURL(qr);
                const qrBase64 = qrImage.split(',')[1];
                
                connectionStates.set(sessionId, {
                    ...connectionStates.get(sessionId),
                    status: 'qr',
                    qr: qrBase64
                });
                console.log(`QR Code generated for session: ${sessionId}`);
            } catch (error) {
                console.error('Error generating QR code:', error);
            }
        }
        
        // Connection successful
        if (connection === 'open') {
            const phoneNumber = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
            connectionStates.set(sessionId, {
                status: 'connected',
                phone: sock.user?.name || phoneNumber,
                connectedAt: new Date().toISOString()
            });
            
            // Initialize message store
            if (!messageStore.has(sessionId)) {
                messageStore.set(sessionId, []);
            }
            
            console.log(`✅ Connected: ${sock.user?.name || phoneNumber} (${sessionId})`);
        }
        
        // Connection closed
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'disconnected'
            });
            
            console.log(`Connection closed for ${sessionId}. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // Attempt reconnection after delay
                setTimeout(() => {
                    createSession(sessionId).catch(err => {
                        console.error(`Reconnection failed for ${sessionId}:`, err);
                    });
                }, 5000);
            } else {
                // Clean up logged out session
                sessions.delete(sessionId);
                connectionStates.delete(sessionId);
                console.log(`Session ${sessionId} logged out and removed`);
            }
        }
    });
    
    // Handle credential updates
    sock.ev.on('creds.update', saveCreds);
    
    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        
        if (!msg.key.fromMe && msg.message) {
            const messageText = msg.message.conversation || 
                              msg.message.extendedTextMessage?.text || 
                              msg.message.imageMessage?.caption ||
                              'Media message';
            
            const messageData = {
                id: msg.key.id,
                from: msg.key.remoteJid,
                text: messageText,
                timestamp: msg.messageTimestamp || Date.now() / 1000,
                direction: 'received'
            };
            
            // Store message
            const messages = messageStore.get(sessionId) || [];
            messages.push(messageData);
            messageStore.set(sessionId, messages.slice(-100)); // Keep last 100
        }
    });
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
        
        // Set timeout for connection (3 minutes)
        const timeout = setTimeout(() => {
            const state = connectionStates.get(sessionId);
            if (state && state.status !== 'connected') {
                connectionStates.set(sessionId, {
                    status: 'timeout',
                    method: 'qr'
                });
                sessions.delete(sessionId);
            }
            pendingConnections.delete(sessionId);
        }, 180000);
        
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
            return res.status(400).json({ message: 'Phone number is required' });
        }
        
        // Initialize connection state
        connectionStates.set(sessionId, {
            status: 'initializing',
            method: 'pair'
        });
        
        // Create session first
        await createSession(sessionId);
        
        // Get socket
        const sock = sessions.get(sessionId)?.sock;
        if (!sock) {
            throw new Error('Failed to create session');
        }
        
        // Request pairing code
        const code = await sock.requestPairingCode(phoneNumber);
        
        // Update state with pair code
        connectionStates.set(sessionId, {
            ...connectionStates.get(sessionId),
            status: 'pairing',
            pairCode: code
        });
        
        // Set timeout
        const timeout = setTimeout(() => {
            const state = connectionStates.get(sessionId);
            if (state && state.status !== 'connected') {
                connectionStates.set(sessionId, {
                    status: 'timeout',
                    method: 'pair'
                });
                sessions.delete(sessionId);
            }
            pendingConnections.delete(sessionId);
        }, 180000);
        
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
        id: sessionId
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
                message: 'Account not connected or session not found'
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
 * Returns message history
 */
app.get('/api/messages/:accountId', (req, res) => {
    const { accountId } = req.params;
    const messages = messageStore.get(accountId) || [];
    
    res.json({
        accountId,
        messages: messages.slice(-50),
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
            try {
                await session.sock.logout();
                await session.sock.end();
            } catch (err) {
                console.error(`Error during logout for ${accountId}:`, err);
            }
        }
        
        // Clean up state
        sessions.delete(accountId);
        connectionStates.delete(accountId);
        messageStore.delete(accountId);
        
        // Clean up session files
        const sessionDir = path.join(sessionPath, accountId);
        try {
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
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

// ============================================
// SERVE FRONTEND
// ============================================

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for all other routes (SPA support)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// ERROR HANDLING
// ============================================

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// ============================================
// KEEP ALIVE FOR RENDER FREE TIER
// ============================================

function startKeepAlive() {
    if (isRender) {
        setInterval(() => {
            const http = require('http');
            http.get(`http://localhost:${PORT}/health`, (res) => {
                // Silently ping to prevent sleep
            }).on('error', () => {
                // Ignore errors
            });
        }, 14 * 60 * 1000); // Every 14 minutes
        console.log('Keep-alive pings enabled');
    }
}

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════════╗
    ║     WhatsApp Manager - Render Deploy       ║
    ║     Port: ${PORT}                           ║
    ║     Environment: ${process.env.NODE_ENV || 'production'}    ║
    ║     Sessions Path: ${sessionPath}           ║
    ║     Status: Running                         ║
    ╚════════════════════════════════════════════╝
    `);
    
    // Start keep-alive pings
    startKeepAlive();
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Closing all sessions...');
    
    for (const [sessionId, session] of sessions) {
        try {
            await session.sock.end();
            console.log(`Closed session: ${sessionId}`);
        } catch (error) {
            console.error(`Error closing session ${sessionId}:`, error);
        }
    }
    
    console.log('All sessions closed. Exiting...');
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('SIGINT received. Closing all sessions...');
    
    for (const [sessionId, session] of sessions) {
        try {
            await session.sock.end();
        } catch (error) {
            console.error(`Error closing session ${sessionId}:`, error);
        }
    }
    
    process.exit(0);
});
