/**
 * UniPods Hackathon — WhatsApp Group Context Bot
 * ------------------------------------------------
 * Reduces group spam by answering project-related questions using
 * previous chat history + official announcements as retrieval context.
 *
 * Stack: @whiskeysockets/baileys (WhatsApp Web protocol)
 *        @google/genai           (Gemini generation)
 *
 * Deployment target: Railway, with a persistent volume mounted at
 * /app/auth_info so the WhatsApp session survives restarts/redeploys.
 */

import 'dotenv/config';
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUTH_DIR = process.env.AUTH_DIR || '/app/auth_info';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const ASK_TRIGGER = '!ask';
const INVITE_LINK_REGEX = /chat\.whatsapp\.com\/([A-Za-z0-9]+)/i;

if (!GEMINI_API_KEY) {
  // Fail fast and loud — this is required for the bot's core function.
  console.error('FATAL: GEMINI_API_KEY environment variable is not set.');
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ---------------------------------------------------------------------------
// Mock "database" layer
// ---------------------------------------------------------------------------
// In production these would be a real vector store (e.g. Pinecone, Qdrant,
// pgvector) partitioned per WhatsApp group. The structural contract below —
// strict filtering by remoteJid — is what actually matters for the
// multi-tenant requirement, so every real implementation MUST preserve it.

/**
 * In-memory placeholder for "official announcements + recent chat history"
 * per group. Keyed by remoteJid so no group's data ever leaks into another
 * group's retrieval results.
 *
 * Shape: { [remoteJid]: Array<{ text: string, sender: string, ts: number }> }
 */
const mockGroupStore = {};

/**
 * Call this for every incoming group message so it becomes part of that
 * group's retrievable history. Swap this out for an "embed + upsert into
 * vector DB with metadata.groupId = remoteJid" call in production.
 */
function storeMessageForGroup(remoteJid, { text, sender, ts }) {
  if (!mockGroupStore[remoteJid]) mockGroupStore[remoteJid] = [];
  mockGroupStore[remoteJid].push({ text, sender, ts });
  // Keep the mock store bounded; a real vector DB has no such limit.
  if (mockGroupStore[remoteJid].length > 500) {
    mockGroupStore[remoteJid].shift();
  }
}

/**
 * Retrieve context for a `!ask` query, STRICTLY scoped to the asking
 * group's remoteJid. This is the function to replace with a real vector
 * similarity search, e.g.:
 *
 *   const results = await vectorDb.query({
 *     vector: await embed(query),
 *     filter: { groupId: { $eq: remoteJid } },
 *     topK: 5,
 *   });
 *
 * The filter-by-remoteJid step is non-negotiable: it is what prevents one
 * group's private discussion from leaking into another group's answers.
 */
async function retrieveRelevantContext(remoteJid, query) {
  const groupHistory = mockGroupStore[remoteJid] || [];

  // --- MOCK RETRIEVAL LOGIC ---
  // Naive keyword overlap standing in for real embedding similarity search.
  // Replace this block with an actual vector DB call; keep the remoteJid
  // filter as the first-class constraint on whatever replaces it.
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = groupHistory
    .map((msg) => {
      const lower = msg.text.toLowerCase();
      const score = queryTerms.reduce(
        (acc, term) => acc + (lower.includes(term) ? 1 : 0),
        0
      );
      return { ...msg, score };
    })
    .filter((msg) => msg.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return scored.map((msg) => msg.text);
}

/**
 * Called when the bot is added to a brand-new group. In production this is
 * where you'd initialize a new namespace/partition/collection in the real
 * vector DB so the group's history starts isolated from day one.
 */
function initGroupPartition(remoteJid) {
  if (!mockGroupStore[remoteJid]) {
    mockGroupStore[remoteJid] = [];
    logger.info({ remoteJid }, 'Initialized new group partition (mock DB)');
    // TODO: await vectorDb.createNamespace(remoteJid) or equivalent.
  }
}

// ---------------------------------------------------------------------------
// Gemini generation
// ---------------------------------------------------------------------------

async function generateAnswer(question, contextChunks) {
  const contextBlock = contextChunks.length
    ? contextChunks.map((c, i) => `[${i + 1}] ${c}`).join('\n')
    : 'No relevant prior messages or announcements were found for this group.';

  const prompt = `You are a helpful assistant embedded in a WhatsApp project group. Your job is to answer participants' questions using ONLY the context below (prior group chat history and official announcements). If the context does not contain the answer, say so plainly and suggest asking an admin — do not make up information.

Context:
${contextBlock}

Question: ${question}

Give a short, direct WhatsApp-friendly answer.`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  });

  return response.text?.trim() || "I couldn't generate an answer for that.";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessageText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  );
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

