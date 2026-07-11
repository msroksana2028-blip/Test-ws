// ============================================
// WhatsApp Multi-Account Manager v2.0
// Firebase DB + Groq AI + Web Dashboard
// ============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const admin = require('firebase-admin');

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

// ============================================
// CONFIGURATION
// ============================================

const GROQ_API_KEY = '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';
const PORT = process.env.PORT || 10000;
const SESSIONS_DIR = process.env.RENDER ? '/tmp/sessions' : './sessions';

// Firebase Admin SDK (আপনাকে Firebase project create করতে হবে)
// Firebase Console → Project Settings → Service Accounts → Generate New Private Key
let db;

try {
    // Render এ Environment Variable হিসেবে Firebase credentials দিন
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : require('./firebase-credentials.json');

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DB_URL
    });
    
    db = admin.firestore();
    console.log('🔥 Firebase Connected');
} catch (err) {
    console.log('⚠️ Firebase not configured, using local storage');
    db = null;
}

// ============================================
// GROQ AI
// ============================================

const groq = new Groq({ apiKey: GROQ_API_KEY });

// ============================================
// EXPRESS SETUP
// ============================================

const app = express();

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// IN-MEMORY STORE
// ============================================

const sessions = new Map(); // sock instances
const sessionStates = new Map(); // current status
const messageCounts = new Map(); // message count per session
const aiSettings = new Map(); // AI on/off per session

// ============================================
// FIREBASE HELPERS
// ============================================

async function saveToFirebase(collection, docId, data) {
    if (!db) return;
    try {
        await db.collection(collection).doc(docId).set(data, { merge: true });
    } catch (err) {
        console.error('Firebase save error:', err.message);
    }
}

async function getFromFirebase(collection, docId) {
    if (!db) return null;
    try {
        const doc = await db.collection(collection).doc(docId).get();
        return doc.exists ? doc.data() : null;
    } catch (err) {
        console.error('Firebase get error:', err.message);
        return null;
    }
}

async function getAllFromFirebase(collection) {
    if (!db) return [];
    try {
        const snapshot = await db.collection(collection).get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (err) {
        console.error('Firebase get all error:', err.message);
        return [];
    }
}

// ============================================
// AI REPLY (bot.js স্টাইল - টাইপিং ইফেক্ট সহ)
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
        // Fallback
        try { await sock.sendMessage(jid, { text }); } catch (e) {}
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
    // Check AI enabled
    const aiEnabled = aiSettings.get(sessionId);
    if (aiEnabled === false) return; // AI OFF

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

    // Message count
    const count = (messageCounts.get(sessionId) || 0) + 1;
    messageCounts.set(sessionId, count);

    // Save to Firebase
    await saveToFirebase('messages', `${sessionId}_${Date.now()}`, {
        sessionId,
        from: sender,
        to: botInfo.phone,
        text: text,
        time: new Date().toISOString(),
        direction: 'received',
        userName: userInfo.name,
        botName: botInfo.name
    });

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

        // Save reply to Firebase
        await saveToFirebase('messages', `${sessionId}_${Date.now()}_reply`, {
            sessionId,
            from: botInfo.phone,
            to: sender,
            text: reply,
            time: new Date().toISOString(),
            direction: 'sent',
            userName: userInfo.name,
            botName: botInfo.name
        });

    } catch (err) {
        console.error('❌ Groq Error:', err.message);
        const errorMsg = language === 'bn' ?
            'এই মুহূর্তে একটু সমস্যা হচ্ছে, পরে কথা বলি!' :
            'Having a small issue right now, talk later!';
        await sendWithTyping(sock, sender, errorMsg);
    }
}

// ============================================
// CREATE SESSION
// ============================================

