express = require('express');
const http = require('http');
const path = require('path');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active connections
const activeConnections = new Map();

// Get all connected accounts
app.get('/api/accounts', (req, res) => {
    const accounts = [];
    activeConnections.forEach((data, id) => {
        accounts.push({
            id: id,
            phone: data.phone || 'Unknown',
            status: data.status,
            todaySent: data.todaySent || 0,
            dailyLimit: data.dailyLimit || 5
        });
    });
    res.json(accounts);
});

// Connect new WhatsApp account
app.post('/api/connect', async (req, res) => {
    try {
        const { phoneNumber, method } = req.body; // method: 'qr' or 'pairing'
        const accountId = Date.now().toString();
        const sessionPath = path.join(__dirname, 'sessions', accountId);

        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false
        });

        const connectionData = {
            sock: sock,
            phone: phoneNumber || '',
            status: 'connecting',
            todaySent: 0,
            dailyLimit: 5
        };

        activeConnections.set(accountId, connectionData);

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionData.qr = qr;
                connectionData.status = 'qr_ready';
            }

            if (connection === 'open') {
                connectionData.status = 'connected';
                connectionData.phone = sock.user?.id?.split(':')[0] || phoneNumber;
                console.log(`✅ Connected: ${connectionData.phone}`);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === DisconnectReason.loggedOut) {
                    connectionData.status = 'logged_out';
                    activeConnections.delete(accountId);
                    // Clean session files
                    if (fs.existsSync(sessionPath)) {
                        fs.rmSync(sessionPath, { recursive: true, force: true });
                    }
                } else {
                    connectionData.status = 'disconnected';
                }
            }
        });

        // Save credentials
        sock.ev.on('creds.update', saveCreds);

        // Generate pairing code if method is 'pairing'
        if (method === 'pairing' && phoneNumber) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    connectionData.pairingCode = code;
                    connectionData.status = 'pairing_ready';
                } catch (err) {
                    console.error('Pairing error:', err);
                }
            }, 2000);
        }

        res.json({
            success: true,
            accountId: accountId,
            message: method === 'pairing' ? 'Pairing code being generated...' : 'Scan QR code to connect'
        });

    } catch (error) {
        console.error('Connect error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get QR code for an account
app.get('/api/qr/:accountId', (req, res) => {
    const data = activeConnections.get(req.params.accountId);
    if (data && data.qr) {
        res.json({ qr: data.qr, status: data.status });
    } else if (data && data.pairingCode) {
        res.json({ pairingCode: data.pairingCode, status: data.status });
    } else {
        res.json({ status: data?.status || 'not_found' });
    }
});

// Send test message
app.post('/api/send', async (req, res) => {
    try {
        const { accountId, to, message } = req.body;

        const data = activeConnections.get(accountId);
        if (!data || !data.sock || data.status !== 'connected') {
            return res.json({ success: false, error: 'Account not connected' });
        }

        const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
        await data.sock.sendMessage(jid, { text: message });

        data.todaySent = (data.todaySent || 0) + 1;

        res.json({
            success: true,
            message: 'Message sent!',
            todaySent: data.todaySent
        });

    } catch (error) {
        console.error('Send error:', error);
        res.json({ success: false, error: error.message });
    }
});

// Set daily limit
app.post('/api/limit/:accountId', (req, res) => {
    const data = activeConnections.get(req.params.accountId);
    if (data) {
        data.dailyLimit = parseInt(req.body.limit) || 5;
        res.json({ success: true, dailyLimit: data.dailyLimit });
    } else {
        res.status(404).json({ success: false, error: 'Account not found' });
    }
});

// Disconnect account
app.delete('/api/disconnect/:accountId', (req, res) => {
    const data = activeConnections.get(req.params.accountId);
    if (data && data.sock) {
        data.sock.end();
        activeConnections.delete(req.params.accountId);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, error: 'Account not found' });
    }
});

// Homepage
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
