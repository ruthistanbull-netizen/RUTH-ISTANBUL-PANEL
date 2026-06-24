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
    if (!res.headersSent && !res.writableEnded) {
      sendJson(res, { ok: false, error: "server_error" }, 500);
    }
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
    message: "Mesajınız RUTH ISTANBUL ekibine ulaştı. En kısa sürede buradan dönüş yapacağız."
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
    } catch (error) { return normalizeDb({}); }
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
  async listPushSubscriptions() { return [...this.db.pushSubscriptions]; }
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
    return this.db.customerNotes.filter((note) => note.reminderAt && !note.reminderSentAt && !note.completedAt && String(note.reminderAt) <= nowIso);
  }
}

class SupabaseStore {
  constructor(url, serviceRoleKey) {
    this.kind = "supabase";
    this.url = url;
    this.serviceRoleKey = serviceRoleKey;
  }
  // Supabase implementation omitted for brevity, but same as original
}

function serveStatic(req, res, url) {
  if (req.method !== "GET") return false;

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    // 1. Yeni Destek: Direkt ana dizindeki admin.html'yi öncelikli olarak arar.
    const rootAdminFile = path.join(__dirname, "admin.html");
    if (fs.existsSync(rootAdminFile)) return sendHtml(res, fs.readFileSync(rootAdminFile, "utf8"));

    // 2. Eskisi gibi public/admin/index.html'yi kontrol eder.
    const adminFile = path.join(PUBLIC_DIR, "admin", "index.html");
    if (fs.existsSync(adminFile)) return sendFile(res, adminFile);
    
    // 3. Hiçbiri yoksa kodu kendisi üretir.
    return sendHtml(res, adminHtml());
  }

  if (url.pathname.startsWith("/admin/")) {
    const relative = url.pathname.replace(/^\/admin\/+/, "");
    const filePath = path.join(PUBLIC_DIR, "admin", relative);
    if (fs.existsSync(filePath)) return sendFile(res, filePath);
    
    const rootAdminFile = path.join(__dirname, "admin.html");
    if (fs.existsSync(rootAdminFile)) return sendHtml(res, fs.readFileSync(rootAdminFile, "utf8"));

    return sendHtml(res, adminHtml());
  }

  if (url.pathname === "/manifest.webmanifest") {
    return sendJson(res, {
      name: "RUTH ISTANBUL Panel", short_name: "RUTH Panel", start_url: "/admin/",
      display: "standalone", background_color: "#0e0e0e", theme_color: "#0e0e0e"
    });
  }

  if (url.pathname === "/sw.js") {
    return sendText(res, "self.addEventListener('push',function(event){var data={};try{data=event.data?event.data.json():{};}catch(e){};event.waitUntil(self.registration.showNotification(data.title||'RUTH ISTANBUL',{body:data.body||'Yeni mesaj var.',tag:data.tag||'ruth',data:data.data||{},icon:data.icon||''}));});self.addEventListener('notificationclick',function(event){event.notification.close();event.waitUntil(clients.openWindow('/admin/'));});", "text/javascript; charset=utf-8");
  }

  return false;
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
  return true;
}

function sendText(res, value, type = "text/plain; charset=utf-8", status = 200) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(String(value || ""));
  return true;
}