async function createSession(sessionId, phoneNumber) {
    const authPath = `${SESSIONS_DIR}/${sessionId}`;
    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        syncFullHistory: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            const phone = sock.user?.id?.split(':')[0] || phoneNumber;
            const name = sock.user?.name || phone;

            sessionStates.set(sessionId, {
                status: 'connected',
                phone,
                name,
                connectedAt: new Date().toISOString()
            });

            // Default AI ON
            if (!aiSettings.has(sessionId)) {
                aiSettings.set(sessionId, true);
            }

            if (!messageCounts.has(sessionId)) {
                messageCounts.set(sessionId, 0);
            }

            // Save to Firebase
            await saveToFirebase('accounts', sessionId, {
                phone,
                name,
                status: 'connected',
                aiEnabled: aiSettings.get(sessionId),
                messageCount: messageCounts.get(sessionId),
                connectedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });

            console.log(`✅ Connected: ${name} (${phone}) - AI: ${aiSettings.get(sessionId) ? 'ON' : 'OFF'}`);
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

                await saveToFirebase('accounts', sessionId, {
                    status: 'disconnected',
                    updatedAt: new Date().toISOString()
                });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (msg.key.remoteJid === 'status@broadcast') continue;
                if (msg.key.fromMe) continue;
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
// ============================================
// 📡 API ENDPOINTS
// ============================================
// ============================================

// 1. HEALTH CHECK
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        totalAccounts: sessionStates.size,
        connectedAccounts: Array.from(sessionStates.values()).filter(s => s.status === 'connected').length
    });
});

