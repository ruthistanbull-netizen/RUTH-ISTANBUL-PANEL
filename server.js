const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

let webPush = null;
try {
  webPush = require("web-push");
} catch (error) {
  webPush = null;
}

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.RUTH_DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const ADMIN_USER = process.env.RUTH_ADMIN_USER || "ruth";
const ADMIN_PASSWORD = process.env.RUTH_ADMIN_PASSWORD || "ruthistanbul";
const SESSION_SECRET = process.env.RUTH_SESSION_SECRET || "change-this-secret-before-live";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:info@ruthistanbul.com";
const SUPABASE_URL = trimSlash(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MAX_IMAGE_BYTES = Number(process.env.RUTH_MAX_IMAGE_BYTES || 2_500_000);
const ADMIN_NOTIFICATION_TITLE = "RUTH ISTANBUL";

fs.mkdirSync(DATA_DIR, { recursive: true });

if (webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

let storage;
let reminderTimer = null;

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (serveStatic(req, res, url)) return;

    if (req.method === "GET" && url.pathname === "/") {
      return redirect(res, "/admin/");
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, {
        ok: true,
        service: "ruth-manual-live-support",
        storage: storage.kind,
        pushReady: Boolean(webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      return handleCustomerMessage(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/chat/updates") {
      return handleCustomerUpdates(url, res);
    }

    if (req.method === "POST" && url.pathname === "/api/event") {
      await readJson(req);
      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      return handleLogin(req, res);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return handleAdminApi(req, res, url);
    }

    sendJson(res, { ok: false, error: "not_found" }, 404);
  } catch (error) {
    console.error("RUTH support error:", error && error.stack ? error.stack : error);
    sendJson(res, { ok: false, error: "server_error" }, 500);
  }
});

async function handleCustomerMessage(req, res) {
  const body = await readJson(req, 4_000_000);
  const sessionId = cleanSessionId(body.sessionId || createId("visitor"));
  const now = new Date().toISOString();
  const text = String(body.message || "").trim().slice(0, 2500);
  const image = sanitizeImage(body.image);
  const pageUrl = String(body.pageUrl || "").slice(0, 1000);
  const pageTitle = String(body.pageTitle || "").slice(0, 300);
  const hintedName = String(body.visitorName || "").trim().slice(0, 80);
  const guessedName = hintedName || guessVisitorName(text);
  const guessedPhone = guessPhone(text);

  if (!text && !image) {
    return sendJson(res, {
      ok: false,
      message: "Mesajınızı alamadık. Lütfen tekrar yazar mısınız?"
    }, 400);
  }

  let conversation = await storage.getConversationBySessionId(sessionId);
  if (!conversation) {
    conversation = await storage.createConversation({
      sessionId,
      visitorName: guessedName,
      visitorPhone: guessedPhone,
      visitorLabel: await storage.nextVisitorLabel(sessionId),
      pageUrl,
      pageTitle,
      status: "open",
      unreadAdminCount: 0,
      lastMessageText: "",
      lastCustomerMessageAt: now,
      lastAdminMessageAt: "",
      createdAt: now,
      updatedAt: now
    });
  }

  const patch = {
    pageUrl: pageUrl || conversation.pageUrl,
    pageTitle: pageTitle || conversation.pageTitle,
    lastCustomerMessageAt: now,
    lastMessageText: text || (image ? "Fotoğraf gönderildi" : ""),
    updatedAt: now,
    status: conversation.status === "closed" ? "open" : conversation.status,
    unreadAdminCount: Number(conversation.unreadAdminCount || 0) + 1
  };

  if (guessedName && !conversation.visitorName) patch.visitorName = guessedName;
  if (guessedPhone && !conversation.visitorPhone) patch.visitorPhone = guessedPhone;

  conversation = await storage.updateConversation(conversation.id, patch);

  const saved = await storage.addMessage({
    conversationId: conversation.id,
    sessionId,
    sender: "customer",
    body: text,
    imageName: image ? image.name : "",
    imageMime: image ? image.mime : "",
    imageData: image ? image.data : "",
    createdAt: now
  });

  await notifyAdmins({
    title: ADMIN_NOTIFICATION_TITLE,
    body: `${displayName(conversation)}: ${text || "Fotoğraf gönderdi"}`,
    url: `/admin/?conversation=${encodeURIComponent(conversation.id)}`,
    tag: `conversation-${conversation.id}`,
    data: { conversationId: conversation.id, messageId: saved.id }
  });

  sendJson(res, {
    ok: true,
    conversationId: conversation.id,
    sessionId,
    serverTime: now,
    message:
      "Mesajınız RUTH ISTANBUL ekibine ulaştı. En kısa sürede buradan dönüş yapacağız."
  });
}

async function handleCustomerUpdates(url, res) {
  const sessionId = cleanSessionId(url.searchParams.get("sessionId") || "");
  const after = String(url.searchParams.get("after") || "");
  if (!sessionId) {
    return sendJson(res, { ok: false, error: "missing_session" }, 400);
  }

  const conversation = await storage.getConversationBySessionId(sessionId);
  if (!conversation) {
    return sendJson(res, { ok: true, messages: [], serverTime: new Date().toISOString() });
  }

  const messages = await storage.listMessages(conversation.id, after);
  const visibleMessages = messages
    .filter((message) => message.sender === "admin" || message.sender === "system")
    .map(publicMessage);

  sendJson(res, {
    ok: true,
    conversationId: conversation.id,
    messages: visibleMessages,
    serverTime: new Date().toISOString()
  });
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return sendJson(res, { ok: false, error: "unauthorized" }, 401);
  }

  const token = signToken({ sub: username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
  sendJson(res, { ok: true, token, user: { username } });
}

async function handleAdminApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/admin/me") {
    return sendJson(res, {
      ok: true,
      user: { username: ADMIN_USER },
      pushReady: Boolean(webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      vapidPublicKey: VAPID_PUBLIC_KEY || ""
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/conversations") {
    const items = await storage.listConversations();
    return sendJson(res, { ok: true, conversations: items.map(adminConversation) });
  }

  const messagesMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/messages$/);
  if (req.method === "GET" && messagesMatch) {
    const conversation = await storage.getConversation(messagesMatch[1]);
    if (!conversation) return sendJson(res, { ok: false, error: "not_found" }, 404);
    const messages = await storage.listMessages(conversation.id);
    const notes = await storage.listNotes(conversation.id);
    return sendJson(res, {
      ok: true,
      conversation: adminConversation(conversation),
      messages: messages.map(adminMessage),
      notes: notes.map(adminNote)
    });
  }

  const replyMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/reply$/);
  if (req.method === "POST" && replyMatch) {
    const body = await readJson(req);
    const text = String(body.message || "").trim().slice(0, 2500);
    if (!text) return sendJson(res, { ok: false, error: "empty_message" }, 400);

    let conversation = await storage.getConversation(replyMatch[1]);
    if (!conversation) return sendJson(res, { ok: false, error: "not_found" }, 404);

    const now = new Date().toISOString();
    const message = await storage.addMessage({
      conversationId: conversation.id,
      sessionId: conversation.sessionId,
      sender: "admin",
      body: text,
      imageName: "",
      imageMime: "",
      imageData: "",
      createdAt: now
    });

    conversation = await storage.updateConversation(conversation.id, {
      lastAdminMessageAt: now,
      lastMessageText: text,
      unreadAdminCount: 0,
      updatedAt: now,
      status: "open"
    });

    return sendJson(res, {
      ok: true,
      conversation: adminConversation(conversation),
      message: adminMessage(message)
    });
  }

  const readMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/read$/);
  if (req.method === "POST" && readMatch) {
    const conversation = await storage.getConversation(readMatch[1]);
    if (!conversation) return sendJson(res, { ok: false, error: "not_found" }, 404);
    const updated = await storage.updateConversation(conversation.id, {
      unreadAdminCount: 0,
      updatedAt: new Date().toISOString()
    });
    return sendJson(res, { ok: true, conversation: adminConversation(updated) });
  }

  const statusMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/status$/);
  if (req.method === "POST" && statusMatch) {
    const body = await readJson(req);
    const nextStatus = body.status === "closed" ? "closed" : "open";
    const conversation = await storage.getConversation(statusMatch[1]);
    if (!conversation) return sendJson(res, { ok: false, error: "not_found" }, 404);
    const updated = await storage.updateConversation(conversation.id, {
      status: nextStatus,
      updatedAt: new Date().toISOString()
    });
    return sendJson(res, { ok: true, conversation: adminConversation(updated) });
  }

  const noteMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/notes$/);
  if (req.method === "POST" && noteMatch) {
    const body = await readJson(req);
    const conversation = await storage.getConversation(noteMatch[1]);
    if (!conversation) return sendJson(res, { ok: false, error: "not_found" }, 404);
    const text = String(body.note || "").trim().slice(0, 3000);
    if (!text) return sendJson(res, { ok: false, error: "empty_note" }, 400);

    const reminderAt = normalizeReminderAt(body.reminderAt);
    const note = await storage.addNote({
      conversationId: conversation.id,
      body: text,
      reminderAt,
      reminderSentAt: "",
      completedAt: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    return sendJson(res, { ok: true, note: adminNote(note) });
  }

  const noteUpdateMatch = pathname.match(/^\/api\/admin\/notes\/([^/]+)$/);
  if (req.method === "PATCH" && noteUpdateMatch) {
    const body = await readJson(req);
    const patch = { updatedAt: new Date().toISOString() };
    if (typeof body.completed === "boolean") {
      patch.completedAt = body.completed ? new Date().toISOString() : "";
    }
    if (body.reminderSeen === true) {
      patch.reminderSentAt = new Date().toISOString();
    }
    if (typeof body.note === "string") {
      patch.body = body.note.trim().slice(0, 3000);
    }
    if (Object.prototype.hasOwnProperty.call(body, "reminderAt")) {
      patch.reminderAt = normalizeReminderAt(body.reminderAt);
      patch.reminderSentAt = "";
    }
    const note = await storage.updateNote(noteUpdateMatch[1], patch);
    if (!note) return sendJson(res, { ok: false, error: "not_found" }, 404);
    return sendJson(res, { ok: true, note: adminNote(note) });
  }

  if (req.method === "GET" && pathname === "/api/admin/reminders/due") {
    const reminders = await storage.listDueReminders(new Date().toISOString());
    return sendJson(res, { ok: true, reminders: reminders.map(adminReminder) });
  }

  if (req.method === "POST" && pathname === "/api/admin/push/subscribe") {
    const body = await readJson(req, 500_000);
    const subscription = body.subscription || body;
    if (!subscription || !subscription.endpoint) {
      return sendJson(res, { ok: false, error: "invalid_subscription" }, 400);
    }
    await storage.savePushSubscription({
      endpoint: String(subscription.endpoint),
      keys: subscription.keys || {},
      userAgent: String(req.headers["user-agent"] || ""),
      createdAt: new Date().toISOString()
    });
    return sendJson(res, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/admin/push/test") {
    await notifyAdmins({
      title: "RUTH ISTANBUL Test",
      body: "Bildirimler çalışıyor.",
      url: "/admin/",
      tag: "ruth-test"
    });
    return sendJson(res, { ok: true });
  }

  sendJson(res, { ok: false, error: "not_found" }, 404);
}

async function notifyAdmins(payload) {
  if (!webPush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;

  const subscriptions = await storage.listPushSubscriptions();
  if (!subscriptions.length) return false;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: subscription.keys || {}
      }, JSON.stringify(payload), { TTL: 60 * 60 * 24 });
    } catch (error) {
      const status = error && (error.statusCode || error.status);
      if (status === 404 || status === 410) {
        await storage.removePushSubscription(subscription.endpoint);
      } else {
        console.error("Push send failed:", error && error.message ? error.message : error);
      }
    }
  }));
  return true;
}

