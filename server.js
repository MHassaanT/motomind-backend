const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 8080;

// ---------------- FIREBASE INITIALIZATION ----------------

// 1. Primary App (Firestore/Auth)
try {
  const base64Key = process.env.BASE64_SERVICE_ACCOUNT_KEY;
  if (!base64Key) throw new Error("BASE64_SERVICE_ACCOUNT_KEY is missing");
  const decodedKey = Buffer.from(base64Key, 'base64').toString('utf-8');
  const serviceAccount = JSON.parse(decodedKey);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  }, 'primary');
  console.log("Primary Firebase (Firestore) initialized.");
} catch (error) {
  console.error("Primary Firebase Error:", error.message);
  process.exit(1);
}

// 2. Storage App (Blaze Project for Session Storage)
try {
  const blazeBase64 = process.env.BASE64_BLAZE_SERVICE_ACCOUNT_KEY;
  const bucketName = process.env.BUCKET_NAME;
  
  if (blazeBase64 && bucketName) {
    const blazeDecoded = Buffer.from(blazeBase64, 'base64').toString('utf-8');
    const blazeAccount = JSON.parse(blazeDecoded);

    admin.initializeApp({
      credential: admin.credential.cert(blazeAccount),
      storageBucket: bucketName
    }, 'storage');
    console.log("Blaze Firebase (Storage) initialized.");
  }
} catch (error) {
  console.warn("Blaze Storage not initialized. Sessions will not be persistent.");
}

const db = admin.app('primary').firestore();
const bucket = admin.apps.find(app => app.name === 'storage') 
               ? admin.app('storage').storage().bucket() 
               : null;

const clients = {}; 
const SESSION_PATH = './.wwebjs_auth';

// ---------------- MIDDLEWARE ----------------

app.use(cors({
  origin: 'https://motomind-frontend.vercel.app',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true 
}));

app.options('*', cors()); 
app.use(express.json());

async function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decodedToken = await admin.app('primary').auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------- HELPERS ----------------

function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '92' + cleaned.substring(1);
  if (!cleaned.startsWith('92')) cleaned = '92' + cleaned;
  return cleaned + '@c.us';
}

function generateBillMessage(record) {
  const servicesPerformed = record.services?.join(', ') || 'None';
  return `
╔════════════════════════════╗
      🏍️ SERVICE BILL 🏍️
╚════════════════════════════╝

📋 *Customer Details*
👤 Name: ${record.name}
📞 Phone: ${record.phone}
🏍️ Bike: ${record.bikeType}
📏 KM Reading: ${record.kmReading}

📅 *Service Date*
Date: ${record.currentDate}
Next Service: ${record.nextServiceDate}

✅ *Services Performed*
${servicesPerformed}

💰 *Charges*
Labor: Rs. ${record.laborCharges}
Parts: Rs. ${record.partsCharges}
━━━━━━━━━━━━━━━━━━━
*TOTAL: Rs. ${record.totalAmount}*

${record.notes ? '\n📝 *Notes*\n' + record.notes + '\n' : ''}
━━━━━━━━━━━━━━━━━━━
Thank you for choosing us!

🔧 *Rafi Auto Service*
Atlas Honda Verified Antenna Dealership
  `.trim();
}

// ---------------- CLOUD SESSION SYNC ----------------

async function saveSessionToCloud(userId) {
  if (!bucket) return;
  try {
    const userSessionDir = path.join(SESSION_PATH, `session-user-${userId}`);
    if (!fs.existsSync(userSessionDir)) return;

    const zip = new AdmZip();
    zip.addLocalFolder(userSessionDir);
    const buffer = zip.toBuffer();

    const file = bucket.file(`whatsapp-sessions/${userId}.zip`);
    await file.save(buffer);
    console.log(`[${userId}] Session backed up to Blaze Storage.`);
  } catch (err) {
    console.error(`[${userId}] Cloud Backup Error:`, err.message);
  }
}

async function restoreSessionFromCloud(userId) {
  if (!bucket) return false;
  try {
    const file = bucket.file(`whatsapp-sessions/${userId}.zip`);
    const [exists] = await file.exists();
    if (!exists) return false;

    const [buffer] = await file.download();
    const zip = new AdmZip(buffer);
    const userSessionDir = path.join(SESSION_PATH, `session-user-${userId}`);
    
    if (!fs.existsSync(userSessionDir)) fs.mkdirSync(userSessionDir, { recursive: true });
    zip.extractAllTo(userSessionDir, true);
    console.log(`[${userId}] Session restored from Blaze Storage.`);
    return true;
  } catch (err) {
    console.error(`[${userId}] Cloud Restore Error:`, err.message);
    return false;
  }
}

// ---------------- WHATSAPP LOGIC ----------------