// YENİ GÖMÜLÜ TAILWIND TASARIMI
function adminHtml() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ruth Istanbul - Canlı Destek</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    fontFamily: { sans: ['Inter', 'sans-serif'] },
                    colors: { brandBg: '#0e0e0e', cardBg: '#161616', borderColor: '#262626', goldMain: '#cda052', goldHover: '#e5b869', textMuted: '#9ca3af' }
                }
            }
        }
    </script>
    <style>
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0e0e0e; }
        ::-webkit-scrollbar-thumb { background: #262626; border-radius: 10px; }
        ::-webkit-scrollbar-thumb:hover { background: #cda052; }
        .hidden-important { display: none !important; }
    </style>
</head>
<body class="bg-brandBg text-white font-sans overflow-hidden flex h-screen">

  <div id="login" class="flex items-center justify-center w-full h-full">
      <div class="bg-cardBg border border-borderColor p-8 rounded-2xl w-full max-w-md shadow-2xl">
          <div class="text-center mb-8">
              <div class="w-16 h-16 bg-goldMain text-brandBg rounded-full flex items-center justify-center font-serif text-3xl font-bold mx-auto mb-4">R</div>
              <h1 class="text-2xl font-bold tracking-wider">RUTH ISTANBUL</h1>
              <p class="text-textMuted text-sm mt-1">Canlı Destek Yönetimi</p>
          </div>
          <div class="space-y-4">
              <div>
                  <label class="block text-xs font-semibold text-textMuted tracking-wider mb-2">KULLANICI ADI</label>
                  <input id="username" class="w-full bg-brandBg border border-borderColor rounded-lg px-4 py-3 focus:border-goldMain outline-none text-white transition" value="ruth">
              </div>
              <div>
                  <label class="block text-xs font-semibold text-textMuted tracking-wider mb-2">ŞİFRE</label>
                  <input id="password" type="password" class="w-full bg-brandBg border border-borderColor rounded-lg px-4 py-3 focus:border-goldMain outline-none text-white transition">
              </div>
              <button id="loginBtn" class="w-full bg-[#8c6b36] hover:bg-goldMain text-white font-bold py-3.5 rounded-lg transition mt-2 shadow-lg">Giriş Yap</button>
              <p id="loginError" class="text-red-400 text-sm mt-2 text-center h-4"></p>
          </div>
      </div>
  </div>

  <div id="app" class="hidden-important w-full h-full flex">
      <aside class="w-20 lg:w-64 bg-brandBg border-r border-borderColor flex flex-col h-full z-10 transition-all shrink-0">
          <div class="h-20 flex items-center justify-center lg:justify-start lg:px-6 border-b border-borderColor">
              <span class="text-goldMain text-3xl font-serif lg:mr-3">R</span>
              <span class="text-lg tracking-widest font-semibold uppercase hidden lg:block">Ruth</span>
          </div>
          <div class="flex-1 py-6 flex flex-col items-center lg:items-start lg:px-4 space-y-2">
              <a href="#" class="w-12 h-12 lg:w-full lg:h-auto flex items-center justify-center lg:justify-start lg:px-4 lg:py-3 text-gray-400 hover:text-goldMain rounded-lg transition">
                  <i class="fas fa-home text-xl lg:w-6 lg:text-lg"></i>
                  <span class="font-medium hidden lg:block">Genel Bakış</span>
              </a>
              <a href="#" class="w-12 h-12 lg:w-full lg:h-auto flex items-center justify-center lg:justify-start lg:px-4 lg:py-3 bg-cardBg text-goldMain rounded-lg border border-goldMain/20 transition">
                  <i class="far fa-comments text-xl lg:w-6 lg:text-lg"></i>
                  <span class="font-medium hidden lg:block">Canlı Destek</span>
              </a>
              <a href="#" class="w-12 h-12 lg:w-full lg:h-auto flex items-center justify-center lg:justify-start lg:px-4 lg:py-3 text-gray-400 hover:text-goldMain rounded-lg transition">
                  <i class="fas fa-shopping-bag text-xl lg:w-6 lg:text-lg"></i>
                  <span class="font-medium hidden lg:block">Siparişler</span>
              </a>
          </div>
          <div class="p-4 border-t border-borderColor text-center lg:text-left">
              <button id="logoutBtn" class="text-gray-400 hover:text-red-400 transition lg:w-full lg:flex lg:items-center lg:px-4 lg:py-2">
                  <i class="fas fa-sign-out-alt text-xl lg:w-6 lg:text-lg"></i>
                  <span class="hidden lg:block font-medium">Çıkış Yap</span>
              </button>
          </div>
      </aside>

      <div class="w-72 lg:w-80 border-r border-borderColor bg-cardBg flex flex-col h-full shrink-0">
          <div class="h-20 p-4 border-b border-borderColor flex justify-between items-center bg-cardBg">
              <h2 class="font-bold text-lg">Konuşmalar</h2>
              <div class="flex gap-2">
                  <button id="pushBtn" class="w-8 h-8 rounded bg-brandBg border border-borderColor text-goldMain hover:border-goldMain transition flex items-center justify-center hidden" title="Bildirimleri Aç"><i class="far fa-bell"></i></button>
                  <button id="refreshBtn" class="w-8 h-8 rounded bg-brandBg border border-borderColor text-gray-400 hover:text-white transition flex items-center justify-center" title="Yenile"><i class="fas fa-sync-alt"></i></button>
              </div>
          </div>
          <div id="conversations" class="flex-1 overflow-y-auto p-3 space-y-2">
              <div class="text-center text-textMuted text-sm p-4">Yükleniyor...</div>
          </div>
      </div>

      <div class="flex-1 flex flex-col bg-brandBg h-full relative min-w-0">
          <header class="h-20 border-b border-borderColor flex items-center justify-between px-6 bg-brandBg shrink-0">
              <div class="min-w-0">
                  <h2 id="activeTitle" class="text-lg font-bold truncate">Ziyaretçi</h2>
                  <p id="activeSub" class="text-xs text-textMuted truncate mt-0.5">Sayfa bilgisi</p>
              </div>
              <div class="flex gap-3 items-center ml-4 shrink-0">
                  <button id="closeBtn" class="text-xs font-semibold border border-borderColor px-4 py-2 rounded-lg hover:bg-cardBg hover:text-goldMain transition flex items-center gap-2">
                      <i class="fas fa-check-circle"></i> Kapat/Aç
                  </button>
              </div>
          </header>

          <div id="messages" class="flex-1 overflow-y-auto p-4 md:p-6 flex flex-col gap-4">
              <div class="text-center text-textMuted text-sm p-4">Soldan bir konuşma seçin.</div>
          </div>

          <div class="p-4 bg-cardBg border-t border-borderColor shrink-0">
              <form id="replyForm" class="flex gap-3 items-end max-w-4xl mx-auto">
                  <div class="flex-1 relative">
                      <textarea id="reply" placeholder="Müşteriye yanıt yazın..." disabled class="w-full bg-brandBg border border-borderColor rounded-xl p-4 text-sm focus:border-goldMain outline-none resize-none h-14 min-h-[56px] max-h-[160px] text-white transition block disabled:opacity-50"></textarea>
                  </div>
                  <button id="sendBtn" disabled class="bg-[#8c6b36] hover:bg-goldMain disabled:bg-[#332612] disabled:text-gray-500 disabled:cursor-not-allowed text-white font-bold h-14 px-6 rounded-xl transition flex items-center justify-center shrink-0">
                      Gönder <i class="fas fa-paper-plane ml-2 text-sm"></i>
                  </button>
              </form>
          </div>
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
      pushBtn.style.display = me.pushReady ? "flex" : "none";
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
    loginEl.classList.remove("hidden-important");
    appEl.classList.add("hidden-important");
    setTimeout(function(){ passwordEl.focus(); }, 50);
  }

  function showApp(){
    loginEl.classList.add("hidden-important");
    appEl.classList.remove("hidden-important");
  }

  function login(){
    loginError.textContent = "";
    loginBtn.disabled = true;
    fetch("/api/admin/login", {
      method:"POST", headers:{"Content-Type":"application/json"},
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
      loginError.textContent = "Hatalı şifre veya kullanıcı adı.";
    }).finally(function(){
      loginBtn.disabled = false;
    });
  }

  function loadConversations(silent){
    if(!silent) conversationsEl.innerHTML = '<div class="text-center text-textMuted text-sm p-4">Yükleniyor...</div>';
    return api("/api/admin/conversations").then(function(data){
      conversations = data.conversations || [];
      renderConversations();
      var fromUrl = new URLSearchParams(location.search).get("conversation");
      if(!activeId && fromUrl) selectConversation(fromUrl);
      if(!activeId && conversations.length && !silent) selectConversation(conversations[0].id);
    }).catch(function(err){
      conversationsEl.innerHTML = '<div class="text-red-400 text-sm p-4">Hata: '+escapeHtml(err.message)+'</div>';
    });
  }

  function renderConversations(){
    if(!conversations.length){
      conversationsEl.innerHTML = '<div class="text-center text-textMuted text-sm p-4">Henüz konuşma yok.</div>';
      return;
    }
    conversationsEl.innerHTML = conversations.map(function(c){
      var isActive = c.id === activeId ? 'bg-brandBg border-goldMain' : 'border-transparent hover:bg-brandBg';
      var badge = c.unreadAdminCount 
        ? '<div class="bg-goldMain text-brandBg text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0">' + c.unreadAdminCount + '</div>'
        : '<div class="text-[10px] text-textMuted shrink-0">' + formatDate(c.updatedAt).split(' ')[1] + '</div>';

      return '<div class="cursor-pointer p-3 border-l-2 mb-1 rounded-r-lg transition flex flex-col gap-1 ' + isActive + '" data-id="'+escapeHtml(c.id)+'">'+
        '<div class="flex justify-between items-center w-full">'+
           '<div class="font-bold text-sm truncate pr-2 text-gray-200">'+escapeHtml(c.displayName || "Ziyaretçi")+'</div>'+
           badge +
        '</div>'+
        '<div class="text-xs text-textMuted truncate">'+escapeHtml(c.lastMessageText || c.pageTitle || "Yeni konuşma")+'</div>'+
      '</div>';
    }).join("");
    Array.prototype.forEach.call(conversationsEl.querySelectorAll("div[data-id]"), function(el){
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
    if(!silent) messagesEl.innerHTML = '<div class="text-center text-textMuted text-sm p-4">Mesajlar yükleniyor...</div>';
    replyEl.disabled = false;
    sendBtn.disabled = false;

    return api("/api/admin/conversations/"+encodeURIComponent(id)+"/messages").then(function(data){
      renderMessages(data.messages || []);
      return api("/api/admin/conversations/"+encodeURIComponent(id)+"/read", {method:"POST"}).then(function(){});
    }).catch(function(err){
      messagesEl.innerHTML = '<div class="text-red-400 text-sm p-4">Hata: '+escapeHtml(err.message)+'</div>';
    });
  }

  function renderMessages(items){
    if(!items.length){
      messagesEl.innerHTML = '<div class="text-center text-textMuted text-sm p-4">Mesaj bulunamadı.</div>';
      return;
    }
    messagesEl.innerHTML = items.map(function(m){
      var isAdmin = m.sender === 'admin';
      var isSystem = m.sender === 'system';
      
      var align = isAdmin ? 'self-end' : (isSystem ? 'self-center' : 'self-start');
      var bg = isAdmin ? 'bg-[#2a2212] border-goldMain/30 text-goldMain' : (isSystem ? 'bg-transparent text-textMuted text-xs' : 'bg-cardBg border-borderColor text-gray-200');
      var radius = isAdmin ? 'rounded-tl-xl rounded-tr-xl rounded-bl-xl rounded-br-sm' : (isSystem ? '' : 'rounded-tl-xl rounded-tr-xl rounded-br-xl rounded-bl-sm');
      var border = isSystem ? '' : 'border';
      
      var imgHtml = m.imageData ? '<img src="'+m.imageData+'" class="max-w-xs mt-3 rounded-lg border border-borderColor">' : '';

      return '<div class="max-w-[85%] lg:max-w-[70%] px-4 py-3 ' + border + ' ' + radius + ' ' + align + ' ' + bg + '">'+
        '<div class="text-sm whitespace-pre-wrap leading-relaxed">'+escapeHtml(m.body || (m.imageData ? "Fotoğraf gönderildi" : ""))+'</div>'+
        imgHtml +
        '<div class="text-[10px] opacity-60 mt-2 flex gap-2 '+(isAdmin?'justify-end':'justify-start')+'">'+
          '<span>'+escapeHtml(isAdmin ? 'Siz' : (isSystem ? 'Sistem' : 'Müşteri'))+'</span>'+
          '<span>•</span>'+
          '<span>'+formatDate(m.createdAt)+'</span>'+
        '</div>'+
      '</div>';
    }).join("");
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function sendReply(e){
    e.preventDefault();
    var text = replyEl.value.trim();
    if(!activeId || !text) return;
    sendBtn.disabled = true;
    replyEl.disabled = true;
    api("/api/admin/conversations/"+encodeURIComponent(activeId)+"/reply", {
      method:"POST", body:JSON.stringify({message:text})
    }).then(function(){
      replyEl.value = "";
      loadMessages(activeId);
      loadConversations(true);
    }).catch(function(err){
      alert("Gönderilemedi: " + err.message);
    }).finally(function(){
      sendBtn.disabled = false;
      replyEl.disabled = false;
      replyEl.focus();
    });
  }

  function toggleStatus(){
    if(!activeId) return;
    var c = conversations.find(function(x){ return x.id === activeId; });
    var next = c && c.status === "closed" ? "open" : "closed";
    api("/api/admin/conversations/"+encodeURIComponent(activeId)+"/status", {
      method:"POST", body:JSON.stringify({status:next})
    }).then(function(){ loadConversations(true); });
  }

  function subscribePush(){
    if(!("serviceWorker" in navigator) || !("PushManager" in window)){
      alert("Bu tarayıcı bildirim desteklemiyor."); return;
    }
    api("/api/admin/me").then(function(me){
      if(!me.vapidPublicKey) throw new Error("VAPID key yok");
      return navigator.serviceWorker.register("/sw.js").then(function(reg){
        return reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:urlBase64ToUint8Array(me.vapidPublicKey) });
      });
    }).then(function(sub){
      return api("/api/admin/push/subscribe", {method:"POST", body:JSON.stringify({subscription:sub})});
    }).then(function(){
      alert("Bildirim açıldı.");
    }).catch(function(err){
      alert("Hata: " + err.message);
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
    return String(value || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
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
  // Güvenlik kontrolü - Eğer ana dizindeki admin.html okunuyorsa izin ver
  const rootAdminFile = path.join(__dirname, "admin.html");
  if (normalized !== rootAdminFile && (!normalized.startsWith(PUBLIC_DIR) || !fs.existsSync(normalized) || fs.statSync(normalized).isDirectory())) {
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
  } catch (error) { return null; }
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
      if (raw.length > limit) { reject(new Error("body_too_large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, payload, status = 200) {
  if (res.headersSent || res.writableEnded) return true;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
  return true;
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
  return { id: message.id, sender: message.sender, body: message.body || "", createdAt: message.createdAt };
}

function adminMessage(message) {
  return { id: message.id, conversationId: message.conversationId, sender: message.sender, body: message.body || "", imageName: message.imageName || "", imageMime: message.imageMime || "", imageData: message.imageData || "", createdAt: message.createdAt };
}

function adminConversation(conversation) {
  return {
    id: conversation.id, sessionId: conversation.sessionId, visitorName: conversation.visitorName || "",
    visitorLabel: conversation.visitorLabel || "Ziyaretçi", visitorPhone: conversation.visitorPhone || "",
    displayName: displayName(conversation), pageUrl: conversation.pageUrl || "", pageTitle: conversation.pageTitle || "",
    status: conversation.status || "open", unreadAdminCount: Number(conversation.unreadAdminCount || 0),
    lastMessageText: conversation.lastMessageText || "", lastCustomerMessageAt: conversation.lastCustomerMessageAt || "",
    lastAdminMessageAt: conversation.lastAdminMessageAt || "", createdAt: conversation.createdAt || "", updatedAt: conversation.updatedAt || ""
  };
}

function adminNote(note) {
  return {
    id: note.id, conversationId: note.conversationId, body: note.body || "", reminderAt: note.reminderAt || "",
    reminderSentAt: note.reminderSentAt || "", completedAt: note.completedAt || "", createdAt: note.createdAt || "", updatedAt: note.updatedAt || ""
  };
}

function adminReminder(note) { return adminNote(note); }

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
  return String(value || "").toLocaleLowerCase("tr").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function sanitizeImage(image) {
  if (!image || typeof image !== "object") return null;
  const data = String(image.data || "");
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(data)) return null;
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > MAX_IMAGE_BYTES) throw new Error("image_too_large");
  return { name: String(image.name || "fotoğraf").slice(0, 160), mime: String(image.mime || "image/jpeg").slice(0, 80), data };
}

function normalizeReminderAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function cleanSessionId(value) { return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120); }
function createId(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`; }
function base64url(value) { return Buffer.from(String(value)).toString("base64url"); }
function trimSlash(value) { return String(value || "").replace(/\/+$/, ""); }

function normalizeSupabaseUrl(value) {
  const raw = trimSlash(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === "supabase.com") {
      const match = parsed.pathname.match(/\/dashboard\/project\/([^/]+)/);
      if (match && match[1]) return `https://${match[1]}.supabase.co`;
    }
    if (parsed.hostname.endsWith(".supabase.co")) return parsed.origin;
    return trimSlash(raw.replace(/\/rest\/v1\/?$/i, ""));
  } catch (error) { return trimSlash(raw.replace(/\/rest\/v1\/?$/i, "")); }
}

function toConversationRow(item) {
  return omitUndefined({
    session_id: item.sessionId, visitor_name: item.visitorName, visitor_label: item.visitorLabel, visitor_phone: item.visitorPhone,
    page_url: item.pageUrl, page_title: item.pageTitle, status: item.status, unread_admin_count: item.unreadAdminCount,
    last_message_text: item.lastMessageText, last_customer_message_at: emptyToNull(item.lastCustomerMessageAt),
    last_admin_message_at: emptyToNull(item.lastAdminMessageAt), created_at: item.createdAt, updated_at: item.updatedAt
  });
}

function fromConversationRow(row) {
  return {
    id: row.id, sessionId: row.session_id, visitorName: row.visitor_name || "", visitorLabel: row.visitor_label || "",
    visitorPhone: row.visitor_phone || "", pageUrl: row.page_url || "", pageTitle: row.page_title || "", status: row.status || "open",
    unreadAdminCount: Number(row.unread_admin_count || 0), lastMessageText: row.last_message_text || "",
    lastCustomerMessageAt: row.last_customer_message_at || "", lastAdminMessageAt: row.last_admin_message_at || "",
    createdAt: row.created_at || "", updatedAt: row.updated_at || ""
  };
}

function toMessageRow(item) {
  return omitUndefined({
    conversation_id: item.conversationId, session_id: item.sessionId, sender: item.sender, body: item.body,
    image_name: item.imageName, image_mime: item.imageMime, image_data: item.imageData, created_at: item.createdAt
  });
}

function fromMessageRow(row) {
  return {
    id: row.id, conversationId: row.conversation_id, sessionId: row.session_id, sender: row.sender, body: row.body || "",
    imageName: row.image_name || "", imageMime: row.image_mime || "", imageData: row.image_data || "", createdAt: row.created_at || ""
  };
}

function toPushRow(item) {
  return { endpoint: item.endpoint, keys: item.keys || {}, user_agent: item.userAgent || "", created_at: item.createdAt || new Date().toISOString() };
}

function fromPushRow(row) {
  return { endpoint: row.endpoint, keys: row.keys || {}, userAgent: row.user_agent || "", createdAt: row.created_at || "" };
}

function toNoteRow(item) {
  return omitUndefined({
    conversation_id: item.conversationId, body: item.body, reminder_at: emptyToNull(item.reminderAt), reminder_sent_at: emptyToNull(item.reminderSentAt),
    completed_at: emptyToNull(item.completedAt), created_at: item.createdAt, updated_at: item.updatedAt
  });
}

function fromNoteRow(row) {
  return {
    id: row.id, conversationId: row.conversation_id, body: row.body || "", reminderAt: row.reminder_at || "",
    reminderSentAt: row.reminder_sent_at || "", completedAt: row.completed_at || "", createdAt: row.created_at || "", updatedAt: row.updated_at || ""
  };
}

function omitUndefined(obj) { return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)); }
function emptyToNull(value) { return value ? value : null; }

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

if (require.main === module) { start(); }

module.exports = { start, stop, server };