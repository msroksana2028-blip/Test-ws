// ============================================
// WhatsApp Multi-Account Manager
// Pair Code ONLY + Groq AI + Web Dashboard
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
    delay
} = require('@whiskeysockets/baileys');

const Groq = require('groq-sdk');
const pino = require('pino');

// ========== কনফিগারেশন ==========
const GROQ_API_KEY = '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';
const SESSIONS_DIR = process.env.RENDER ? '/tmp/sessions' : './sessions';
const PORT = process.env.PORT || 10000;
// =================================

const groq = new Groq({ apiKey: GROQ_API_KEY });
const logger = pino({ level: 'info' });
const app = express();

// ============================================
// EXPRESS SETUP
// ============================================

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// STORE
// ============================================

const sessions = new Map(); // sock instances
const sessionStates = new Map(); // status, pairCode, phone, name
const messageLogs = new Map(); // message history per session
const accounts = []; // all account info

// ============================================
// AI REPLY FUNCTION (আপনার Groq কোড)
// ============================================

async function sendWithTyping(sock, jid, text) {
    try {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate('composing', jid);
        const typingDelay = Math.min(text.length * 15, 3000);
        await delay(typingDelay);
        await sock.sendPresenceUpdate('paused', jid);
        await sock.sendMessage(jid, { text });
    } catch (err) {
        console.error('Typing error:', err.message);
    }
}

function detectLanguage(text) {
    const banglaRegex = /[\u0980-\u09FF]/;
    return banglaRegex.test(text) ? 'bn' : 'en';
}

async function getUserInfo(sock, jid) {
    try {
        let name = 'Unknown';
        if (jid.endsWith('@s.whatsapp.net')) {
            const contacts = await sock.contactsQuery?.([jid]);
            if (contacts?.[0]) {
                name = contacts[0].name || contacts[0].notify || contacts[0].verifiedName || 'Unknown';
            }
        }
        if (jid.endsWith('@g.us')) {
            const group = await sock.groupMetadata(jid);
            name = group.subject || 'Unknown';
        }
        return { name, phone: jid.split('@')[0] };
    } catch {
        return { name: 'Unknown', phone: jid.split('@')[0] };
    }
}

async function aiReply(msg, sock, sessionId) {
    const text = msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption;

    if (!text || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const language = detectLanguage(text);
    const userInfo = await getUserInfo(sock, sender);
    const botInfo = {
        name: sock.user?.name || 'Python Ex',
        phone: sock.user?.id?.split(':')[0] || 'Unknown'
    };

    console.log(`📩 [${botInfo.name}] ${sender}: ${text}`);

    // Log message
    const logs = messageLogs.get(sessionId) || [];
    logs.push({
        from: sender,
        text: text,
        time: new Date().toISOString(),
        direction: 'received'
    });
    messageLogs.set(sessionId, logs.slice(-100));

    const systemPrompt = language === 'bn' ?
        `তুমি ${botInfo.name} - একজন সাধারণ মানুষ। তুমি কোন বট না।
তোমার নাম: ${botInfo.name}
তোমার নাম্বার: ${botInfo.phone}
সামনের মানুষ: ${userInfo.name} (${userInfo.phone})
স্বাভাবিক মানুষের মতো কথা বলবে, কখনো বলবে না তুমি বট/AI।` :
        `You are ${botInfo.name} - a real human being. You are NOT a bot.
Your name: ${botInfo.name}
Your number: ${botInfo.phone}
Person you're talking to: ${userInfo.name} (${userInfo.phone})
Talk like a normal human, never mention being a bot/AI.`;

    try {
        const completion = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            max_tokens: 200,
            temperature: 0.8,
        });

        const reply = completion.choices[0].message.content;
        await sendWithTyping(sock, sender, reply);
        console.log(`🤖 [${botInfo.name}] Reply: ${reply}`);

        // Log reply
        logs.push({
            to: sender,
            text: reply,
            time: new Date().toISOString(),
            direction: 'sent'
        });
        messageLogs.set(sessionId, logs.slice(-100));

    } catch (err) {
        console.error('❌ Groq Error:', err.message);
        const errorMsg = language === 'bn' ?
            'এই মুহূর্তে একটু সমস্যা হচ্ছে, পরে কথা বলি!' :
            'Having a small issue right now, talk later!';
        await sendWithTyping(sock, sender, errorMsg);
    }
}

// ============================================
// CREATE SESSION - ONLY PAIR CODE
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
        printQRInTerminal: false // QR বন্ধ
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            const phone = sock.user?.id?.split(':')[0] || phoneNumber;
            const name = sock.user?.name || phone;

            sessionStates.set(sessionId, {
                status: 'connected',
                phone: phone,
                name: name,
                connectedAt: new Date().toISOString()
            });

            // Account list এ যোগ করো
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

            console.log(`✅ [${sessionId}] Connected: ${name} (${phone})`);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log(`🔄 [${sessionId}] Reconnecting...`);
                sessionStates.set(sessionId, {
                    ...sessionStates.get(sessionId),
                    status: 'reconnecting'
                });
                setTimeout(() => createSession(sessionId, phoneNumber), 5000);
            } else {
                console.log(`❌ [${sessionId}] Logged out`);
                sessions.delete(sessionId);
                sessionStates.delete(sessionId);

                // Account list থেকে রিমুভ
                const idx = accounts.findIndex(a => a.id === sessionId);
                if (idx > -1) accounts.splice(idx, 1);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // AI Auto Reply
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                await aiReply(msg, sock, sessionId);
            }
        }
    });

    sessions.set(sessionId, sock);
    return sock;
}