async function checkDueReminders() {
  const due = await storage.listDueReminders(new Date().toISOString());
  for (const note of due) {
    const conversation = await storage.getConversation(note.conversationId);
    if (!conversation) continue;
    const sent = await notifyAdmins({
      title: "RUTH CRM Hatırlatma",
      body: `${displayName(conversation)}: ${note.body}`,
      url: `/admin/?conversation=${encodeURIComponent(conversation.id)}&note=${encodeURIComponent(note.id)}`,
      tag: `reminder-${note.id}`,
      data: { conversationId: conversation.id, noteId: note.id }
    });
    if (sent) {
      await storage.updateNote(note.id, {
        reminderSentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
  }
}

class FileStore {
  constructor(filePath) {
    this.kind = "file";
    this.filePath = filePath;
    this.db = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return normalizeDb(JSON.parse(raw));
    } catch (error) {
      return normalizeDb({});
    }
  }

  save() {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.db, null, 2), "utf8");
    fs.renameSync(tempPath, this.filePath);
  }

  async nextVisitorLabel(sessionId) {
    this.db.counters.visitor += 1;
    this.save();
    return `Ziyaretçi ${this.db.counters.visitor}`;
  }

  async getConversationBySessionId(sessionId) {
    return this.db.conversations.find((item) => item.sessionId === sessionId) || null;
  }

  async getConversation(id) {
    return this.db.conversations.find((item) => item.id === id) || null;
  }

  async createConversation(data) {
    const item = { id: crypto.randomUUID(), ...data };
    this.db.conversations.push(item);
    this.save();
    return item;
  }

  async updateConversation(id, patch) {
    const item = await this.getConversation(id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save();
    return item;
  }

  async listConversations() {
    return [...this.db.conversations].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  async addMessage(data) {
    const item = { id: crypto.randomUUID(), ...data };
    this.db.messages.push(item);
    this.save();
    return item;
  }

  async listMessages(conversationId, after = "") {
    return this.db.messages
      .filter((item) => item.conversationId === conversationId)
      .filter((item) => !after || String(item.createdAt) > after)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async savePushSubscription(data) {
    this.db.pushSubscriptions = this.db.pushSubscriptions.filter((item) => item.endpoint !== data.endpoint);
    this.db.pushSubscriptions.push(data);
    this.save();
  }

  async listPushSubscriptions() {
    return [...this.db.pushSubscriptions];
  }

  async removePushSubscription(endpoint) {
    this.db.pushSubscriptions = this.db.pushSubscriptions.filter((item) => item.endpoint !== endpoint);
    this.save();
  }

  async addNote(data) {
    const item = { id: crypto.randomUUID(), ...data };
    this.db.customerNotes.push(item);
    this.save();
    return item;
  }

  async listNotes(conversationId) {
    return this.db.customerNotes
      .filter((item) => item.conversationId === conversationId)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  async updateNote(id, patch) {
    const item = this.db.customerNotes.find((note) => note.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save();
    return item;
  }

  async listDueReminders(nowIso) {
    return this.db.customerNotes.filter((note) =>
      note.reminderAt &&
      !note.reminderSentAt &&
      !note.completedAt &&
      String(note.reminderAt) <= nowIso
    );
  }
}

class SupabaseStore {
  constructor(url, serviceRoleKey) {
    this.kind = "supabase";
    this.url = url;
    this.serviceRoleKey = serviceRoleKey;
  }

  async request(method, resource, body, options = {}) {
    const response = await fetch(`${this.url}/rest/v1/${resource}`, {
      method,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: options.prefer || "return=representation"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`supabase_${response.status}: ${text.slice(0, 300)}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  async nextVisitorLabel(sessionId) {
    return `Ziyaretçi ${String(sessionId).slice(-6)}`;
  }

  async getConversationBySessionId(sessionId) {
    const rows = await this.request("GET", `conversations?session_id=eq.${encodeURIComponent(sessionId)}&select=*&limit=1`);
    return rows[0] ? fromConversationRow(rows[0]) : null;
  }

  async getConversation(id) {
    const rows = await this.request("GET", `conversations?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
    return rows[0] ? fromConversationRow(rows[0]) : null;
  }

  async createConversation(data) {
    const rows = await this.request("POST", "conversations", toConversationRow(data));
    return fromConversationRow(rows[0]);
  }

  async updateConversation(id, patch) {
    const rows = await this.request("PATCH", `conversations?id=eq.${encodeURIComponent(id)}`, toConversationRow(patch));
    return rows[0] ? fromConversationRow(rows[0]) : null;
  }

  async listConversations() {
    const rows = await this.request("GET", "conversations?select=*&order=updated_at.desc&limit=300");
    return rows.map(fromConversationRow);
  }

  async addMessage(data) {
    const rows = await this.request("POST", "messages", toMessageRow(data));
    return fromMessageRow(rows[0]);
  }

  async listMessages(conversationId, after = "") {
    let query = `messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=*&order=created_at.asc&limit=500`;
    if (after) query = `messages?conversation_id=eq.${encodeURIComponent(conversationId)}&created_at=gt.${encodeURIComponent(after)}&select=*&order=created_at.asc&limit=500`;
    const rows = await this.request("GET", query);
    return rows.map(fromMessageRow);
  }

  async savePushSubscription(data) {
    await this.request("DELETE", `push_subscriptions?endpoint=eq.${encodeURIComponent(data.endpoint)}`, undefined, { prefer: "return=minimal" });
    await this.request("POST", "push_subscriptions", toPushRow(data));
  }

  async listPushSubscriptions() {
    const rows = await this.request("GET", "push_subscriptions?select=*&limit=200");
    return rows.map(fromPushRow);
  }

  async removePushSubscription(endpoint) {
    await this.request("DELETE", `push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, undefined, { prefer: "return=minimal" });
  }

  async addNote(data) {
    const rows = await this.request("POST", "customer_notes", toNoteRow(data));
    return fromNoteRow(rows[0]);
  }

  async listNotes(conversationId) {
    const rows = await this.request("GET", `customer_notes?conversation_id=eq.${encodeURIComponent(conversationId)}&select=*&order=created_at.desc&limit=200`);
    return rows.map(fromNoteRow);
  }

  async updateNote(id, patch) {
    const rows = await this.request("PATCH", `customer_notes?id=eq.${encodeURIComponent(id)}`, toNoteRow(patch));
    return rows[0] ? fromNoteRow(rows[0]) : null;
  }

  async listDueReminders(nowIso) {
    const rows = await this.request("GET", `customer_notes?reminder_at=lte.${encodeURIComponent(nowIso)}&reminder_sent_at=is.null&completed_at=is.null&select=*&limit=100`);
    return rows.map(fromNoteRow);
  }
}

function serveStatic(req, res, url) {
  if (req.method !== "GET") return false;

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return sendFile(res, path.join(PUBLIC_DIR, "admin", "index.html"));
  }

  if (url.pathname.startsWith("/admin/")) {
    const relative = url.pathname.replace(/^\/admin\/+/, "");
    return sendFile(res, path.join(PUBLIC_DIR, "admin", relative));
  }

  if (url.pathname === "/manifest.webmanifest") {
    return sendFile(res, path.join(PUBLIC_DIR, "admin", "manifest.webmanifest"));
  }

  if (url.pathname === "/sw.js") {
    return sendFile(res, path.join(PUBLIC_DIR, "admin", "sw.js"));
  }

  return false;
}

function sendFile(res, filePath) {
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR) || !fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
    sendJson(res, { ok: false, error: "not_found" }, 404);
    return true;
  }
  const ext = path.extname(normalized).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8"
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": ext === ".js" ? "no-cache" : "public, max-age=300" });
  fs.createReadStream(normalized).pipe(res);
  return true;
}

function requireAdmin(req, res) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload || payload.sub !== ADMIN_USER) {
    sendJson(res, { ok: false, error: "unauthorized" }, 401);
    return null;
  }
  return payload;
}

function signToken(payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function normalizeDb(db) {
  return {
    counters: { visitor: Number(db.counters && db.counters.visitor || 0) },
    conversations: Array.isArray(db.conversations) ? db.conversations : [],
    messages: Array.isArray(db.messages) ? db.messages : [],
    pushSubscriptions: Array.isArray(db.pushSubscriptions) ? db.pushSubscriptions : [],
    customerNotes: Array.isArray(db.customerNotes) ? db.customerNotes : []
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    sender: message.sender,
    body: message.body || "",
    createdAt: message.createdAt
  };
}

function adminMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    sender: message.sender,
    body: message.body || "",
    imageName: message.imageName || "",
    imageMime: message.imageMime || "",
    imageData: message.imageData || "",
    createdAt: message.createdAt
  };
}

function adminConversation(conversation) {
  return {
    id: conversation.id,
    sessionId: conversation.sessionId,
    visitorName: conversation.visitorName || "",
    visitorLabel: conversation.visitorLabel || "Ziyaretçi",
    visitorPhone: conversation.visitorPhone || "",
    displayName: displayName(conversation),
    pageUrl: conversation.pageUrl || "",
    pageTitle: conversation.pageTitle || "",
    status: conversation.status || "open",
    unreadAdminCount: Number(conversation.unreadAdminCount || 0),
    lastMessageText: conversation.lastMessageText || "",
    lastCustomerMessageAt: conversation.lastCustomerMessageAt || "",
    lastAdminMessageAt: conversation.lastAdminMessageAt || "",
    createdAt: conversation.createdAt || "",
    updatedAt: conversation.updatedAt || ""
  };
}

function adminNote(note) {
  return {
    id: note.id,
    conversationId: note.conversationId,
    body: note.body || "",
    reminderAt: note.reminderAt || "",
    reminderSentAt: note.reminderSentAt || "",
    completedAt: note.completedAt || "",
    createdAt: note.createdAt || "",
    updatedAt: note.updatedAt || ""
  };
}

function adminReminder(note) {
  return adminNote(note);
}

function displayName(conversation) {
  return conversation.visitorName || conversation.visitorPhone || conversation.visitorLabel || "Ziyaretçi";
}

function guessVisitorName(text) {
  const value = String(text || "").trim();
  if (value.length < 2 || value.length > 60) return "";
  if (/[?!.:,;@#0-9]/.test(value)) return "";
  const normalized = normalizeText(value);
  if (/(merhaba|selam|siparis|sipariş|urun|ürün|beden|stok|kargo|iade|degisim|değişim|fiyat|whatsapp|yardim|yardım)/.test(normalized)) return "";
  if (!/^[a-zA-ZğüşöçıİĞÜŞÖÇ\s'-]+$/.test(value)) return "";
  return value;
}

function guessPhone(text) {
  const match = String(text || "").match(/(?:\+?90|0)?\s?5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}/);
  return match ? match[0].replace(/[^\d+]/g, "") : "";
}

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sanitizeImage(image) {
  if (!image || typeof image !== "object") return null;
  const data = String(image.data || "");
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(data)) return null;
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error("image_too_large");
  }
  return {
    name: String(image.name || "fotoğraf").slice(0, 160),
    mime: String(image.mime || "image/jpeg").slice(0, 80),
    data
  };
}

function normalizeReminderAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function cleanSessionId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

function base64url(value) {
  return Buffer.from(String(value)).toString("base64url");
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function toConversationRow(item) {
  return omitUndefined({
    session_id: item.sessionId,
    visitor_name: item.visitorName,
    visitor_label: item.visitorLabel,
    visitor_phone: item.visitorPhone,
    page_url: item.pageUrl,
    page_title: item.pageTitle,
    status: item.status,
    unread_admin_count: item.unreadAdminCount,
    last_message_text: item.lastMessageText,
    last_customer_message_at: emptyToNull(item.lastCustomerMessageAt),
    last_admin_message_at: emptyToNull(item.lastAdminMessageAt),
    created_at: item.createdAt,
    updated_at: item.updatedAt
  });
}

function fromConversationRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    visitorName: row.visitor_name || "",
    visitorLabel: row.visitor_label || "",
    visitorPhone: row.visitor_phone || "",
    pageUrl: row.page_url || "",
    pageTitle: row.page_title || "",
    status: row.status || "open",
    unreadAdminCount: Number(row.unread_admin_count || 0),
    lastMessageText: row.last_message_text || "",
    lastCustomerMessageAt: row.last_customer_message_at || "",
    lastAdminMessageAt: row.last_admin_message_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function toMessageRow(item) {
  return omitUndefined({
    conversation_id: item.conversationId,
    session_id: item.sessionId,
    sender: item.sender,
    body: item.body,
    image_name: item.imageName,
    image_mime: item.imageMime,
    image_data: item.imageData,
    created_at: item.createdAt
  });
}

function fromMessageRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    sender: row.sender,
    body: row.body || "",
    imageName: row.image_name || "",
    imageMime: row.image_mime || "",
    imageData: row.image_data || "",
    createdAt: row.created_at || ""
  };
}

function toPushRow(item) {
  return {
    endpoint: item.endpoint,
    keys: item.keys || {},
    user_agent: item.userAgent || "",
    created_at: item.createdAt || new Date().toISOString()
  };
}

function fromPushRow(row) {
  return {
    endpoint: row.endpoint,
    keys: row.keys || {},
    userAgent: row.user_agent || "",
    createdAt: row.created_at || ""
  };
}

function toNoteRow(item) {
  return omitUndefined({
    conversation_id: item.conversationId,
    body: item.body,
    reminder_at: emptyToNull(item.reminderAt),
    reminder_sent_at: emptyToNull(item.reminderSentAt),
    completed_at: emptyToNull(item.completedAt),
    created_at: item.createdAt,
    updated_at: item.updatedAt
  });
}

function fromNoteRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    body: row.body || "",
    reminderAt: row.reminder_at || "",
    reminderSentAt: row.reminder_sent_at || "",
    completedAt: row.completed_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function omitUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function emptyToNull(value) {
  return value ? value : null;
}

function start() {
  if (!storage) {
    storage = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
      ? new SupabaseStore(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
      : new FileStore(path.join(DATA_DIR, "ruth-live-support-db.json"));
  }

  if (!server.listening) {
    server.listen(PORT, () => {
      console.log(`RUTH manual live support listening on http://localhost:${PORT}`);
      console.log(`Storage: ${storage.kind}`);
      console.log(`Push ready: ${Boolean(webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)}`);
    });
  }

  if (!reminderTimer) {
    reminderTimer = setInterval(() => {
      checkDueReminders().catch((error) => {
        console.error("Reminder check error:", error && error.message ? error.message : error);
      });
    }, 60_000);
    checkDueReminders().catch(() => {});
  }

  return server;
}

function stop(callback) {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
  if (server.listening) return server.close(callback);
  if (callback) callback();
}

if (require.main === module) {
  start();
}

module.exports = { start, stop, server };
