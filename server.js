// ============================================
// WhatsApp Multi-Account Manager
// Pair Code ONLY + Groq AI + FIXED MESSAGE SENDING
// ============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    delay,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');

const Groq = require('groq-sdk');
const pino = require('pino');

// ========== কনফিগারেশন ==========
const GROQ_API_KEY = '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';
const SESSIONS_DIR = process.env.RENDER ? '/tmp/sessions' : './sessions';
const PORT = process.env.PORT || 10000;
// =================================

const groq = new Groq({ apiKey: GROQ_API_KEY });
const app = express();

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store
const sessions = new Map();
const sessionStates = new Map();
const messageLogs = new Map();
const accounts = [];

// ============================================
// AI REPLY - FIXED
// ============================================

function detectLanguage(text) {
    const banglaRegex = /[\u0980-\u09FF]/;
    return banglaRegex.test(text) ? 'bn' : 'en';
}

async function aiReply(msg, sock, sessionId) {
    const text = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption;

    if (!text || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const language = detectLanguage(text);
    const botInfo = {
        name: sock.user?.name || 'Python Ex',
        phone: sock.user?.id?.split(':')[0] || 'Unknown'
    };

    console.log(`📩 [${botInfo.name}] From: ${sender} | Text: ${text}`);

    // Log incoming
    const logs = messageLogs.get(sessionId) || [];
    logs.push({
        from: sender,
        text: text,
        time: new Date().toISOString(),
        direction: 'received'
    });

    const systemPrompt = language === 'bn' ?
        `তুমি ${botInfo.name} - একজন সাধারণ মানুষ। তুমি কোন বট না। স্বাভাবিক মানুষের মতো ছোট করে কথা বলবে। কখনো বলবে না তুমি বট/AI।` :
        `You are ${botInfo.name} - a real human. Keep replies short and natural. Never mention being a bot/AI.`;

    try {
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            max_tokens: 150,
            temperature: 0.8,
        });

        const reply = completion.choices[0].message.content;
        console.log(`🤖 Reply: ${reply}`);

        // SEND MESSAGE - FIXED
        try {
            await sock.sendMessage(sender, { text: reply });
            console.log(`✅ Message sent to ${sender}`);

            // Log outgoing
            logs.push({
                to: sender,
                text: reply,
                time: new Date().toISOString(),
                direction: 'sent'
            });
        } catch (sendErr) {
            console.error(`❌ Send error: ${sendErr.message}`);
        }

    } catch (err) {
        console.error('❌ Groq Error:', err.message);
        const errorMsg = language === 'bn' ?
            'একটু সমস্যা হচ্ছে, পরে কথা বলি!' :
            'Small issue, talk later!';
        try {
            await sock.sendMessage(sender, { text: errorMsg });
        } catch (e) {
            console.error('Error reply failed:', e.message);
        }
    }

    messageLogs.set(sessionId, logs.slice(-100));
}

// ============================================
// CREATE SESSION - FIXED
// ============================================

async function createSession(sessionId, phoneNumber) {
    const authPath = `${SESSIONS_DIR}/${sessionId}`;
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        markOnlineOnConnect: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            const phone = sock.user?.id?.split(':')[0] || phoneNumber;
            const name = sock.user?.name || phone;

            sessionStates.set(sessionId, {
                status: 'connected',
                phone: phone,
                name: name
            });

            const exists = accounts.find(a => a.id === sessionId);
            if (!exists) {
                accounts.push({
                    id: sessionId,
                    phone: phone,
                    name: name,
                    status: 'connected',
                    aiEnabled: true
                });
            }

            if (!messageLogs.has(sessionId)) {
                messageLogs.set(sessionId, []);
            }

            console.log(`✅ Connected: ${name} (${phone})`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log(`🔄 Reconnecting ${sessionId}...`);
                setTimeout(() => createSession(sessionId, phoneNumber), 5000);
            } else {
                console.log(`❌ Logged out: ${sessionId}`);
                sessions.delete(sessionId);
                sessionStates.delete(sessionId);
                const idx = accounts.findIndex(a => a.id === sessionId);
                if (idx > -1) accounts.splice(idx, 1);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Message handler - FIXED
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                // Skip status messages, broadcasts, etc.
                if (msg.key.remoteJid === 'status@broadcast') continue;
                if (msg.key.fromMe) continue;
                
                // Process only real messages
                if (msg.message) {
                    await aiReply(msg, sock, sessionId);
                }
            }
        }
    });

    sessions.set(sessionId, sock);
    return sock;
}

// ============================================
// API: PAIR CODE
// ============================================

app.post('/api/pair', async (req, res) => {
    try {
        let { phone } = req.body;
        if (!phone) return res.json({ success: false, error: 'Phone required' });

        phone = phone.replace(/\D/g, '');
        const sessionId = uuidv4();

        sessionStates.set(sessionId, { status: 'initializing', phone });

        const sock = await createSession(sessionId, phone);
        await delay(2000);

        const code = await sock.requestPairingCode(phone);
        console.log(`🔑 Code: ${code}`);

        sessionStates.set(sessionId, {
            status: 'pair_ready',
            pairCode: code,
            phone
        });

        res.json({
            success: true,
            code,
            sessionId,
            phone
        });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// API: SEND MESSAGE - FIXED
// ============================================

app.post('/api/send', async (req, res) => {
    try {
        const { id, to, text } = req.body;
        const sock = sessions.get(id);

        if (!sock) return res.json({ success: false, error: 'Not connected' });

        const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
        
        // Simple send
        const result = await sock.sendMessage(jid, { text });

        // Log
        const logs = messageLogs.get(id) || [];
        logs.push({
            to: jid,
            text,
            time: new Date().toISOString(),
            direction: 'sent'
        });
        messageLogs.set(id, logs.slice(-100));

        res.json({ success: true, id: result.key.id });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// API: STATUS, ACCOUNTS, MESSAGES, DISCONNECT
// ============================================

app.get('/api/status/:id', (req, res) => {
    const state = sessionStates.get(req.params.id);
    if (!state) return res.json({ status: 'not_found' });
    res.json({ ...state, id: req.params.id });
});

app.get('/api/accounts', (req, res) => res.json(accounts));

app.get('/api/messages/:id', (req, res) => {
    res.json({ messages: messageLogs.get(req.params.id) || [] });
});

app.post('/api/disconnect/:id', async (req, res) => {
    try {
        const sock = sessions.get(req.params.id);
        if (sock) { await sock.logout(); await sock.end(); }
        
        sessions.delete(req.params.id);
        sessionStates.delete(req.params.id);
        messageLogs.delete(req.params.id);
        
        const idx = accounts.findIndex(a => a.id === req.params.id);
        if (idx > -1) accounts.splice(idx, 1);
        
        const dir = `${SESSIONS_DIR}/${req.params.id}`;
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        accounts: accounts.length,
        connected: accounts.filter(a => a.status === 'connected').length
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START
// ============================================

async function loadSessions() {
    if (fs.existsSync(SESSIONS_DIR)) {
        const dirs = fs.readdirSync(SESSIONS_DIR).filter(f =>
            fs.statSync(`${SESSIONS_DIR}/${f}`).isDirectory()
        );
        console.log(`📂 Loading ${dirs.length} sessions...`);
        for (const dir of dirs) {
            await createSession(dir, 'unknown');
            await delay(2000);
        }
    }
}

app.listen(PORT, async () => {
    console.log(`✅ Server running on port ${PORT}`);
    await loadSessions();
});

if (process.env.RENDER) {
    setInterval(() => {
        require('http').get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {});
    }, 840000);
}