// ---------------------------------------------------------------------------
// Main connection logic
// ---------------------------------------------------------------------------

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Using Baileys version');

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // we handle QR rendering ourselves for clean Railway logs
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['UniPods Hackathon Bot', 'Chrome', '1.0.0'],
  });

  // Persist credentials whenever they change.
  sock.ev.on('creds.update', saveCreds);

  // --- Connection lifecycle: QR display + auto-reconnect ---
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Scan this QR code with WhatsApp to authenticate:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      logger.warn(
        { statusCode, loggedOut },
        'Connection closed. Reconnecting unless logged out...'
      );

      if (!loggedOut) {
        // Auto-reconnect on any drop that isn't an explicit logout.
        connectToWhatsApp();
      } else {
        logger.error(
          'Session logged out. Delete the auth_info volume contents and re-scan the QR code.'
        );
      }
    } else if (connection === 'open') {
      logger.info('Connected to WhatsApp successfully.');
    }
  });

  // --- Requirement 5: Admin additions — log when bot is added to a group ---
  sock.ev.on('group-participants.update', async (event) => {
    const { id: remoteJid, participants, action } = event;
    const botJid = sock.user?.id?.split(':')[0];

    if (action === 'add' && botJid) {
      const wasBotAdded = participants.some((p) => p.split(':')[0] === botJid);
      if (wasBotAdded) {
        logger.info(
          { remoteJid },
          'Bot was added to a new group — initializing DB partition.'
        );
        initGroupPartition(remoteJid);
        try {
          await sock.sendMessage(remoteJid, {
            text: `👋 Hi! I've joined this group. Send "${ASK_TRIGGER} <your question>" and I'll try to answer using this group's chat history and announcements.`,
          });
        } catch (err) {
          logger.error({ err, remoteJid }, 'Failed to send group welcome message');
        }
      }
    }
  });

  // --- Message handling: !ask in groups, auto-join via DM invite links ---
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        const text = extractMessageText(msg).trim();
        if (!remoteJid || !text) continue;

        if (isGroupJid(remoteJid)) {
          await handleGroupMessage(sock, remoteJid, text, msg);
        } else {
          await handleDirectMessage(sock, remoteJid, text);
        }
      } catch (err) {
        logger.error({ err }, 'Error handling incoming message');
      }
    }
  });

  return sock;
}

// ---------------------------------------------------------------------------
// Group message handler — Requirements 2 & 3
// ---------------------------------------------------------------------------

async function handleGroupMessage(sock, remoteJid, text, msg) {
  const sender = msg.key.participant || remoteJid;
  const ts = (msg.messageTimestamp && Number(msg.messageTimestamp) * 1000) || Date.now();

  // Every group message — not just !ask queries — feeds the group's history
  // so future questions have something to retrieve against.
  storeMessageForGroup(remoteJid, { text, sender, ts });

  if (!text.toLowerCase().startsWith(ASK_TRIGGER)) return;

  const question = text.slice(ASK_TRIGGER.length).trim();
  if (!question) {
    await sock.sendMessage(remoteJid, {
      text: `Usage: ${ASK_TRIGGER} <your question>`,
    });
    return;
  }

  logger.info({ remoteJid, question }, 'Handling !ask query');

  try {
    // Strictly filtered by remoteJid — see retrieveRelevantContext() above.
    const context = await retrieveRelevantContext(remoteJid, question);
    const answer = await generateAnswer(question, context);

    await sock.sendMessage(
      remoteJid,
      { text: answer },
      { quoted: msg }
    );
  } catch (err) {
    logger.error({ err, remoteJid }, 'Failed to answer !ask query');
    await sock.sendMessage(remoteJid, {
      text: "Sorry, I couldn't process that question right now.",
    });
  }
}

// ---------------------------------------------------------------------------
// Direct message handler — Requirement 4 (auto-join via invite link)
// ---------------------------------------------------------------------------

async function handleDirectMessage(sock, remoteJid, text) {
  const match = text.match(INVITE_LINK_REGEX);
  if (!match) return;

  const inviteCode = match[1];
  logger.info({ remoteJid, inviteCode }, 'Invite link detected in DM — attempting to join group');

  try {
    const joinedGroupId = await sock.groupAcceptInvite(inviteCode);
    logger.info({ joinedGroupId }, 'Successfully joined group via invite link');
    initGroupPartition(joinedGroupId);

    await sock.sendMessage(remoteJid, {
      text: `✅ Joined the group successfully! I'll start listening there for "${ASK_TRIGGER}" questions.`,
    });
  } catch (err) {
    logger.error({ err, inviteCode }, 'Failed to join group via invite link');
    await sock.sendMessage(remoteJid, {
      text: "⚠️ I couldn't join that group — the invite link may be invalid, expired, or I may already be a member.",
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

   connectToWhatsApp().catch((err) => {
     console.error('FATAL ERROR STARTING BOT:');
     console.error(err && err.stack ? err.stack : err);
     process.exit(1);
   });

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
});

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection');
});