// 2. PAIR CODE - নতুন অ্যাকাউন্ট যোগ
app.post('/api/pair', async (req, res) => {
    try {
        let { phone } = req.body;
        if (!phone) return res.json({ success: false, error: 'Phone number required' });

        phone = phone.replace(/\D/g, '');
        const sessionId = uuidv4();

        sessionStates.set(sessionId, { status: 'initializing', phone });
        aiSettings.set(sessionId, true); // Default AI ON

        const sock = await createSession(sessionId, phone);
        await delay(2000);

        const code = await sock.requestPairingCode(phone);
        console.log(`🔑 Code: ${code} for ${phone}`);

        sessionStates.set(sessionId, {
            status: 'pair_ready',
            pairCode: code,
            phone
        });

        res.json({
            success: true,
            code,
            sessionId,
            phone,
            message: 'Enter this 8-digit code in WhatsApp > Linked Devices > Link Device'
        });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// 3. ALL ACCOUNTS
app.get('/api/accounts', async (req, res) => {
    const accounts = [];
    
    sessionStates.forEach((state, id) => {
        accounts.push({
            id,
            phone: state.phone || 'Unknown',
            name: state.name || 'Unknown',
            status: state.status || 'unknown',
            aiEnabled: aiSettings.get(id) ?? true,
            messageCount: messageCounts.get(id) || 0,
            connectedAt: state.connectedAt || null
        });
    });

    // Also get from Firebase if available
    if (db) {
        const fbAccounts = await getAllFromFirebase('accounts');
        // Merge with live data
        for (const fbAcc of fbAccounts) {
            if (!accounts.find(a => a.id === fbAcc.id)) {
                accounts.push(fbAcc);
            }
        }
    }

    res.json(accounts);
});

// 4. SINGLE ACCOUNT STATUS
app.get('/api/account/:id', (req, res) => {
    const state = sessionStates.get(req.params.id);
    if (!state) return res.json({ status: 'not_found' });

    res.json({
        id: req.params.id,
        phone: state.phone,
        name: state.name,
        status: state.status,
        aiEnabled: aiSettings.get(req.params.id) ?? true,
        messageCount: messageCounts.get(req.params.id) || 0,
        connectedAt: state.connectedAt
    });
});

// 5. SEND MESSAGE
app.post('/api/send', async (req, res) => {
    try {
        const { id, to, text } = req.body;
        if (!id || !to || !text) return res.json({ success: false, error: 'Missing fields' });

        const sock = sessions.get(id);
        if (!sock) return res.json({ success: false, error: 'Account not connected' });

        const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
        const result = await sock.sendMessage(jid, { text });

        // Count
        const count = (messageCounts.get(id) || 0) + 1;
        messageCounts.set(id, count);

        // Save to Firebase
        await saveToFirebase('messages', `${id}_${Date.now()}`, {
            sessionId: id,
            to: jid,
            text,
            time: new Date().toISOString(),
            direction: 'sent'
        });

        // Update account count
        await saveToFirebase('accounts', id, {
            messageCount: count,
            updatedAt: new Date().toISOString()
        });

        res.json({ success: true, messageId: result.key.id });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// 6. GET MESSAGES
app.get('/api/messages/:id', async (req, res) => {
    let messages = [];
    
    if (db) {
        const fbMessages = await getAllFromFirebase('messages');
        messages = fbMessages.filter(m => m.sessionId === req.params.id)
            .sort((a, b) => new Date(b.time) - new Date(a.time))
            .slice(0, 100);
    }

    res.json({
        sessionId: req.params.id,
        count: messages.length,
        messages
    });
});

// 7. AI TOGGLE (ON/OFF per account)
app.post('/api/ai-toggle', async (req, res) => {
    const { id, enabled } = req.body;
    
    if (!id) return res.json({ success: false, error: 'Account ID required' });

    aiSettings.set(id, enabled === true || enabled === 'true');

    await saveToFirebase('accounts', id, {
        aiEnabled: aiSettings.get(id),
        updatedAt: new Date().toISOString()
    });

    res.json({
        success: true,
        id,
        aiEnabled: aiSettings.get(id),
        message: `AI ${aiSettings.get(id) ? 'ON ✅' : 'OFF ❌'}`
    });
});

// 8. TOTAL MESSAGE COUNT
app.get('/api/stats', async (req, res) => {
    let totalMessages = 0;
    let totalAccounts = sessionStates.size;
    let connectedAccounts = 0;

    sessionStates.forEach((state, id) => {
        totalMessages += messageCounts.get(id) || 0;
        if (state.status === 'connected') connectedAccounts++;
    });

    res.json({
        totalAccounts,
        connectedAccounts,
        totalMessages,
        aiEnabledAccounts: Array.from(aiSettings.values()).filter(v => v === true).length
    });
});

// 9. DISCONNECT
app.post('/api/disconnect/:id', async (req, res) => {
    try {
        const sock = sessions.get(req.params.id);
        if (sock) { await sock.logout(); await sock.end(); }

        sessions.delete(req.params.id);
        sessionStates.delete(req.params.id);

        await saveToFirebase('accounts', req.params.id, {
            status: 'disconnected',
            updatedAt: new Date().toISOString()
        });

        res.json({ success: true });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// 10. BULK SEND (একসাথে অনেক Account থেকে মেসেজ)
app.post('/api/bulk-send', async (req, res) => {
    try {
        const { ids, to, text } = req.body;
        if (!ids || !to || !text) return res.json({ success: false, error: 'Missing fields' });

        const results = [];
        for (const id of ids) {
            const sock = sessions.get(id);
            if (sock) {
                try {
                    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
                    await sock.sendMessage(jid, { text });
                    results.push({ id, success: true });
                } catch (e) {
                    results.push({ id, success: false, error: e.message });
                }
            } else {
                results.push({ id, success: false, error: 'Not connected' });
            }
        }

        res.json({ success: true, results });

    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// 11. GET AI PROMPT SETTINGS
app.get('/api/ai-prompt/:id', (req, res) => {
    const state = sessionStates.get(req.params.id);
    if (!state) return res.json({ error: 'Account not found' });

    res.json({
        id: req.params.id,
        name: state.name,
        phone: state.phone,
        aiEnabled: aiSettings.get(req.params.id) ?? true,
        model: 'llama-3.3-70b-versatile'
    });
});

// ============================================
// SERVE DASHBOARD
// ============================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START
// ============================================

async function loadSessions() {
    // Load from Firebase
    if (db) {
        const fbAccounts = await getAllFromFirebase('accounts');
        for (const acc of fbAccounts) {
            if (acc.status === 'connected') {
                aiSettings.set(acc.id, acc.aiEnabled ?? true);
                messageCounts.set(acc.id, acc.messageCount || 0);
            }
        }
    }

    // Load local sessions
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
    console.log(`
    ╔══════════════════════════════════════╗
    ║  WhatsApp Multi-Account Manager     ║
    ║  Firebase DB + Groq AI             ║
    ║  Port: ${PORT}                       ║
    ║  API Endpoints: 11                 ║
    ╚══════════════════════════════════════╝
    `);
    await loadSessions();
});

// Keep alive
if (process.env.RENDER) {
    setInterval(() => {
        require('http').get(`http://localhost:${PORT}/health`, () => {}).on('error', () => {});
    }, 840000);
}
