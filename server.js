// ============================================
// server.js - WhatsApp Multi-Account Backend
// FIXED: Pair Code Priority + QR Code Support
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const app = express();
const PORT = process.env.PORT || 10000;

// ============================================
// BASIC SETUP
// ============================================

const isRender = process.env.RENDER === 'true';
const sessionPath = isRender ? '/tmp/sessions' : './sessions';

if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
}

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// STATE MANAGEMENT
// ============================================

const sessions = new Map();
const connectionStates = new Map();
const messageStore = new Map();

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size
    });
});

// ============================================
// BAILEYS SESSION MANAGEMENT
// ============================================

async function createSession(sessionId, method) {
    try {
        const sessionDir = path.join(sessionPath, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
            printQRInTerminal: true, // Print to terminal for debugging
            browser: Browsers.ubuntu('Chrome'),
            logger: pino({ level: 'silent' }),
            syncFullHistory: false
        });
        
        sessions.set(sessionId, { sock, state, saveCreds });
        setupEventHandlers(sessionId, sock, saveCreds, method);
        
        return sock;
    } catch (error) {
        console.error(`Session creation error:`, error);
        throw error;
    }
}

function setupEventHandlers(sessionId, sock, saveCreds, method) {
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Handle QR Code
        if (qr) {
            try {
                const QRCode = require('qrcode');
                const qrImage = await QRCode.toDataURL(qr);
                const qrBase64 = qrImage.split(',')[1];
                
                connectionStates.set(sessionId, {
                    ...connectionStates.get(sessionId),
                    status: 'qr_ready',
                    qr: qrBase64,
                    method: method
                });
                console.log(`✅ QR Code ready for: ${sessionId}`);
            } catch (err) {
                console.error('QR generation error:', err);
            }
        }
        
        // Connection successful
        if (connection === 'open') {
            const userInfo = sock.user;
            const phone = userInfo?.name || userInfo?.id?.split(':')[0] || 'Connected';
            
            connectionStates.set(sessionId, {
                status: 'connected',
                phone: phone,
                connectedAt: new Date().toISOString(),
                method: method
            });
            
            if (!messageStore.has(sessionId)) {
                messageStore.set(sessionId, []);
            }
            
            console.log(`🎉 Connected: ${phone} (${sessionId})`);
        }
        
        // Connection closed
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`Connection closed: ${sessionId}, Status: ${statusCode}`);
            
            if (shouldReconnect) {
                connectionStates.set(sessionId, {
                    ...connectionStates.get(sessionId),
                    status: 'reconnecting'
                });
                setTimeout(() => createSession(sessionId, method), 5000);
            } else {
                connectionStates.set(sessionId, {
                    status: 'disconnected'
                });
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    // Handle messages
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const text = msg.message.conversation || 
                        msg.message.extendedTextMessage?.text || 
                        'Media message';
            
            const messages = messageStore.get(sessionId) || [];
            messages.push({
                id: msg.key.id,
                from: msg.key.remoteJid,
                text: text,
                timestamp: msg.messageTimestamp,
                direction: 'received'
            });
            messageStore.set(sessionId, messages.slice(-100));
        }
    });
}

// ============================================
// API: GET ALL ACCOUNTS
// ============================================

app.get('/api/accounts', (req, res) => {
    const accounts = [];
    connectionStates.forEach((state, id) => {
        if (state.status === 'connected') {
            accounts.push({
                id: id,
                phone: state.phone,
                status: 'connected'
            });
        }
    });
    res.json(accounts);
});

// ============================================
// API: PAIR CODE CONNECTION (PRIMARY METHOD)
// ============================================

