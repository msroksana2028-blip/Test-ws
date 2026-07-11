// ============================================
// server.js - WORKING PAIR CODE SOLUTION
// Based on latest @whiskeysockets/baileys docs
// ============================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Baileys imports
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const app = express();
const PORT = process.env.PORT || 10000;

// ============================================
// SETUP
// ============================================

const sessionPath = process.env.RENDER ? '/tmp/sessions' : './sessions';
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// STATE MANAGEMENT
// ============================================

const sessions = new Map();
const connectionStates = new Map();
const messageStore = new Map();

// ============================================
// HELPER: Sanitize phone number
// ============================================

function sanitizePhoneNumber(phone) {
    // Remove all non-digit characters
    return phone.replace(/\D/g, '');
}

// ============================================
// CREATE SOCKET - SIMPLIFIED & WORKING
// ============================================

async function createSocket(sessionId) {
    const sessionDir = path.join(sessionPath, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false, // IMPORTANT: Must be false for pair code
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: pino({ level: 'silent' }),
        syncFullHistory: false
    });

    sessions.set(sessionId, { sock, saveCreds });

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR Code received
        if (qr) {
            try {
                const QRCode = require('qrcode');
                const qrDataUrl = await QRCode.toDataURL(qr);
                const qrBase64 = qrDataUrl.split(',')[1];

                connectionStates.set(sessionId, {
                    ...connectionStates.get(sessionId),
                    status: 'qr_ready',
                    qr: qrBase64,
                    timestamp: Date.now()
                });

                console.log(`📱 QR Code ready for session: ${sessionId}`);
            } catch (err) {
                console.error('QR generation error:', err);
            }
        }

        // Connected
        if (connection === 'open') {
            const userJid = sock.user?.id;
            const phoneNumber = userJid?.split(':')[0]?.replace('@s.whatsapp.net', '');

            connectionStates.set(sessionId, {
                status: 'connected',
                phone: phoneNumber || 'Unknown',
                jid: userJid,
                connectedAt: new Date().toISOString()
            });

            if (!messageStore.has(sessionId)) {
                messageStore.set(sessionId, []);
            }

            console.log(`✅ Connected successfully: ${phoneNumber} (${sessionId})`);
        }

        // Connection closed
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ Disconnected: ${sessionId} (Status: ${statusCode})`);

            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'disconnected'
            });

            if (shouldReconnect) {
                console.log(`🔄 Reconnecting ${sessionId} in 5 seconds...`);
                setTimeout(() => createSocket(sessionId), 5000);
            } else {
                sessions.delete(sessionId);
                connectionStates.delete(sessionId);
                console.log(`🗑️ Session ${sessionId} removed (logged out)`);
            }
        }
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    sock.ev.on('messages.upsert', (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const text = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                '[Media Message]';

            const messages = messageStore.get(sessionId) || [];
            messages.push({
                id: msg.key.id,
                from: msg.key.remoteJid,
                text: text,
                timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000),
                direction: 'received'
            });
            messageStore.set(sessionId, messages.slice(-100));
        }
    });

    return sock;
}

// ============================================
// HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        connectedAccounts: Array.from(connectionStates.values())
            .filter(s => s.status === 'connected').length
    });
});

// ============================================
// API: PAIR CODE CONNECTION (PRIMARY)
// ============================================

app.post('/api/connect/pair', async (req, res) => {
    try {
        let { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }

        // Sanitize phone number - remove all non-digits
        phoneNumber = sanitizePhoneNumber(phoneNumber);

        if (!phoneNumber || phoneNumber.length < 10) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone number. Please enter a valid number with country code.'
            });
        }

        console.log(`📞 Pair code request for: ${phoneNumber}`);

        const sessionId = uuidv4();

        // Initialize connection state
        connectionStates.set(sessionId, {
            status: 'initializing',
            phone: phoneNumber,
            method: 'pair',
            timestamp: Date.now()
        });

        // Create socket
        const sock = await createSocket(sessionId);

        // Wait for socket to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Request pairing code
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`🔑 Pair Code Generated: ${code} for ${sessionId}`);

            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'pair_code_ready',
                pairCode: code,
                timestamp: Date.now()
            });

            res.json({
                success: true,
                sessionId: sessionId,
                pairCode: code,
                phoneNumber: phoneNumber,
                message: 'Pair code generated successfully',
                instructions: 'Open WhatsApp > Linked Devices > Link a Device > Enter code manually'
            });

        } catch (pairError) {
            console.error(`❌ Pair code error for ${sessionId}:`, pairError.message);

            // Update state - wait for QR fallback
            connectionStates.set(sessionId, {
                ...connectionStates.get(sessionId),
                status: 'waiting_for_qr',
                pairError: pairError.message
            });

            res.json({
                success: true,
                sessionId: sessionId,
                status: 'qr_fallback',
                message: 'Pair code not available. QR code will be generated as fallback.',
                error: pairError.message
            });
        }

    } catch (error) {
        console.error('Connection error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to create connection'
        });
    }
});

// ============================================
// API: QR CODE CONNECTION (FALLBACK)
// ============================================

app.post('/api/connect/qr', async (req, res) => {
    try {
        const sessionId = uuidv4();

        connectionStates.set(sessionId, {
            status: 'initializing',
            method: 'qr',
            timestamp: Date.now()
        });

        await createSocket(sessionId);

        // Wait for QR to generate
        let qrCode = null;
        for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const state = connectionStates.get(sessionId);
            if (state?.qr) {
                qrCode = state.qr;
                break;
            }
        }

        if (qrCode) {
            res.json({
                success: true,
                sessionId: sessionId,
                qr: qrCode,
                status: 'qr_ready'
            });
        } else {
            res.json({
                success: true,
                sessionId: sessionId,
                status: 'generating',
                message: 'QR code is being generated. Please wait...'
            });
        }

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
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
// API: GET ALL ACCOUNTS
// ============================================

app.get('/api/accounts', (req, res) => {
    const accounts = [];

    connectionStates.forEach((state, id) => {
        if (state.status === 'connected') {
            accounts.push({
                id: id,
                phone: state.phone,
                status: 'connected',
                connectedAt: state.connectedAt
            });
        }
    });

    res.json(accounts);
});

// ============================================
// API: SEND MESSAGE
// ============================================

app.post('/api/send-message', async (req, res) => {
    try {
        const { id, to, text } = req.body;

        if (!id || !to || !text) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const session = sessions.get(id);
        if (!session?.sock) {
            return res.status(400).json({ error: 'Account not connected' });
        }

        // Format recipient
        const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;

        const result = await session.sock.sendMessage(jid, { text });

        // Store sent message
        const messages = messageStore.get(id) || [];
        messages.push({
            id: result.key.id,
            to: jid,
            text: text,
            timestamp: Math.floor(Date.now() / 1000),
            direction: 'sent'
        });
        messageStore.set(id, messages.slice(-100));

        res.json({
            success: true,
            messageId: result.key.id
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// API: GET MESSAGES
// ============================================

app.get('/api/messages/:accountId', (req, res) => {
    const messages = messageStore.get(req.params.accountId) || [];
    res.json({
        accountId: req.params.accountId,
        messages: messages.slice(-50)
    });
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

        // Clean session files
        const sessionDir = path.join(sessionPath, accountId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        res.json({ success: true, message: 'Disconnected successfully' });

    } catch (error) {
        res.status(500).json({ error: error.message });
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
    console.log(`
    ╔════════════════════════════════════════╗
    ║   WhatsApp Manager - Pair Code Ready  ║
    ║   Port: ${PORT}                        ║
    ║   Sessions: ${sessionPath}             ║
    ╚════════════════════════════════════════╝
    `);
});

// Keep alive for Render
if (process.env.RENDER) {
    setInterval(() => {
        require('http').get(`http://localhost:${PORT}/health`, () => { }).on('error', () => { });
    }, 840000);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    for (const [id, session] of sessions) {
        try {
            await session.sock.end();
        } catch (e) {
            // Ignore
        }
    }
    process.exit(0);
});
