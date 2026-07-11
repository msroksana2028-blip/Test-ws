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

// Baileys imports
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

// Create sessions directory if it doesn't exist
const sessionsDir = process.env.SESSIONS_DIR || './sessions';
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Use /tmp for sessions on Render (ephemeral storage)
const isRender = process.env.RENDER === 'true';
const sessionPath = isRender ? '/tmp/sessions' : sessionsDir;

if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
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
        memory: process.memoryUsage()
    });
});

// ============================================
// STATE MANAGEMENT
// ============================================

const sessions = new Map();
const connectionStates = new Map();
const pendingConnections = new Map();
const messageStore = new Map();

// ============================================
// BAILEYS SESSION MANAGEMENT
// ============================================

async function createSession(sessionId) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(
            path.join(sessionPath, sessionId)
        );
        
        const { version } = await fetchLatestBaileysVersion();
        
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
        
        sessions.set(sessionId, {
            sock,
            state,
            saveCreds,
            creds: state.creds,
            keys: state.keys
        });
        
        setupEventHandlers(sessionId, sock, saveCreds);
        
        return sock;
    } catch (error) {
        console.error(`Error creating session ${sessionId}:`, error);
        throw error;
    }
}

function setupEventHandlers(sessionId, sock, saveCreds) {
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrCode = await generateQRCode(qr);
            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'qr',
                qr: qrCode
            });
        }
        
        if (connection === 'open') {
            const phoneNumber = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
            connectionStates.set(sessionId, {
                status: 'connected',
                phone: sock.user?.name || phoneNumber,
                connectedAt: new Date().toISOString()
            });
            
            if (!messageStore.has(sessionId)) {
                messageStore.set(sessionId, []);
            }
        }
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'disconnected'
            });
            
            if (shouldReconnect) {
                setTimeout(() => createSession(sessionId), 5000);
            } else {
                sessions.delete(sessionId);
                connectionStates.delete(sessionId);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        
        if (!msg.key.fromMe && msg.message) {
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
            
            const messages = messageStore.get(sessionId) || [];
            messages.push(messageData);
            messageStore.set(sessionId, messages.slice(-100));
        }
    });
}

async function generateQRCode(qrString) {
    try {
        const QRCode = require('qrcode');
        const qrImage = await QRCode.toDataURL(qrString);
        return qrImage.split(',')[1];
    } catch (error) {
        console.error('Error generating QR code:', error);
        throw error;
    }
}

// ============================================
// API ROUTES
// ============================================

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

app.post('/api/connect/qr', async (req, res) => {
    try {
        const sessionId = uuidv4();
        
        connectionStates.set(sessionId, {
            status: 'initializing',
            method: 'qr'
        });
        
        await createSession(sessionId);
        
        const timeout = setTimeout(() => {
            if (connectionStates.get(sessionId)?.status !== 'connected') {
                connectionStates.set(sessionId, {
                    status: 'timeout',
                    method: 'qr'
                });
                sessions.delete(sessionId);
            }
            pendingConnections.delete(sessionId);
        }, 180000); // 3 minutes for Render
        
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

app.post('/api/connect/pair', async (req, res) => {
    try {
        const sessionId = uuidv4();
        const phoneNumber = req.body.phoneNumber;
        
        if (!phoneNumber) {
            return res.status(400).json({ message: 'Phone number required' });
        }
        
        connectionStates.set(sessionId, {
            status: 'initializing',
            method: 'pair'
        });
        
        await createSession(sessionId);
        
        const sock = sessions.get(sessionId)?.sock;
        if (!sock) {
            throw new Error('Failed to create session');
        }
        
        const code = await sock.requestPairingCode(phoneNumber);
        
        connectionStates.set(sessionId, {
            ...connectionStates.get(sessionId),
            status: 'pairing',
            pairCode: code
        });
        
        const timeout = setTimeout(() => {
            if (connectionStates.get(sessionId)?.status !== 'connected') {
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

app.post('/api/send-message', async (req, res) => {
    try {
        const { id, to, text } = req.body;
        
        if (!id || !to || !text) {
            return res.status(400).json({
                message: 'Missing required fields: id, to, text'
            });
        }
        
        const session = sessions.get(id);
        if (!session || !session.sock) {
            return res.status(404).json({
                message: 'Account not connected'
            });
        }
        
        const sock = session.sock;
        const result = await sock.sendMessage(to, { text });
        
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

app.get('/api/messages/:accountId', (req, res) => {
    const { accountId } = req.params;
    const messages = messageStore.get(accountId) || [];
    
    res.json({
        accountId,
        messages: messages.slice(-50),
        total: messages.length
    });
});

app.post('/api/disconnect/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        const session = sessions.get(accountId);
        
        if (session && session.sock) {
            await session.sock.logout();
            await session.sock.end();
        }
        
        sessions.delete(accountId);
        connectionStates.delete(accountId);
        messageStore.delete(accountId);
        
        const sessionFilePath = path.join(sessionPath, accountId);
        try {
            fs.rmSync(sessionFilePath, { recursive: true, force: true });
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
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║   WhatsApp Manager - Render Deploy     ║
    ║   Port: ${PORT}                        ║
    ║   Environment: ${process.env.NODE_ENV || 'production'}     ║
    ║   Sessions: ${sessionPath}              ║
    ╚════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Closing sessions...');
    
    for (const [sessionId, session] of sessions) {
        try {
            await session.sock.end();
        } catch (error) {
            console.error(`Error closing session ${sessionId}:`, error);
        }
    }
    
    process.exit(0);
});
