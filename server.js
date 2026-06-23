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
const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL || "");
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
    const adminFile = path.join(PUBLIC_DIR, "admin", "index.html");
    if (fs.existsSync(adminFile)) return sendFile(res, adminFile);
    return sendHtml(res, adminHtml());
  }

  if (url.pathname.startsWith("/admin/")) {
    const relative = url.pathname.replace(/^\/admin\/+/, "");
    const filePath = path.join(PUBLIC_DIR, "admin", relative);
    if (fs.existsSync(filePath)) return sendFile(res, filePath);
    return sendHtml(res, adminHtml());
  }

  if (url.pathname === "/manifest.webmanifest") {
    const manifestFile = path.join(PUBLIC_DIR, "admin", "manifest.webmanifest");
    if (fs.existsSync(manifestFile)) return sendFile(res, manifestFile);
    return sendJson(res, {
      name: "RUTH ISTANBUL Panel",
      short_name: "RUTH Panel",
      start_url: "/admin/",
      scope: "/",
      display: "standalone",
      background_color: "#050505",
      theme_color: "#050505",
      icons: []
    });
  }

  if (url.pathname === "/sw.js") {
    const swFile = path.join(PUBLIC_DIR, "admin", "sw.js");
    if (fs.existsSync(swFile)) return sendFile(res, swFile);
    return sendText(res, "self.addEventListener('push',function(event){var data={};try{data=event.data?event.data.json():{};}catch(e){};event.waitUntil(self.registration.showNotification(data.title||'RUTH ISTANBUL',{body:data.body||'Yeni mesaj var.',tag:data.tag||'ruth',data:data.data||{},icon:data.icon||''}));});self.addEventListener('notificationclick',function(event){event.notification.close();event.waitUntil(clients.openWindow('/admin/'));});", "text/javascript; charset=utf-8");
  }

  return false;
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
  return true;
}

function sendText(res, value, type = "text/plain; charset=utf-8", status = 200) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(String(value || ""));
  return true;
}

function adminHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#050505">
  <link rel="manifest" href="/manifest.webmanifest">
  <title>RUTH ISTANBUL Panel</title>
  <style>
    :root{--gold:#d8b83f;--gold2:#efe2a2;--ink:#050505;--muted:#666;--line:rgba(5,5,5,.12);--bg:#faf8f0;--white:#fff}
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
    button,input,textarea{font:inherit}
    .top{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;background:var(--ink);color:white}
    .brand{display:flex;align-items:center;gap:10px;font-weight:900;letter-spacing:.04em}
    .mark{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:var(--gold);color:var(--ink);font-family:Georgia,serif;font-weight:900}
    .wrap{display:grid;grid-template-columns:340px 1fr;min-height:calc(100dvh - 62px)}
    .sidebar{border-right:1px solid var(--line);background:white;overflow:auto}
    .main{display:grid;grid-template-rows:auto 1fr auto;min-width:0}
    .toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid var(--line);background:white}
    .btn{border:1px solid var(--line);border-radius:10px;padding:9px 12px;background:white;cursor:pointer;font-weight:800}
    .btn.primary{background:var(--gold);border-color:var(--gold);color:var(--ink)}
    .btn.danger{background:#1f1f1f;color:#fff}
    .btn:disabled{opacity:.55;cursor:not-allowed}
    .login{max-width:420px;margin:80px auto;padding:24px;background:white;border:1px solid var(--line);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.12)}
    .login h1{margin:0 0 16px;font-size:24px}
    label{display:block;margin:12px 0 6px;font-weight:800}
    input,textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:11px 12px;background:white;outline:none}
    textarea{resize:vertical;min-height:48px;max-height:160px}
    input:focus,textarea:focus{border-color:#a98419;box-shadow:0 0 0 3px rgba(216,184,63,.2)}
    .conversation{padding:13px 14px;border-bottom:1px solid var(--line);cursor:pointer}
    .conversation:hover,.conversation.active{background:#fbf4d8}
    .row{display:flex;justify-content:space-between;gap:10px;align-items:center}
    .name{font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .badge{min-width:22px;height:22px;border-radius:999px;background:var(--gold);display:grid;place-items:center;font-size:12px;font-weight:900}
    .preview{margin-top:6px;font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .time{font-size:11px;color:var(--muted);white-space:nowrap}
    .empty{padding:28px;color:var(--muted);text-align:center}
    .messages{padding:16px;overflow:auto;display:flex;flex-direction:column;gap:10px}
    .msg{max-width:min(680px,88%);padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:white;white-space:pre-wrap;line-height:1.38}
    .msg.customer{align-self:flex-start}
    .msg.admin{align-self:flex-end;background:var(--gold)}
    .msg.system{align-self:center;background:#eee}
    .msg img{display:block;max-width:260px;width:100%;margin-top:8px;border-radius:10px}
    .meta{font-size:11px;color:var(--muted);margin-top:6px}
    .composer{display:flex;gap:8px;padding:12px;background:white;border-top:1px solid var(--line)}
    .composer textarea{min-height:46px}
    .hidden{display:none!important}
    .error{margin-top:12px;color:#a40000;font-weight:800}
    .note{font-size:13px;color:var(--muted)}
    @media(max-width:780px){
      .wrap{grid-template-columns:1fr;min-height:calc(100dvh - 62px)}
      .sidebar{display:block;max-height:42dvh;border-right:0;border-bottom:1px solid var(--line)}
      .main{min-height:58dvh}
      .top{padding:12px}
    }
  </style>
</head>
<body>
  <div id="login" class="login">
    <div class="brand"><div class="mark">R</div><div>RUTH ISTANBUL</div></div>
    <h1>Canlı Destek Paneli</h1>
    <label>Kullanıcı adı</label>
    <input id="username" autocomplete="username" value="ruth">
    <label>Şifre</label>
    <input id="password" type="password" autocomplete="current-password">
    <button id="loginBtn" class="btn primary" style="width:100%;margin-top:16px">Giriş yap</button>
    <div id="loginError" class="error"></div>
  </div>

  <div id="app" class="hidden">
    <div class="top">
      <div class="brand"><div class="mark">R</div><div>RUTH ISTANBUL Panel</div></div>
      <div class="row">
        <button id="pushBtn" class="btn">Bildirim aç</button>
        <button id="logoutBtn" class="btn danger">Çıkış</button>
      </div>
    </div>
    <div class="wrap">
      <aside class="sidebar">
        <div class="toolbar">
          <strong>Mesajlar</strong>
          <button id="refreshBtn" class="btn">Yenile</button>
        </div>
        <div id="conversations"><div class="empty">Konuşmalar yükleniyor...</div></div>
      </aside>
      <main class="main">
        <div class="toolbar">
          <div>
            <strong id="activeTitle">Konuşma seç</strong>
            <div id="activeSub" class="note"></div>
          </div>
          <button id="closeBtn" class="btn">Kapat/Aç</button>
        </div>
        <div id="messages" class="messages"><div class="empty">Soldan bir konuşma seç.</div></div>
        <form id="replyForm" class="composer">
          <textarea id="reply" placeholder="Cevap yaz..." disabled></textarea>
          <button id="sendBtn" class="btn primary" disabled>Gönder</button>
        </form>
      </main>
    </div>
  </div>

<script>
(function(){
  var tokenKey = "ruth_admin_token";
  var token = localStorage.getItem(tokenKey) || "";
  var activeId = "";
  var conversations = [];
  var pollTimer = null;

  var loginEl = document.getElementById("login");
  var appEl = document.getElementById("app");
  var usernameEl = document.getElementById("username");
  var passwordEl = document.getElementById("password");
  var loginBtn = document.getElementById("loginBtn");
  var loginError = document.getElementById("loginError");
  var conversationsEl = document.getElementById("conversations");
  var messagesEl = document.getElementById("messages");
  var activeTitle = document.getElementById("activeTitle");
  var activeSub = document.getElementById("activeSub");
  var replyForm = document.getElementById("replyForm");
  var replyEl = document.getElementById("reply");
  var sendBtn = document.getElementById("sendBtn");
  var refreshBtn = document.getElementById("refreshBtn");
  var logoutBtn = document.getElementById("logoutBtn");
  var closeBtn = document.getElementById("closeBtn");
  var pushBtn = document.getElementById("pushBtn");

  loginBtn.addEventListener("click", login);
  passwordEl.addEventListener("keydown", function(e){ if(e.key === "Enter") login(); });
  refreshBtn.addEventListener("click", loadConversations);
  logoutBtn.addEventListener("click", function(){ localStorage.removeItem(tokenKey); location.reload(); });
  closeBtn.addEventListener("click", toggleStatus);
  pushBtn.addEventListener("click", subscribePush);
  replyForm.addEventListener("submit", sendReply);

  boot();

  function boot(){
    if(!token) return showLogin();
    api("/api/admin/me").then(function(me){
      showApp();
      pushBtn.style.display = me.pushReady ? "inline-block" : "none";
      loadConversations();
      pollTimer = setInterval(function(){
        loadConversations(true);
        if(activeId) loadMessages(activeId, true);
      }, 4000);
    }).catch(function(){
      localStorage.removeItem(tokenKey);
      showLogin();
    });
  }

  function showLogin(){
    loginEl.classList.remove("hidden");
    appEl.classList.add("hidden");
    setTimeout(function(){ passwordEl.focus(); }, 50);
  }

  function showApp(){
    loginEl.classList.add("hidden");
    appEl.classList.remove("hidden");
  }

  function login(){
    loginError.textContent = "";
    loginBtn.disabled = true;
    fetch("/api/admin/login", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username:usernameEl.value.trim(), password:passwordEl.value})
    }).then(json).then(function(data){
      if(!data.ok) throw new Error(data.error || "Giriş başarısız");
      token = data.token;
      localStorage.setItem(tokenKey, token);
      showApp();
      loadConversations();
      pollTimer = setInterval(function(){
        loadConversations(true);
        if(activeId) loadMessages(activeId, true);
      }, 4000);
    }).catch(function(err){
      loginError.textContent = "Giriş olmadı. Kullanıcı adı/şifreyi kontrol et.";
    }).finally(function(){
      loginBtn.disabled = false;
    });
  }

  function loadConversations(silent){
    if(!silent) conversationsEl.innerHTML = '<div class="empty">Konuşmalar yükleniyor...</div>';
    return api("/api/admin/conversations").then(function(data){
      conversations = data.conversations || [];
      renderConversations();
      var fromUrl = new URLSearchParams(location.search).get("conversation");
      if(!activeId && fromUrl) selectConversation(fromUrl);
      if(!activeId && conversations.length && !silent) selectConversation(conversations[0].id);
    }).catch(function(err){
      conversationsEl.innerHTML = '<div class="empty">Konuşmalar yüklenemedi: '+escapeHtml(err.message)+'</div>';
    });
  }

  function renderConversations(){
    if(!conversations.length){
      conversationsEl.innerHTML = '<div class="empty">Henüz mesaj yok.</div>';
      return;
    }
    conversationsEl.innerHTML = conversations.map(function(c){
      return '<div class="conversation '+(c.id===activeId?'active':'')+'" data-id="'+escapeHtml(c.id)+'">'+
        '<div class="row"><div class="name">'+escapeHtml(c.displayName || "Ziyaretçi")+'</div>'+
        (c.unreadAdminCount ? '<div class="badge">'+c.unreadAdminCount+'</div>' : '<div class="time">'+formatDate(c.updatedAt)+'</div>')+
        '</div><div class="preview">'+escapeHtml(c.lastMessageText || c.pageTitle || "Yeni konuşma")+'</div></div>';
    }).join("");
    Array.prototype.forEach.call(conversationsEl.querySelectorAll(".conversation"), function(el){
      el.addEventListener("click", function(){ selectConversation(el.getAttribute("data-id")); });
    });
  }

  function selectConversation(id){
    activeId = id;
    renderConversations();
    loadMessages(id);
  }

  function loadMessages(id, silent){
    var c = conversations.find(function(x){ return x.id === id; });
    if(c){
      activeTitle.textContent = c.displayName || "Ziyaretçi";
      activeSub.textContent = (c.pageTitle || "") + (c.pageUrl ? " • " + c.pageUrl : "");
    }
    if(!silent) messagesEl.innerHTML = '<div class="empty">Mesajlar yükleniyor...</div>';
    replyEl.disabled = false;
    sendBtn.disabled = false;

    return api("/api/admin/conversations/"+encodeURIComponent(id)+"/messages").then(function(data){
      renderMessages(data.messages || []);
      return api("/api/admin/conversations/"+encodeURIComponent(id)+"/read", {method:"POST"}).then(function(){});
    }).catch(function(err){
      messagesEl.innerHTML = '<div class="empty">Mesajlar yüklenemedi: '+escapeHtml(err.message)+'</div>';
    });
  }

  function renderMessages(items){
    if(!items.length){
      messagesEl.innerHTML = '<div class="empty">Bu konuşmada mesaj yok.</div>';
      return;
    }
    messagesEl.innerHTML = items.map(function(m){
      return '<div class="msg '+escapeHtml(m.sender)+'">'+
        '<div>'+escapeHtml(m.body || (m.imageData ? "Fotoğraf" : ""))+'</div>'+
        (m.imageData ? '<img src="'+m.imageData+'" alt="Müşteri fotoğrafı">' : '')+
        '<div class="meta">'+escapeHtml(m.sender)+' • '+formatDate(m.createdAt)+'</div>'+
      '</div>';
    }).join("");
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function sendReply(e){
    e.preventDefault();
    var text = replyEl.value.trim();
    if(!activeId || !text) return;
    sendBtn.disabled = true;
    api("/api/admin/conversations/"+encodeURIComponent(activeId)+"/reply", {
      method:"POST",
      body:JSON.stringify({message:text})
    }).then(function(){
      replyEl.value = "";
      loadMessages(activeId);
      loadConversations(true);
    }).catch(function(err){
      alert("Mesaj gönderilemedi: " + err.message);
    }).finally(function(){
      sendBtn.disabled = false;
    });
  }

  function toggleStatus(){
    if(!activeId) return;
    var c = conversations.find(function(x){ return x.id === activeId; });
    var next = c && c.status === "closed" ? "open" : "closed";
    api("/api/admin/conversations/"+encodeURIComponent(activeId)+"/status", {
      method:"POST",
      body:JSON.stringify({status:next})
    }).then(function(){ loadConversations(true); });
  }

  function subscribePush(){
    if(!("serviceWorker" in navigator) || !("PushManager" in window)){
      alert("Bu tarayıcı bildirim desteklemiyor.");
      return;
    }
    api("/api/admin/me").then(function(me){
      if(!me.vapidPublicKey) throw new Error("VAPID key yok");
      return navigator.serviceWorker.register("/sw.js").then(function(reg){
        return reg.pushManager.subscribe({
          userVisibleOnly:true,
          applicationServerKey:urlBase64ToUint8Array(me.vapidPublicKey)
        });
      });
    }).then(function(sub){
      return api("/api/admin/push/subscribe", {method:"POST", body:JSON.stringify({subscription:sub})});
    }).then(function(){
      alert("Bildirim açıldı.");
    }).catch(function(err){
      alert("Bildirim açılamadı: " + err.message);
    });
  }

  function api(url, options){
    options = options || {};
    options.headers = Object.assign({"Content-Type":"application/json"}, options.headers || {});
    if(token) options.headers.Authorization = "Bearer " + token;
    return fetch(url, options).then(json).then(function(data){
      if(!data.ok) throw new Error(data.error || "İstek başarısız");
      return data;
    });
  }

  function json(response){
    return response.json().catch(function(){ return {}; }).then(function(data){
      if(!response.ok && !data.error) data.error = "HTTP " + response.status;
      return data;
    });
  }

  function escapeHtml(value){
    return String(value || "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  }

  function formatDate(value){
    if(!value) return "";
    var d = new Date(value);
    if(isNaN(d.getTime())) return "";
    return d.toLocaleString("tr-TR", {day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit"});
  }

  function urlBase64ToUint8Array(base64String){
    var padding = "=".repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for(var i=0;i<rawData.length;++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }
})();
</script>
</body>
</html>`;
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

function normalizeSupabaseUrl(value) {
  const raw = trimSlash(value);
  if (!raw) return "";

  try {
    const parsed = new URL(raw);

    if (parsed.hostname === "supabase.com") {
      const match = parsed.pathname.match(/\/dashboard\/project\/([^/]+)/);
      if (match && match[1]) return `https://${match[1]}.supabase.co`;
    }

    if (parsed.hostname.endsWith(".supabase.co")) {
      return parsed.origin;
    }

    return trimSlash(raw.replace(/\/rest\/v1\/?$/i, ""));
  } catch (error) {
    return trimSlash(raw.replace(/\/rest\/v1\/?$/i, ""));
  }
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