// ============================================
// API: HEALTH CHECK
// ============================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        accounts: accounts.length,
        connected: accounts.filter(a => a.status === 'connected').length
    });
});

// ============================================
// API: PAIR CODE - শুধু এটাই!
// ============================================

app.post('/api/pair', async (req, res) => {
    try {
        let { phone } = req.body;

        if (!phone) {
            return res.json({ success: false, error: 'Phone number required' });
        }

        // Clean phone number
        phone = phone.replace(/\D/g, '');
        console.log(`📞 Pair code request: ${phone}`);

        const sessionId = uuidv4();

        // Initialize state
        sessionStates.set(sessionId, {
            status: 'initializing',
            phone: phone
        });

        // Create socket
        const sock = await createSession(sessionId, phone);

        // Wait for socket to be ready
        await delay(2000);

        // Request pair code
        try {
            const code = await sock.requestPairingCode(phone);
            console.log(`🔑 Pair Code: ${code} for ${sessionId}`);

            sessionStates.set(sessionId, {
                status: 'pair_ready',
                pairCode: code,
                phone: phone
            });

            res.json({
                success: true,
                code: code,
                sessionId: sessionId,
                phone: phone,
                message: 'Enter this code in WhatsApp > Linked Devices > Link Device'
            });

        } catch (err) {
            console.error(`❌ Pair code error: ${err.message}`);
            res.json({
                success: false,
                error: err.message,
                sessionId: sessionId
            });
        }

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// API: CHECK STATUS
// ============================================

app.get('/api/status/:sessionId', (req, res) => {
    const state = sessionStates.get(req.params.sessionId);

    if (!state) {
        return res.json({ status: 'not_found' });
    }

    res.json({
        sessionId: req.params.sessionId,
        status: state.status,
        code: state.pairCode || null,
        phone: state.phone || null,
        name: state.name || null
    });
});

// ============================================
// API: ALL ACCOUNTS
// ============================================

app.get('/api/accounts', (req, res) => {
    res.json(accounts);
});

// ============================================
// API: SEND MESSAGE
// ============================================

app.post('/api/send', async (req, res) => {
    try {
        const { id, to, text } = req.body;
        const sock = sessions.get(id);

        if (!sock) {
            return res.json({ success: false, error: 'Not connected' });
        }

        const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text });

        // Log
        const logs = messageLogs.get(id) || [];
        logs.push({
            to: jid,
            text: text,
            time: new Date().toISOString(),
            direction: 'sent'
        });
        messageLogs.set(id, logs.slice(-100));

        res.json({ success: true });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// API: GET MESSAGES
// ============================================

app.get('/api/messages/:sessionId', (req, res) => {
    const logs = messageLogs.get(req.params.sessionId) || [];
    res.json({ messages: logs.slice(-100) });
});

// ============================================
// API: DISCONNECT
// ============================================

app.post('/api/disconnect/:id', async (req, res) => {
    try {
        const sock = sessions.get(req.params.id);
        if (sock) {
            await sock.logout();
            await sock.end();
        }

        sessions.delete(req.params.id);
        sessionStates.delete(req.params.id);
        messageLogs.delete(req.params.id);

        const idx = accounts.findIndex(a => a.id === req.params.id);
        if (idx > -1) accounts.splice(idx, 1);

        // Clean files
        const dir = `${SESSIONS_DIR}/${req.params.id}`;
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }

        res.json({ success: true });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// SERVE DASHBOARD
// ============================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START SERVER
// ============================================

// পুরানো সেশন লোড
async function loadExistingSessions() {
    if (fs.existsSync(SESSIONS_DIR)) {
        const dirs = fs.readdirSync(SESSIONS_DIR).filter(f => {
            return fs.statSync(`${SESSIONS_DIR}/${f}`).isDirectory();
        });

        console.log(`📂 ${dirs.length} existing sessions found: ${dirs.join(', ')}`);

        for (const dir of dirs) {
            await createSession(dir, 'unknown');
            await delay(2000);
        }
    }
}

app.listen(PORT, async () => {
    console.log(`
    ╔══════════════════════════════════════╗
    ║  WhatsApp + Groq AI Manager         ║
    ║  Pair Code ONLY - No QR             ║
    ║  Port: ${PORT}                       ║
    ║  AI: Groq (llama-3.3-70b)          ║
    ╚══════════════════════════════════════╝
    `);

    await loadExistingSessions();
});

// Keep alive for Render
if (process.env.RENDER) {
    setInterval(() => {
        require('http').get(`http://localhost:${PORT}/health`, () => { }).on('error', () => { });
    }, 840000);
}