app.post('/api/connect/pair', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }
        
        // Clean phone number
        const cleanPhone = phoneNumber.replace(/[\s\+\-\(\)]/g, '');
        console.log(`📱 Pair code request for: ${cleanPhone}`);
        
        const sessionId = uuidv4();
        
        // Initialize state
        connectionStates.set(sessionId, {
            status: 'initializing',
            method: 'pair',
            phone: cleanPhone
        });
        
        // Create session
        const sock = await createSession(sessionId, 'pair');
        
        // Wait a moment for socket to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Request pairing code
        try {
            const code = await sock.requestPairingCode(cleanPhone);
            console.log(`🔑 Pair code generated: ${code}`);
            
            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'pair_ready',
                pairCode: code
            });
            
            // Return immediately with pair code
            res.json({
                success: true,
                sessionId: sessionId,
                pairCode: code,
                status: 'pair_ready',
                message: 'Pair code generated successfully'
            });
            
        } catch (pairError) {
            console.error('Pair code error:', pairError);
            
            // If pair code fails, fall back to QR code
            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'qr_fallback',
                pairError: pairError.message
            });
            
            res.json({
                success: true,
                sessionId: sessionId,
                status: 'qr_fallback',
                message: 'Pair code failed, QR code will be generated. Please wait...'
            });
        }
        
    } catch (error) {
        console.error('Connection error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create connection: ' + error.message
        });
    }
});

// ============================================
// API: QR CODE CONNECTION (FALLBACK METHOD)
// ============================================

app.post('/api/connect/qr', async (req, res) => {
    try {
        const sessionId = uuidv4();
        
        connectionStates.set(sessionId, {
            status: 'initializing',
            method: 'qr'
        });
        
        await createSession(sessionId, 'qr');
        
        // Wait for QR to be generated
        let qrCode = null;
        let attempts = 0;
        
        while (!qrCode && attempts < 10) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const state = connectionStates.get(sessionId);
            if (state && state.qr) {
                qrCode = state.qr;
            }
            attempts++;
        }
        
        if (qrCode) {
            res.json({
                success: true,
                sessionId: sessionId,
                qr: qrCode,
                status: 'qr_ready',
                message: 'QR code generated'
            });
        } else {
            res.json({
                success: true,
                sessionId: sessionId,
                status: 'waiting_qr',
                message: 'QR code is being generated'
            });
        }
        
    } catch (error) {
        console.error('QR error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed: ' + error.message
        });
    }
});

// ============================================
// API: CHECK CONNECTION STATUS
// ============================================

app.get('/api/connection-status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const state = connectionStates.get(sessionId);
    
    if (!state) {
        return res.json({
            status: 'not_found',
            message: 'Session not found'
        });
    }
    
    res.json({
        sessionId: sessionId,
        status: state.status,
        qr: state.qr || null,
        pairCode: state.pairCode || null,
        phone: state.phone || null,
        id: sessionId,
        method: state.method
    });
});

// ============================================
// API: SEND MESSAGE
// ============================================

app.post('/api/send-message', async (req, res) => {
    try {
        const { id, to, text } = req.body;
        
        if (!id || !to || !text) {
            return res.status(400).json({ message: 'Missing fields' });
        }
        
        const session = sessions.get(id);
        if (!session?.sock) {
            return res.status(404).json({ message: 'Not connected' });
        }
        
        const result = await session.sock.sendMessage(to, { text });
        
        const messages = messageStore.get(id) || [];
        messages.push({
            id: result.key.id,
            to: to,
            text: text,
            timestamp: Date.now() / 1000,
            direction: 'sent'
        });
        messageStore.set(id, messages.slice(-100));
        
        res.json({ success: true, messageId: result.key.id });
        
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ============================================
// API: GET MESSAGES
// ============================================

app.get('/api/messages/:accountId', (req, res) => {
    const messages = messageStore.get(req.params.accountId) || [];
    res.json({ messages: messages.slice(-50) });
});

// ============================================
// API: DISCONNECT
// ============================================

app.post('/api/disconnect/:accountId', async (req, res) => {
    try {
        const { accountId } = req.params;
        const session = sessions.get(accountId);
        
        if (session?.sock) {
            await session.sock.logout();
            await session.sock.end();
        }
        
        sessions.delete(accountId);
        connectionStates.delete(accountId);
        messageStore.delete(accountId);
        
        // Clean files
        const dir = path.join(sessionPath, accountId);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// ============================================
// SERVE FRONTEND
// ============================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`\n✅ Server running on port ${PORT}`);
    console.log(`📁 Sessions: ${sessionPath}\n`);
});

// Keep alive for Render
if (isRender) {
    setInterval(() => {
        const http = require('http');
        http.get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {});
    }, 840000); // 14 minutes
}
