# UniPods Hackathon — WhatsApp Group Context Bot

A WhatsApp bot that cuts down on group spam by automatically answering
project-related questions using the group's own chat history and official
announcements as context. Ask it with `!ask <question>` in any group it's
in, and it retrieves relevant prior messages and generates an answer with
Gemini — scoped strictly to that group, so nothing leaks between groups.

**Stack:** [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) for the WhatsApp Web connection, [`@google/genai`](https://github.com/googleapis/js-genai) for Gemini generation. Deployed on [Railway](https://railway.app).

---

## How it works (quick tour for judges)

| Requirement | Where it lives in `index.js` |
|---|---|
| Persistent WhatsApp session | `useMultiFileAuthState('/app/auth_info')`, mounted to a Railway volume |
| Auto-reconnect | `connection.update` handler — reconnects on any drop except an explicit logout |
| Multi-tenant context isolation | Every retrieval call is filtered by `remoteJid` (`retrieveRelevantContext`) — see the mock DB section, structured for a drop-in real vector DB |
| `!ask` command | `handleGroupMessage()` — retrieves context, then calls Gemini |
| Gemini generation | `generateAnswer()` — model `gemini-flash-latest` via `@google/genai` |
| Auto-join via invite link | `handleDirectMessage()` — detects `chat.whatsapp.com/<code>` in a DM and calls `sock.groupAcceptInvite(code)` |
| New-group detection | `group-participants.update` listener — logs the group and initializes its DB partition when the bot itself is added |

The vector DB is mocked (in-memory, keyword-overlap "retrieval") so the
demo runs with zero external dependencies. The retrieval function's
signature and the group-scoping logic are written exactly as they'd be
used against a real vector DB (Pinecone, Qdrant, pgvector, etc.) — swap
the body of `retrieveRelevantContext()` and `storeMessageForGroup()` for
real calls and everything else keeps working unchanged.

---

## Setup for judges (local or Railway)

### 1. Clone the repo

```bash
git clone <your-repo-url>
cd <your-repo-folder>
npm install
```

### 2. Get a Gemini API key

Grab a free key from [Google AI Studio](https://aistudio.google.com/apikey).

### 3. Configure environment variables

Create a `.env` file locally for testing (never commit this — it's in
`.gitignore`):

```bash
GEMINI_API_KEY=your_key_here
```

### 4. Run locally (optional, to sanity-check before deploying)

```bash
npm start
```

A QR code will render directly in your terminal. Scan it with
**WhatsApp → Linked Devices → Link a Device** on your phone.

---

## Deploying to Railway

### Step 1 — Create the project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Select this repository. Railway will auto-detect Node.js and run `npm install` + `npm start`.

### Step 2 — Add the environment variable

In the Railway project → **Variables** tab, add:

```
GEMINI_API_KEY = your_key_here
```

### Step 3 — Mount a persistent volume (critical)

WhatsApp session credentials must survive restarts/redeploys, or you'll
have to re-scan the QR code every time.

1. In the Railway service → **Settings → Volumes** → **New Volume**.
2. Set the **mount path** to:
   ```
   /app/auth_info
   ```
3. Redeploy the service so the volume attaches.

### Step 4 — Scan the QR code from Railway logs

1. Open the service's **Deployments → Logs** (or the **Observability** tab).
2. On first boot (no saved session yet), the bot prints a QR code as ASCII
   art directly in the log stream.
3. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device**,
   then scan the QR code shown in the logs.
4. Once linked, the logs will show `Connected to WhatsApp successfully.`
   and the session is now saved to the mounted volume — future restarts
   won't require re-scanning.

### Step 5 — Try it

1. Add the bot's WhatsApp number to a group (or DM it a
   `chat.whatsapp.com/...` invite link and it will auto-join).
2. Let a few messages happen in the group so it has history to work with.
3. Send `!ask <your question>` in the group and watch it reply.

---

## Notes / known limitations (by design, for hackathon scope)

- The vector DB is mocked with an in-memory store and naive keyword
  matching — swap `retrieveRelevantContext()` / `storeMessageForGroup()`
  for a real embedding + vector search integration for production use.
- In-memory history resets on redeploy (only the WhatsApp *session*
  persists via the volume, not the mock chat history) — expected, since a
  real deployment would back this with a persistent vector DB instead.
- Uses WhatsApp's unofficial Web protocol via Baileys; keep the linked
  device active and avoid running multiple bot instances on the same
  session simultaneously.