async function getOrCreateClient(userId) {
  if (clients[userId]) {
    try {
      const state = await clients[userId].getState();
      console.log(`[${userId}] Client exists. State: ${state}`);
      if (state === 'CONNECTED') return clients[userId];
    } catch (e) {
      console.log(`[${userId}] Existing client unresponsive. Re-initializing...`);
      delete clients[userId];
    }
  }

  // Restore session from Blaze Cloud before creating client
  await restoreSessionFromCloud(userId);

  const client = new Client({
    puppeteer: { 
      headless: true, 
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu'
      ],
      executablePath: process.env.CHROME_PATH || '/usr/bin/chromium'
    },
    authStrategy: new LocalAuth({ 
      clientId: `user-${userId}`,
      dataPath: SESSION_PATH 
    })
  });

  client.on('qr', async (qr) => {
    const qrImage = await qrcode.toDataURL(qr);
    await db.collection('whatsapp_sessions').doc(userId).set({
      status: 'qr', qr: qrImage, updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  client.on('ready', async () => {
    console.log(`[${userId}] WhatsApp Ready. Syncing to Blaze Cloud...`);
    await db.collection('whatsapp_sessions').doc(userId).set({
      status: 'connected', qr: null, phoneNumber: client.info.wid.user,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    // Sync to Cloud
    await saveSessionToCloud(userId);
  });

  clients[userId] = client;
  
  return new Promise((resolve, reject) => {
    client.initialize().catch(err => reject(err));
    const timeout = setTimeout(() => { if (client.info) resolve(client); }, 10000);
    client.once('ready', () => { clearTimeout(timeout); resolve(client); });
    client.once('auth_failure', (msg) => { reject(new Error('Auth failure: ' + msg)); });
  });
}

// ---------------- API ENDPOINTS ----------------

app.get('/', (req, res) => res.status(200).send('MotoMind Backend (Persistence Enabled) Running'));

app.get('/api/whatsapp/status', verifyToken, async (req, res) => {
  const doc = await db.collection('whatsapp_sessions').doc(req.user.uid).get();
  res.json(doc.exists ? doc.data() : { status: 'disconnected', qr: null });
});

app.post('/api/whatsapp/connect', verifyToken, async (req, res) => {
  getOrCreateClient(req.user.uid).catch(console.error);
  res.json({ message: 'Initializing WhatsApp...' });
});

app.post('/api/whatsapp/clear-qr', verifyToken, async (req, res) => {
  const userId = req.user.uid;
  try {
    if (clients[userId]) { await clients[userId].destroy(); delete clients[userId]; }
    await db.collection('whatsapp_sessions').doc(userId).delete();
    // Optional: Delete from cloud too
    if (bucket) await bucket.file(`whatsapp-sessions/${userId}.zip`).delete().catch(() => {});
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear session' });
  }
});

app.post('/api/records', verifyToken, async (req, res) => {
  try {
    const recordData = { ...req.body, userId: req.user.uid, finalized: false, 
      createdAt: admin.firestore.FieldValue.serverTimestamp(), 
      updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    const docRef = await db.collection('serviceRecords').add(recordData);
    res.status(201).json({ id: docRef.id, message: 'Record created successfully' });
  } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/records', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('serviceRecords').where('userId', '==', req.user.uid).get();
    const records = [];
    snapshot.forEach(doc => records.push({ id: doc.id, ...doc.data() }));
    res.json({ records });
  } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/records/:id/finalize', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('serviceRecords').doc(req.params.id);
    await docRef.update({ finalized: true, finalizedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ message: 'Record finalized' });
  } catch (error) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/records/:id/send', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const doc = await db.collection('serviceRecords').doc(req.params.id).get();
    const record = doc.data();
    
    const client = await getOrCreateClient(userId);
    const chatId = formatPhoneNumber(record.phone);
    await client.sendMessage(chatId, generateBillMessage(record));

    await db.collection('serviceRecords').doc(req.params.id).update({
      billSentAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, message: 'Bill sent!' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ---------------- CRON JOB (REMINDERS) ----------------

cron.schedule('0 9 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const snapshot = await db.collection('serviceRecords')
      .where('nextServiceDate', '==', today)
      .where('finalized', '==', true).get();

    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
      const record = doc.data();
      try {
        const client = await getOrCreateClient(record.userId);
        const chatId = formatPhoneNumber(record.phone);
        const msg = `🔔 *Service Reminder*\n\nHello ${record.name}!\nYour ${record.bikeType} is due for service today.`;
        await client.sendMessage(chatId, msg);
        await db.collection('serviceRecords').doc(doc.id).update({ reminderSentAt: admin.firestore.FieldValue.serverTimestamp() });
      } catch (err) { console.error(`Reminder failed: ${record.name}`, err.message); }
    }
  } catch (err) { console.error('Cron Error:', err); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
