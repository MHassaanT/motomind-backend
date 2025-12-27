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
// CHANGED: Use dynamic port for Railway
const PORT = process.env.PORT || 8080;

// Specific CORS configuration
app.use(cors({
  origin: 'https://motomind-frontend.vercel.app', // Allow only your frontend
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Optional: only if you start using cookies/sessions
}));

// Explicitly handle OPTIONS preflight for all routes
app.options('*', cors()); 

app.use(express.json());

// ---------------- FIREBASE INITIALIZATION ----------------

// Primary App for Firestore
try {
  const base64Key = process.env.BASE64_SERVICE_ACCOUNT_KEY;
  if (!base64Key) {
    throw new Error("BASE64_SERVICE_ACCOUNT_KEY is missing in environment variables");
  }
  const decodedKey = Buffer.from(base64Key, 'base64').toString('utf-8');
  const serviceAccount = JSON.parse(decodedKey);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("Firebase Admin initialized successfully using Base64 key.");
} catch (error) {
  console.error("Failed to initialize Firebase Admin:", error.message);
  process.exit(1);
}

// Blaze App for Storage Persistence
let bucket = null;
try {
  const blazeKey = process.env.BASE64_BLAZE_SERVICE_ACCOUNT_KEY;
  const bucketName = process.env.BUCKET_NAME;

  if (blazeKey && bucketName) {
    const decodedBlazeKey = Buffer.from(blazeKey, 'base64').toString('utf-8');
    const blazeAccount = JSON.parse(decodedBlazeKey);

    const storageApp = admin.initializeApp({
      credential: admin.credential.cert(blazeAccount),
      storageBucket: bucketName
    }, 'storageApp');

    bucket = storageApp.storage().bucket();
    console.log("Blaze Storage initialized for session persistence.");
  }
} catch (error) {
  console.error("Blaze Storage failed to initialize:", error.message);
}

const db = admin.firestore();
const clients = {}; // userId -> WhatsApp Client instance
const SESSION_PATH = './.wwebjs_auth';

// ---------------- MIDDLEWARE ----------------

async function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------- HELPERS ----------------

function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '92' + cleaned.substring(1);
  }
  if (!cleaned.startsWith('92')) {
    cleaned = '92' + cleaned;
  }
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

// ---------------- PERSISTENCE HELPERS ----------------

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
    console.error(`[${userId}] Backup failed:`, err.message);
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
    console.error(`[${userId}] Restore failed:`, err.message);
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

  // Restore session before initializing
  await restoreSessionFromCloud(userId);

  console.log(`[${userId}] Initializing new WhatsApp client...`);

  const client = new Client({
    puppeteer: { 
      headless: true, 
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ],
      executablePath: process.env.CHROME_PATH || '/usr/bin/chromium'
    },
    authStrategy: new LocalAuth({ 
      clientId: `user-${userId}`,
      dataPath: SESSION_PATH 
    })
  });

  client.on('qr', async (qr) => {
    console.log(`[${userId}] QR Code generated.`);
    const qrImage = await qrcode.toDataURL(qr);
    await db.collection('whatsapp_sessions').doc(userId).set({
      status: 'qr',
      qr: qrImage,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  client.on('ready', async () => {
    console.log(`[${userId}] WhatsApp Client is READY`);
    await db.collection('whatsapp_sessions').doc(userId).set({
      status: 'connected',
      qr: null,
      phoneNumber: client.info.wid.user,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Backup session once ready
    await saveSessionToCloud(userId);
  });

  // ADDED: Listen for disconnection events
  client.on('disconnected', async (reason) => {
    console.log(`[${userId}] WhatsApp Disconnected:`, reason);
    await db.collection('whatsapp_sessions').doc(userId).set({
      status: 'disconnected',
      qr: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    if (clients[userId]) {
      await clients[userId].destroy().catch(() => {});
      delete clients[userId];
    }
  });

  // ADDED: Listen for authentication failures
  client.on('auth_failure', async (msg) => {
    console.error(`[${userId}] Auth failure:`, msg);
    await db.collection('whatsapp_sessions').doc(userId).set({
      status: 'disconnected',
      qr: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  });

  clients[userId] = client;
  
  return new Promise((resolve, reject) => {
    client.initialize().catch(err => reject(err));
    
    const timeout = setTimeout(() => {
        if (client.info) resolve(client);
    }, 5000);

    client.once('ready', () => {
        clearTimeout(timeout);
        resolve(client);
    });

    client.once('auth_failure', (msg) => {
        reject(new Error('Auth failure: ' + msg));
    });
  });
}

// ---------------- HEALTH CHECK ----------------
app.get('/', (req, res) => {
  res.status(200).send('MotoMind Backend is Running');
});


// ---------------- API ENDPOINTS ----------------

app.get('/api/whatsapp/status', verifyToken, async (req, res) => {
  const userId = req.user.uid;
  const doc = await db.collection('whatsapp_sessions').doc(userId).get();
  
  let data = doc.exists ? doc.data() : { status: 'disconnected', qr: null };

  // ADDED: Sync logic if server restarted and memory was cleared
  if (data.status === 'connected' && !clients[userId]) {
    data.status = 'disconnected';
    await db.collection('whatsapp_sessions').doc(userId).update({ status: 'disconnected' });
  }

  res.json(data);
});

app.post('/api/whatsapp/connect', verifyToken, async (req, res) => {
  try {
    getOrCreateClient(req.user.uid); // Run in background
    res.json({ message: 'Initializing WhatsApp...' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger connection' });
  }
});

app.post('/api/whatsapp/clear-qr', verifyToken, async (req, res) => {
  const userId = req.user.uid;
  try {
    if (clients[userId]) {
      await clients[userId].destroy();
      delete clients[userId];
    }
    await db.collection('whatsapp_sessions').doc(userId).delete();
    // Also remove from cloud storage if cleared
    if (bucket) await bucket.file(`whatsapp-sessions/${userId}.zip`).delete().catch(() => {});
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear session' });
  }
});

app.post('/api/records', verifyToken, async (req, res) => {
  try {
    const recordData = {
      ...req.body,
      userId: req.user.uid,
      finalized: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const docRef = await db.collection('serviceRecords').add(recordData);
    res.status(201).json({ id: docRef.id, message: 'Record created successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create record' });
  }
});

app.get('/api/records', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('serviceRecords')
      .where('userId', '==', req.user.uid)
      .get();

    const records = [];
    snapshot.forEach(doc => records.push({ id: doc.id, ...doc.data() }));
    res.json({ records });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

app.post('/api/records/:id/finalize', verifyToken, async (req, res) => {
  try {
    const docRef = db.collection('serviceRecords').doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ error: 'Record not found' });
    if (doc.data().userId !== req.user.uid) return res.status(403).json({ error: 'Unauthorized' });

    await docRef.update({
      finalized: true,
      finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Record finalized successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to finalize record' });
  }
});

app.post('/api/records/:id/send', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const docRef = db.collection('serviceRecords').doc(req.params.id);
    const doc = await docRef.get();
    
    if (!doc.exists) return res.status(404).json({ error: 'Record not found' });
    
    const record = doc.data();
    if (record.userId !== userId) return res.status(403).json({ error: 'Unauthorized' });
    if (!record.finalized) return res.status(400).json({ error: 'Record must be finalized before sending' });

    const chatId = formatPhoneNumber(record.phone);
    const billMessage = generateBillMessage(record);
    
    let whatsappSent = false;
    let whatsappError = null;

    try {
        const client = await getOrCreateClient(userId);
        if (client && client.info) {
          await client.sendMessage(chatId, billMessage);
          whatsappSent = true;
        } else {
          whatsappError = "WhatsApp client not connected or ready";
        }
    } catch (err) {
        whatsappError = err.message;
    }

    await docRef.update({
      billSentAt: admin.firestore.FieldValue.serverTimestamp(),
      billSentCount: admin.firestore.FieldValue.increment(1),
      lastBillAttempt: {
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        whatsappSent: whatsappSent,
        error: whatsappError
      }
    });

    res.json({ success: whatsappSent, message: whatsappSent ? 'Bill sent!' : 'Failed', error: whatsappError });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process bill' });
  }
});

// ---------------- CRON JOB (REMINDERS WITH AUTO-INIT) ----------------

cron.schedule('0 9 * * *', async () => {
  console.log('🔄 Running daily service reminders check...');
  const today = new Date().toISOString().split('T')[0];

  try {
    const snapshot = await db.collection('serviceRecords')
      .where('nextServiceDate', '==', today)
      .where('finalized', '==', true)
      .get();

    if (snapshot.empty) {
      console.log('📅 No service records due today.');
      return;
    }

    for (const doc of snapshot.docs) {
      const record = doc.data();
      const userId = record.userId;
      
      try {
        const client = await getOrCreateClient(userId);

        if (client && client.info) {
          const chatId = formatPhoneNumber(record.phone);
          const reminderMsg = `🔔 *Service Reminder*\n\nHello ${record.name}!\nYour ${record.bikeType} is due for service today. Last service was on ${record.currentDate}.\n\nPlease visit us for maintenance.`;
          
          await client.sendMessage(chatId, reminderMsg);
          await db.collection('serviceRecords').doc(doc.id).update({
            reminderSentAt: admin.firestore.FieldValue.serverTimestamp()
          });
          console.log(`✅ Reminder sent for ${record.name}`);
        }
      } catch (err) {
        console.error(`❌ Failed reminder for ${record.name}:`, err.message);
      }
    }
  } catch (error) {
    console.error('Cron Job Error:', error);
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
