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
const ADMIN_USER = String(process.env.RUTH_ADMIN_USER || "ruth").trim();
const ADMIN_PASSWORD = String(process.env.RUTH_ADMIN_PASSWORD || "ruthistanbul").trim();
const ADMIN_USERS = parseAdminUsers(process.env.RUTH_ADMIN_USERS, ADMIN_USER, ADMIN_PASSWORD);
const SESSION_SECRET = String(process.env.RUTH_SESSION_SECRET || "change-this-secret-before-live").trim() || "change-this-secret-before-live";
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:info@ruthistanbul.com";
const SUPABASE_URL = normalizeSupabaseUrl(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const IKAS_STORE_NAME = String(process.env.IKAS_STORE_NAME || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/g, "").replace(/\.myikas\.com$/i, "");
const IKAS_CLIENT_ID = String(process.env.IKAS_CLIENT_ID || "").trim();
const IKAS_CLIENT_SECRET = String(process.env.IKAS_CLIENT_SECRET || "").trim();
const IKAS_GRAPHQL_URL = String(process.env.IKAS_GRAPHQL_URL || "https://api.myikas.com/api/v1/admin/graphql").trim();
const IKAS_TOKEN_URL = IKAS_STORE_NAME ? `https://${IKAS_STORE_NAME}.myikas.com/api/admin/oauth/token` : "";
const IKAS_STOREFRONT_URL = normalizeStorefrontUrl(process.env.IKAS_STOREFRONT_URL || process.env.RUTH_SITE_URL || "https://ruthistanbul.com");
const IKAS_FETCH_STOREFRONT_IMAGES = String(process.env.IKAS_FETCH_STOREFRONT_IMAGES || "1") !== "0";
let ikasTokenCache = { token: "", expiresAt: 0 };
let storefrontImageCache = { expiresAt: 0, bySlug: new Map(), byName: new Map(), urls: [] };
let ikasSummaryCache = { expiresAt: 0, value: null };
const MAX_IMAGE_BYTES = Number(process.env.RUTH_MAX_IMAGE_BYTES || 2_500_000);
const ADMIN_NOTIFICATION_TITLE = "RUTH ISTANBUL";

fs.mkdirSync(DATA_DIR, { recursive: true });

if (webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

let storage;
let reminderTimer = null;
const adminTypingState = new Map();

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
      return await handleCustomerMessage(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/chat/updates") {
      return await handleCustomerUpdates(url, res);
    }

    if (req.method === "POST" && url.pathname === "/api/event") {
      await readJson(req);
      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      return await handleLogin(req, res);
    }

    if (url.pathname.startsWith("/api/admin/")) {
      const admin = requireAdmin(req, res);
      if (!admin) return;
      return await handleAdminApi(req, res, url);
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
  const customerInfo = normalizeCustomerInfo(body.customerInfo || {});
  const hintedName = String(customerInfo.fullName || body.visitorName || "").trim().slice(0, 80);
  const guessedName = hintedName || guessVisitorName(text);
  const guessedPhone = customerInfo.phone || guessPhone(text);
  const customerMetaLine = buildCustomerMetaLine(customerInfo, guessedPhone);

  if (!text && !image) {
    return sendJson(res, {
      ok: false,
      message: "Mesajınızı alamadık. Lütfen tekrar yazar mısınız?"
    }, 400);
  }

  let conversation = await storage.getConversationBySessionId(sessionId);
  const visitorLabel = customerInfo.type === "member" ? "Üye müşteri" : "Misafir müşteri";
  if (!conversation) {
    conversation = await storage.createConversation({
      sessionId,
      visitorName: guessedName,
      visitorPhone: customerMetaLine || guessedPhone,
      visitorLabel,
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

  if (guessedName && conversation.visitorName !== guessedName) patch.visitorName = guessedName;
  if (customerMetaLine && conversation.visitorPhone !== customerMetaLine) patch.visitorPhone = customerMetaLine;
  else if (guessedPhone && !conversation.visitorPhone) patch.visitorPhone = guessedPhone;
  if (conversation.visitorLabel !== visitorLabel) patch.visitorLabel = visitorLabel;

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
    adminTyping: isAdminTyping(conversation.id),
    serverTime: new Date().toISOString()
  });
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const username = String(body.username || "").trim();
  const password = String(body.password || "").trim();
  if (!isValidAdminUser(username, password)) {
    return sendJson(res, { ok: false, error: "unauthorized" }, 401);
  }

  const token = signToken({ sub: username, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
  sendJson(res, { ok: true, token, user: { username } });
}

async function handleAdminApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/admin/me") {
    const admin = verifyToken(String(req.headers.authorization || "").startsWith("Bearer ") ? String(req.headers.authorization || "").slice(7) : "");
    return sendJson(res, {
      ok: true,
      user: { username: admin && admin.sub ? admin.sub : ADMIN_USERS[0].username },
      pushReady: Boolean(webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      vapidPublicKey: VAPID_PUBLIC_KEY || ""
    });
  }

  if (req.method === "GET" && pathname === "/api/admin/conversations") {
    const items = await storage.listConversations();
    return sendJson(res, { ok: true, conversations: items.map(adminConversation) });
  }

  const typingMatch = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/typing$/);
  if (req.method === "POST" && typingMatch) {
    const body = await readJson(req);
    const conversation = await storage.getConversation(typingMatch[1]);
    if (!conversation) return sendJson(res, { ok: false, error: "not_found" }, 404);
    setAdminTyping(conversation.id, body.typing === true);
    return sendJson(res, { ok: true, typing: isAdminTyping(conversation.id) });
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

    setAdminTyping(conversation.id, false);

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

  if (req.method === "GET" && pathname === "/api/admin/ikas/summary") {
    try {
      const summary = await buildIkasSummary();
      return sendJson(res, { ok: true, ...summary });
    } catch (error) {
      console.error("ikas summary error:", error && error.message ? error.message : error);
      return sendJson(res, {
        ok: true,
        connected: false,
        ikasError: error && error.message ? error.message : "ikas_error",
        totals: { orders: 0, units: 0, readyOrders: 0, readyUnits: 0, deliveredOrders: 0, revenue: 0, products: 0, collections: 0 },
        productTotals: [],
        readyProductTotals: [],
        orders: [],
        readyOrders: [],
        deliveredOrders: [],
        products: [],
        collections: [],
        message: "ikas bağlantısı kurulamadı. Render Environment Variables içindeki IKAS_STORE_NAME / IKAS_CLIENT_ID / IKAS_CLIENT_SECRET değerlerini kontrol et."
      });
    }
  }

  sendJson(res, { ok: false, error: "not_found" }, 404);
}

function ikasConfigured() {
  return Boolean(IKAS_STORE_NAME && IKAS_CLIENT_ID && IKAS_CLIENT_SECRET && IKAS_GRAPHQL_URL && IKAS_TOKEN_URL);
}

async function getIkasAccessToken() {
  if (!ikasConfigured()) {
    throw new Error("IKAS env eksik: IKAS_STORE_NAME, IKAS_CLIENT_ID ve IKAS_CLIENT_SECRET eklenmeli");
  }

  const now = Date.now();
  if (ikasTokenCache.token && ikasTokenCache.expiresAt > now + 60_000) {
    return ikasTokenCache.token;
  }

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", IKAS_CLIENT_ID);
  body.set("client_secret", IKAS_CLIENT_SECRET);

  const response = await fetch(IKAS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (error) {}

  if (!response.ok || !data.access_token) {
    throw new Error(`ikas token alınamadı (${response.status}): ${String(text || "").slice(0, 180)}`);
  }

  ikasTokenCache = {
    token: data.access_token,
    expiresAt: now + Math.max(60, Number(data.expires_in || 3600) - 120) * 1000
  };
  return ikasTokenCache.token;
}

async function ikasGraphQL(query, variables = {}, label = "ikas") {
  const token = await getIkasAccessToken();
  const response = await fetch(IKAS_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (error) {}

  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${String(text || "").slice(0, 500)}`);
  }
  if (data.errors && data.errors.length) {
    const details = data.errors.map((item) => {
      const ext = item && item.extensions ? ` ${JSON.stringify(item.extensions).slice(0, 220)}` : "";
      return `${item.message || JSON.stringify(item)}${ext}`;
    }).join(" | ");
    throw new Error(`${label}: ${details.slice(0, 700)}`);
  }
  return data.data || {};
}



async function fetchIkasPaginatedList({ label, rootField, fields, normalize, maxPages = 120 }) {
  const limit = 200;
  const all = [];
  const seen = new Set();
  const errors = [];

  async function runQuery(queryLabel, query) {
    const data = await ikasGraphQL(query, {}, queryLabel);
    const node = data && data[rootField];
    if (Array.isArray(node)) return { rows: node, hasNext: false };
    if (node && Array.isArray(node.data)) return { rows: node.data, hasNext: Boolean(node.hasNext) };
    return { rows: [], hasNext: false };
  }

  // ikas pagination max limit 200. Some stores reject optional arguments,
  // so this first tries paginated, then safely falls back to no-args.
  for (let page = 1; page <= maxPages; page += 1) {
    const q = `query RuthPaged${rootField}${page} { ${rootField}(pagination: { limit: ${limit}, page: ${page} }) { count hasNext limit page data { ${fields} } } }`;
    try {
      const { rows, hasNext } = await runQuery(`${label} page ${page}`, q);
      if (!rows.length) break;
      for (const row of rows) {
        const key = String(row && (row.id || row.orderNumber || row.name) || JSON.stringify(row).slice(0, 80));
        if (!seen.has(key)) {
          seen.add(key);
          all.push(row);
        }
      }
      if (!hasNext || rows.length < limit) break;
    } catch (error) {
      errors.push(error && error.message ? error.message : String(error));
      break;
    }
  }

  if (all.length) return normalize(all);

  const noArgQuery = `query RuthNoArg${rootField} { ${rootField} { data { ${fields} } } }`;
  try {
    const { rows } = await runQuery(`${label} no-args`, noArgQuery);
    return normalize(rows || []);
  } catch (error) {
    errors.push(error && error.message ? error.message : String(error));
  }

  throw new Error(errors.join(" || ").slice(0, 1800));
}


async function fetchIkasOrders() {
  const attempts = [
    {
      label: "ikas orders full",
      fields: `
        id
        orderNumber
        orderSequence
        orderedAt
        createdAt
        updatedAt
        status
        orderPackageStatus
        orderPaymentStatus
        totalFinalPrice
        totalPrice
        currencySymbol
        currencyCode
        customer { id fullName firstName lastName email phone isGuestCheckout }
        shippingAddress { firstName lastName phone city { name } district { name } }
        orderPackages { id orderPackageNumber orderPackageFulfillStatus trackingInfo { cargoCompany trackingNumber trackingLink } }
        orderLineItems {
          id
          quantity
          status
          finalPrice
          price
          options { name values { name value } }
          variant {
            id
            sku
            barcodeList
            name
            slug
            productId
            mainImageId
            categories { id name }
            variantValues { variantTypeName variantValueName }
          }
        }
      `
    },
    {
      label: "ikas orders safe",
      fields: `
        id
        orderNumber
        orderSequence
        orderedAt
        createdAt
        updatedAt
        status
        orderPackageStatus
        orderPaymentStatus
        totalFinalPrice
        totalPrice
        currencySymbol
        currencyCode
        customer { id fullName firstName lastName email phone isGuestCheckout }
        shippingAddress { firstName lastName phone }
        orderPackages { id orderPackageFulfillStatus }
        orderLineItems {
          id
          quantity
          status
          finalPrice
          price
          options { name values { name value } }
          variant {
            id
            sku
            name
            productId
            mainImageId
            variantValues { variantTypeName variantValueName }
          }
        }
      `
    },
    {
      label: "ikas orders minimal",
      fields: `
        id
        orderNumber
        orderSequence
        orderedAt
        createdAt
        updatedAt
        status
        orderPackageStatus
        orderPaymentStatus
        totalFinalPrice
        totalPrice
        currencySymbol
        currencyCode
        customer { id fullName firstName lastName email phone }
        orderLineItems {
          id
          quantity
          status
          finalPrice
          price
          options { name values { name value } }
          variant { id sku name }
        }
      `
    },
    {
      label: "ikas orders bare",
      fields: `
        id
        orderNumber
        orderSequence
        orderedAt
        createdAt
        updatedAt
        status
        orderPackageStatus
        orderPaymentStatus
        totalFinalPrice
        totalPrice
        currencySymbol
        currencyCode
        customer { id fullName firstName lastName email phone }
        orderLineItems { id quantity status finalPrice price }
      `
    }
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const orders = await fetchIkasPaginatedList({
        label: attempt.label,
        rootField: "listOrder",
        fields: attempt.fields,
        normalize: normalizeIkasOrders,
        maxPages: 180
      });
      if (Array.isArray(orders)) return orders;
    } catch (error) {
      errors.push(`${attempt.label}: ${error && error.message ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join(" || ").slice(0, 1800));
}

async function fetchIkasCategories() {
  if (!ikasConfigured()) return [];
  const queries = [
    { label: "ikas categories full", query: `query RuthListCategories { listCategory { id name imageId parentId categoryPath categoryPathItems { id name } } }` },
    { label: "ikas categories safe", query: `query RuthListCategoriesSafe { listCategory { id name parentId categoryPath } }` },
    { label: "ikas categories minimal", query: `query RuthListCategoriesMinimal { listCategory { id name } }` }
  ];
  const errors = [];
  for (const attempt of queries) {
    try {
      const data = await ikasGraphQL(attempt.query, {}, attempt.label);
      const rows = Array.isArray(data && data.listCategory) ? data.listCategory : [];
      return rows.map((category) => ({
        id: valueOrEmpty(category.id),
        name: valueOrEmpty(category.name) || "Koleksiyon",
        parentId: valueOrEmpty(category.parentId),
        imageId: valueOrEmpty(category.imageId),
        image: buildIkasImageUrl(category.imageId),
        categoryPath: Array.isArray(category.categoryPath) ? category.categoryPath : [],
        categoryPathItems: Array.isArray(category.categoryPathItems) ? category.categoryPathItems.map((item) => ({ id: valueOrEmpty(item.id), name: valueOrEmpty(item.name) })) : []
      })).filter((category) => category.id || category.name);
    } catch (error) {
      errors.push(error && error.message ? error.message : String(error));
    }
  }
  console.error("ikas categories error:", errors.join(" || ").slice(0, 900));
  return [];
}


async function fetchIkasProducts(categories = []) {
  if (!ikasConfigured()) return [];
  const categoryMap = new Map((categories || []).map((category) => [String(category.id), category]));
  const normalize = (rows) => normalizeIkasProducts(rows, categoryMap);

  // Product.variants is Variant[], but many ikas stores expose fewer fields on Variant.
  // Never ask name/mainImageId/productId from Product Variant; those caused GRAPHQL_VALIDATION_FAILED.
  const attempts = [
    {
      label: "ikas products full-safe",
      fields: `
        id
        name
        createdAt
        updatedAt
        totalStock
        categoryIds
        categories { id name }
        variants {
          id
          sku
          barcodeList
          isActive
          weight
          prices { sellPrice discountPrice }
          stocks { stockCount stockLocationId }
          variantValues { variantTypeName variantValueName }
        }
      `
    },
    {
      label: "ikas products categories-safe",
      fields: `
        id
        name
        createdAt
        updatedAt
        totalStock
        categoryIds
        categories { id name }
        variants { id sku barcodeList variantValues { variantTypeName variantValueName } }
      `
    },
    {
      label: "ikas products categoryIds-safe",
      fields: `
        id
        name
        createdAt
        updatedAt
        totalStock
        categoryIds
        variants { id sku barcodeList variantValues { variantTypeName variantValueName } }
      `
    },
    {
      label: "ikas products minimal-variants",
      fields: `
        id
        name
        totalStock
        categoryIds
        variants { id sku }
      `
    },
    {
      label: "ikas products bare",
      fields: `
        id
        name
        totalStock
        categoryIds
      `
    }
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const products = await fetchIkasPaginatedList({
        label: attempt.label,
        rootField: "listProduct",
        fields: attempt.fields,
        normalize,
        maxPages: 180
      });
      if (Array.isArray(products)) return products;
    } catch (error) {
      errors.push(`${attempt.label}: ${error && error.message ? error.message : String(error)}`);
    }
  }

  console.error("ikas products error:", errors.join(" || ").slice(0, 1800));
  return [];
}


function normalizeIkasProducts(rawProducts, categoryMap = new Map()) {
  return rawProducts.map((product) => {
    const categoryIds = Array.isArray(product.categoryIds)
      ? product.categoryIds.map(valueOrEmpty).filter(Boolean)
      : [];

    const directCategories = Array.isArray(product.categories)
      ? product.categories.map((category) => ({
          id: valueOrEmpty(category.id),
          name: valueOrEmpty(category.name) || "Kategori",
          image: buildIkasImageUrl(category.imageId),
          imageId: valueOrEmpty(category.imageId)
        })).filter((category) => category.id || category.name)
      : [];

    const categories = directCategories.length
      ? directCategories
      : categoryIds.map((id) => {
          const found = categoryMap.get(id);
          return found || { id, name: `Kategori ${id.slice(0, 6)}`, image: "", imageId: "" };
        }).filter((category) => category.id || category.name);

    const variants = Array.isArray(product.variants) ? product.variants.map((variant) => {
      const variantText = Array.isArray(variant.variantValues)
        ? variant.variantValues.map((value) => {
            const left = valueOrEmpty(value.variantTypeName);
            const right = valueOrEmpty(value.variantValueName);
            return right ? (left ? `${left}: ${right}` : right) : "";
          }).filter(Boolean).join(" / ")
        : "";
      const stockFromStocks = Array.isArray(variant.stocks)
        ? variant.stocks.reduce((sum, item) => sum + Number(item.stockCount || 0), 0)
        : 0;
      return {
        id: valueOrEmpty(variant.id),
        name: valueOrEmpty(product.name) || "Ürün",
        sku: valueOrEmpty(variant.sku),
        barcode: Array.isArray(variant.barcodeList) ? variant.barcodeList.join(", ") : "",
        mainImageId: "",
        image: "",
        productId: valueOrEmpty(product.id),
        slug: "",
        variantText,
        sellPrice: Number((variant.prices && variant.prices.sellPrice) || 0),
        discountPrice: Number((variant.prices && variant.prices.discountPrice) || 0),
        stock: stockFromStocks,
        isActive: typeof variant.isActive === "boolean" ? variant.isActive : true
      };
    }) : [];

    const image = "";
    return {
      id: valueOrEmpty(product.id),
      name: valueOrEmpty(product.name) || "Ürün",
      slug: "",
      image,
      mainImageId: "",
      totalStock: Number(product.totalStock || variants.reduce((sum, variant) => sum + Number(variant.stock || 0), 0) || 0),
      categoryIds: categoryIds.length ? categoryIds : categories.map((category) => category.id).filter(Boolean),
      categories,
      variants,
      createdAt: normalizeIkasDate(product.createdAt),
      updatedAt: normalizeIkasDate(product.updatedAt)
    };
  }).filter((product) => product.id || product.name);
}

function mergeOrderImagesIntoProducts(products, orders) {
  const byProductId = new Map();
  const byVariantId = new Map();
  orders.forEach((order) => {
    (order.items || []).forEach((item) => {
      if (item.productId && (item.image || item.mainImageId)) byProductId.set(item.productId, { image: item.image, mainImageId: item.mainImageId });
      if (item.variantId && (item.image || item.mainImageId)) byVariantId.set(item.variantId, { image: item.image, mainImageId: item.mainImageId });
    });
  });
  return products.map((product) => {
    let next = { ...product };
    const fromProduct = byProductId.get(product.id);
    if (!next.image && fromProduct) {
      next.image = fromProduct.image || buildIkasImageUrl(fromProduct.mainImageId);
      next.mainImageId = next.mainImageId || fromProduct.mainImageId || "";
    }
    next.variants = (next.variants || []).map((variant) => {
      const fromVariant = byVariantId.get(variant.id);
      if (!variant.image && fromVariant) return { ...variant, image: fromVariant.image || buildIkasImageUrl(fromVariant.mainImageId), mainImageId: variant.mainImageId || fromVariant.mainImageId || "" };
      return variant;
    });
    if (!next.image) next.image = (next.variants || []).find((variant) => variant.image)?.image || "";
    return next;
  });
}

function buildCollectionsFromProducts(products, categories = []) {
  const map = new Map();
  (categories || []).forEach((category) => {
    const key = category.id || category.name || "uncategorized";
    if (!map.has(key)) {
      map.set(key, { id: key, name: category.name || "Koleksiyon", image: category.image || "", imageId: category.imageId || "", productCount: 0, products: [] });
    }
  });

  products.forEach((product) => {
    const productCategories = product.categories && product.categories.length ? product.categories : [{ id: "uncategorized", name: "Koleksiyonsuz", image: "", imageId: "" }];
    productCategories.forEach((category) => {
      const key = category.id || category.name || "uncategorized";
      const existing = map.get(key) || { id: key, name: category.name || "Koleksiyonsuz", image: category.image || product.image || "", imageId: category.imageId || "", productCount: 0, products: [] };
      existing.productCount += 1;
      existing.products.push({ id: product.id, name: product.name, image: product.image, totalStock: product.totalStock });
      if (!existing.image && (category.image || product.image)) existing.image = category.image || product.image;
      map.set(key, existing);
    });
  });
  return [...map.values()].filter((item) => item.productCount || item.id !== "uncategorized").sort((a, b) => Number(b.productCount || 0) - Number(a.productCount || 0) || String(a.name).localeCompare(String(b.name), "tr"));
}

async function buildIkasSummary() {
  const cacheMs = Math.max(0, Number(process.env.IKAS_SUMMARY_CACHE_MS || 120000));
  if (cacheMs && ikasSummaryCache.value && ikasSummaryCache.expiresAt > Date.now()) {
    return ikasSummaryCache.value;
  }
  if (!ikasConfigured()) {
    return {
      connected: false,
      totals: { orders: 0, units: 0, readyOrders: 0, readyUnits: 0, deliveredOrders: 0, revenue: 0, products: 0, collections: 0 },
      productTotals: [],
      readyProductTotals: [],
      orders: [],
      readyOrders: [],
      deliveredOrders: [],
      products: [],
      collections: [],
      message: "ikas env değerleri bekleniyor."
    };
  }

  let orders = [];
  let products = [];
  let categories = [];
  let orderError = "";
  let productError = "";
  let categoryError = "";

  try {
    orders = await fetchIkasOrders();
  } catch (error) {
    orderError = error && error.message ? error.message : "siparişler çekilemedi";
    console.error("ikas orders error:", orderError);
    orders = [];
  }

  try {
    categories = await fetchIkasCategories();
  } catch (error) {
    categoryError = error && error.message ? error.message : "koleksiyonlar çekilemedi";
    console.error("ikas categories error:", categoryError);
    categories = [];
  }

  try {
    products = await fetchIkasProducts(categories);
  } catch (error) {
    productError = error && error.message ? error.message : "ürünler çekilemedi";
    console.error("ikas products error:", productError);
    products = [];
  }

  products = mergeOrderImagesIntoProducts(products, orders);
  await enrichIkasImagesDirectFromProductPages(orders, products, categories);
  await enrichIkasImagesFromStorefront(orders, products, categories);
  products = mergeOrderImagesIntoProducts(products, orders);
  const collections = buildCollectionsFromProducts(products, categories);
  const readyOrders = orders.filter(isReadyOrder).sort(orderNewestFirst);
  const deliveredOrders = orders.filter(isDeliveredOrder).sort(orderNewestFirst);
  const readyProductTotals = buildReadyProductTotals(readyOrders);
  const units = orders.reduce((sum, order) => sum + order.items.reduce((s, item) => s + Number(item.quantity || 0), 0), 0);
  const readyUnits = readyOrders.reduce((sum, order) => sum + order.items.reduce((s, item) => s + Number(item.quantity || 0), 0), 0);
  const revenue = orders.reduce((sum, order) => sum + Number(order.total || 0), 0);

  const summary = {
    connected: true,
    updatedAt: new Date().toISOString(),
    orderError,
    productError,
    categoryError,
    totals: {
      orders: orders.length,
      units,
      readyOrders: readyOrders.length,
      readyUnits,
      deliveredOrders: deliveredOrders.length,
      revenue,
      products: products.length,
      collections: collections.length
    },
    productTotals: readyProductTotals,
    readyProductTotals,
    orders: orders.sort(orderNewestFirst),
    readyOrders,
    deliveredOrders,
    products,
    collections,
    categories
  };
  ikasSummaryCache = { expiresAt: Date.now() + Math.max(0, Number(process.env.IKAS_SUMMARY_CACHE_MS || 120000)), value: summary };
  return summary;
}

function ikasDateSortValue(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value < 10000000000 ? value * 1000 : value;
  const raw = String(value).trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return num < 10000000000 ? num * 1000 : num;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderNewestFirst(a, b) {
  const bt = Number(b.orderSort || ikasDateSortValue(b.orderedAt) || b.orderSequence || b.orderNumber || 0);
  const at = Number(a.orderSort || ikasDateSortValue(a.orderedAt) || a.orderSequence || a.orderNumber || 0);
  return bt - at;
}

function normalizeIkasOrders(rawOrders) {
  return rawOrders.map((order) => {
    const customerName =
      valueOrEmpty(order.customer && order.customer.fullName) ||
      [order.customer && order.customer.firstName, order.customer && order.customer.lastName].filter(Boolean).join(" ").trim() ||
      [order.shippingAddress && order.shippingAddress.firstName, order.shippingAddress && order.shippingAddress.lastName].filter(Boolean).join(" ").trim() ||
      "Müşteri";

    const packageStatuses = Array.isArray(order.orderPackages)
      ? order.orderPackages.map((pkg) => String(pkg.orderPackageFulfillStatus || "").trim()).filter(Boolean)
      : [];

    const items = Array.isArray(order.orderLineItems) ? order.orderLineItems.map((item) => normalizeIkasLineItem(item, order)) : [];
    const dateSource = order.orderedAt || order.createdAt || order.updatedAt;

    return {
      id: valueOrEmpty(order.id),
      number: order.orderNumber ? `#${order.orderNumber}` : valueOrEmpty(order.id).slice(0, 8),
      orderNumber: valueOrEmpty(order.orderNumber),
      orderSequence: Number(order.orderSequence || order.orderNumber || 0),
      customer: customerName,
      phone: valueOrEmpty(order.customer && order.customer.phone) || valueOrEmpty(order.shippingAddress && order.shippingAddress.phone),
      email: valueOrEmpty(order.customer && order.customer.email),
      city: valueOrEmpty(order.shippingAddress && order.shippingAddress.city && order.shippingAddress.city.name),
      district: valueOrEmpty(order.shippingAddress && order.shippingAddress.district && order.shippingAddress.district.name),
      statusRaw: valueOrEmpty(order.status),
      packageStatusRaw: valueOrEmpty(order.orderPackageStatus) || packageStatuses[0] || "",
      paymentStatusRaw: valueOrEmpty(order.orderPaymentStatus),
      status: translateOrderStatus(order.status, order.orderPackageStatus, order.orderPaymentStatus),
      packageStatus: translatePackageStatus(order.orderPackageStatus || packageStatuses[0] || ""),
      paymentStatus: translatePaymentStatus(order.orderPaymentStatus),
      orderedAt: normalizeIkasDate(dateSource),
      orderSort: ikasDateSortValue(dateSource) || Number(order.orderSequence || order.orderNumber || 0),
      total: Number(order.totalFinalPrice ?? order.totalPrice ?? 0),
      currency: valueOrEmpty(order.currencySymbol) || valueOrEmpty(order.currencyCode) || "₺",
      items
    };
  }).sort(orderNewestFirst);
}


function normalizeIkasLineItem(item, order) {
  const variant = item && item.variant ? item.variant : {};
  const variantText = buildVariantText(item, variant);
  const name = valueOrEmpty(variant.name) || valueOrEmpty(item && item.name) || "Ürün";
  const mainImageId = valueOrEmpty(variant.mainImageId);
  return {
    id: valueOrEmpty(item && item.id) || valueOrEmpty(variant.id),
    variantId: valueOrEmpty(variant.id),
    productId: valueOrEmpty(variant.productId),
    name: variantText ? `${name} — ${variantText}` : name,
    baseName: name,
    variantText,
    sku: valueOrEmpty(variant.sku),
    slug: valueOrEmpty(variant.slug),
    image: buildIkasImageUrl(mainImageId),
    mainImageId,
    categories: Array.isArray(variant.categories) ? variant.categories.map((category) => ({ id: valueOrEmpty(category.id), name: valueOrEmpty(category.name) })).filter((category) => category.id || category.name) : [],
    quantity: Number((item && item.quantity) || 0),
    statusRaw: valueOrEmpty(item && item.status),
    status: translateLineStatus(item && item.status),
    orderNumber: order && order.orderNumber ? `#${order.orderNumber}` : "",
    orderId: valueOrEmpty(order && order.id)
  };
}

function buildVariantText(item, variant) {
  const parts = [];

  if (variant && Array.isArray(variant.variantValues)) {
    variant.variantValues.forEach((value) => {
      const left = valueOrEmpty(value.variantTypeName);
      const right = valueOrEmpty(value.variantValueName);
      if (right) parts.push(left ? `${left}: ${right}` : right);
    });
  }

  if (item && Array.isArray(item.options)) {
    item.options.forEach((option) => {
      const name = valueOrEmpty(option.name);
      const values = Array.isArray(option.values)
        ? option.values.map((v) => valueOrEmpty(v.name) || valueOrEmpty(v.value)).filter(Boolean)
        : [];
      if (values.length) parts.push(name ? `${name}: ${values.join(", ")}` : values.join(", "));
    });
  }

  return [...new Set(parts)].join(" / ");
}

function buildIkasImageUrl(mainImageId) {
  const id = valueOrEmpty(mainImageId);
  if (!id) return "";
  if (/^https?:\/\//i.test(id)) return id;
  const base = String(process.env.IKAS_IMAGE_BASE_URL || "").trim().replace(/\/+$/, "");
  if (base) return `${base}/${encodeURIComponent(id)}`;
  return "";
}


async function enrichIkasImagesDirectFromProductPages(orders, products, categories) {
  if (!IKAS_FETCH_STOREFRONT_IMAGES || !IKAS_STOREFRONT_URL) return;
  const targets = [];
  const pushTarget = (kind, item, setter) => {
    if (!item || item.image) return;
    const candidates = buildStorefrontProductUrlCandidates(item);
    if (!candidates.length) return;
    targets.push({ kind, item, setter, candidates });
  };

  (products || []).forEach((product) => {
    pushTarget("product", product, (image) => { product.image = image; });
    (product.variants || []).forEach((variant) => {
      pushTarget("variant", { ...variant, name: product.name, baseName: product.name, productSlug: product.slug }, (image) => {
        variant.image = image;
        if (!product.image) product.image = image;
      });
    });
  });

  (orders || []).forEach((order) => {
    (order.items || []).forEach((item) => {
      pushTarget("orderItem", item, (image) => { item.image = image; });
    });
  });

  if (!targets.length) return;
  const limit = Math.max(1, Math.min(1200, Number(process.env.IKAS_DIRECT_IMAGE_LIMIT || 1200)));
  const limited = targets.slice(0, limit);
  const concurrency = Math.max(1, Math.min(8, Number(process.env.IKAS_DIRECT_IMAGE_CONCURRENCY || 5)));
  let index = 0;
  let found = 0;

  async function worker() {
    while (index < limited.length) {
      const target = limited[index++];
      try {
        for (const url of target.candidates) {
          const info = await fetchStorefrontProductImage(url);
          if (info && info.image) {
            target.setter(info.image);
            found += 1;
            break;
          }
        }
      } catch (error) {}
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  // Sipariş satırındaki görseli aynı SKU/ürün adına sahip ürün kartlarına da yay.
  const byName = new Map();
  const bySku = new Map();
  (orders || []).forEach((order) => {
    (order.items || []).forEach((item) => {
      if (!item || !item.image) return;
      if (item.sku) bySku.set(String(item.sku).toLowerCase(), item.image);
      const key = normalizeLookupText(item.baseName || item.name);
      if (key) byName.set(key, item.image);
    });
  });
  (products || []).forEach((product) => {
    if (!product.image) {
      const key = normalizeLookupText(product.name);
      const img = key ? byName.get(key) : "";
      if (img) product.image = img;
    }
    (product.variants || []).forEach((variant) => {
      if (!variant.image && variant.sku && bySku.has(String(variant.sku).toLowerCase())) variant.image = bySku.get(String(variant.sku).toLowerCase());
      if (!product.image && variant.image) product.image = variant.image;
    });
  });

  if (found) console.log(`Ikas direct storefront images matched: ${found}`);
}

function buildStorefrontProductUrlCandidates(item) {
  const slugs = [];
  const pushSlug = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    if (/^https?:\/\//i.test(raw)) {
      slugs.push(raw);
      return;
    }
    const clean = normalizeSlug(raw.replace(/^\/+|\/+$/g, ""));
    if (clean) slugs.push(clean);
  };

  pushSlug(item.slug);
  pushSlug(item.productSlug);
  pushSlug(item.handle);

  const names = [item.baseName, item.name].filter(Boolean);
  names.forEach((name) => {
    const base = String(name || "").replace(/—.*$/g, "").replace(/\s+-\s+.*$/g, "").trim();
    pushSlug(base);
    // Ruth ürünlerinde bazı brass ürün URL'lerinde "the" düşebiliyor ve sona brass eklenebiliyor.
    const withoutThe = base.replace(/^the\s+/i, "");
    if (withoutThe !== base) pushSlug(withoutThe);
    if (/ring|necklace|bracelet|set/i.test(base)) {
      pushSlug(`${base} brass`);
      if (withoutThe !== base) pushSlug(`${withoutThe} brass`);
    }
  });

  const unique = [...new Set(slugs)].slice(0, 8);
  return unique.map((slug) => {
    if (/^https?:\/\//i.test(slug)) return slug;
    return new URL(`/${slug}`, IKAS_STOREFRONT_URL).toString();
  });
}

async function enrichIkasImagesFromStorefront(orders, products, categories) {
  if (!IKAS_FETCH_STOREFRONT_IMAGES || !IKAS_STOREFRONT_URL) return;
  let imageMap = null;
  try {
    imageMap = await getStorefrontImageMap();
  } catch (error) {
    console.error("storefront image map error:", error && error.message ? error.message : error);
    return;
  }
  if (!imageMap || (!imageMap.bySlug.size && !imageMap.byName.size)) return;

  const resolve = (item) => {
    if (!item || item.image) return item && item.image || "";
    const candidates = [];
    [item.slug, item.productSlug, item.handle].forEach((value) => { if (value) candidates.push(String(value)); });
    [item.name, item.baseName].forEach((value) => { if (value) candidates.push(slugifyForUrl(value)); });
    for (const candidate of candidates) {
      const key = normalizeSlug(candidate);
      if (key && imageMap.bySlug.has(key)) return imageMap.bySlug.get(key).image || "";
    }
    const nameKeys = [item.baseName, item.name].map(normalizeLookupText).filter(Boolean);
    for (const key of nameKeys) {
      if (imageMap.byName.has(key)) return imageMap.byName.get(key).image || "";
    }
    return "";
  };

  (orders || []).forEach((order) => {
    (order.items || []).forEach((item) => {
      const image = resolve(item);
      if (image) item.image = image;
    });
  });

  (products || []).forEach((product) => {
    const image = resolve(product);
    if (image) product.image = image;
    (product.variants || []).forEach((variant) => {
      const variantImage = resolve({ ...variant, name: product.name, baseName: product.name, productSlug: product.slug });
      if (variantImage) variant.image = variantImage;
    });
    if (!product.image) product.image = (product.variants || []).find((variant) => variant.image)?.image || "";
  });

  (categories || []).forEach((category) => {
    if (category.image) return;
    const key = normalizeLookupText(category.name);
    if (key && imageMap.byName.has(key)) category.image = imageMap.byName.get(key).image || "";
  });
}

async function getStorefrontImageMap() {
  const now = Date.now();
  if (storefrontImageCache.expiresAt > now) return storefrontImageCache;
  const bySlug = new Map();
  const byName = new Map();
  const urls = await discoverStorefrontProductUrls();
  const limited = urls.slice(0, Number(process.env.IKAS_STOREFRONT_IMAGE_LIMIT || 900));
  const concurrency = Math.max(1, Math.min(8, Number(process.env.IKAS_STOREFRONT_IMAGE_CONCURRENCY || 5)));
  let index = 0;
  async function worker() {
    while (index < limited.length) {
      const url = limited[index++];
      try {
        const info = await fetchStorefrontProductImage(url);
        if (!info || !info.image) continue;
        if (info.slug) bySlug.set(normalizeSlug(info.slug), info);
        if (info.title) byName.set(normalizeLookupText(info.title), info);
      } catch (error) {}
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  storefrontImageCache = { expiresAt: now + 30 * 60 * 1000, bySlug, byName, urls: limited };
  return storefrontImageCache;
}

async function discoverStorefrontProductUrls() {
  const sitemapUrls = [new URL("/sitemap.xml", IKAS_STOREFRONT_URL).toString()];
  const seenSitemaps = new Set();
  const productUrls = new Set();

  for (let i = 0; i < sitemapUrls.length && i < 20; i += 1) {
    const sitemapUrl = sitemapUrls[i];
    if (seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    let xml = "";
    try { xml = await fetchText(sitemapUrl); } catch (error) { continue; }
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => decodeHtmlEntity(m[1].trim()));
    locs.forEach((loc) => {
      if (/\.xml(\?|$)/i.test(loc) && sitemapUrls.length < 20) sitemapUrls.push(loc);
      else if (isLikelyProductUrl(loc)) productUrls.add(stripQueryHash(loc));
    });
  }

  if (!productUrls.size) {
    // Bazı ikas temalarında sitemap ürün URL'lerini gizleyebiliyor. Yine de ana sayfadan yakalamayı deneriz.
    try {
      const html = await fetchText(IKAS_STOREFRONT_URL);
      extractProductUrlsFromHtml(html, IKAS_STOREFRONT_URL).forEach((url) => productUrls.add(url));
    } catch (error) {}
  }

  return [...productUrls];
}

function isLikelyProductUrl(url) {
  const text = String(url || "");
  return /\/(products|product|urun|ürün)\//i.test(text);
}

function extractProductUrlsFromHtml(html, baseUrl) {
  const urls = new Set();
  const re = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    try {
      const absolute = new URL(match[1], baseUrl).toString();
      if (isLikelyProductUrl(absolute)) urls.add(stripQueryHash(absolute));
    } catch (error) {}
  }
  return [...urls];
}

async function fetchStorefrontProductImage(url) {
  const html = await fetchText(url);
  const image = absolutizeUrl(
    pickMeta(html, "og:image") ||
    pickMeta(html, "twitter:image") ||
    pickJsonLdImage(html) ||
    "",
    url
  );
  const title = cleanStorefrontTitle(
    pickMeta(html, "og:title") ||
    pickMeta(html, "twitter:title") ||
    pickTitle(html) ||
    ""
  );
  const slug = getSlugFromUrl(url);
  return { url, slug, title, image };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 RuthIstanbulPanel/1.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`fetch ${response.status} ${url}`);
  return response.text();
}

function pickMeta(html, property) {
  const safe = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${safe}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${safe}["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match && match[1]) return decodeHtmlEntity(match[1]);
  }
  return "";
}

function pickTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntity(match[1].replace(/\s+/g, " ").trim()) : "";
}

function pickJsonLdImage(html) {
  const scripts = [...String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const data = JSON.parse(script[1].trim());
      const found = findImageInJsonLd(data);
      if (found) return found;
    } catch (error) {}
  }
  return "";
}

function findImageInJsonLd(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageInJsonLd(item);
      if (found) return found;
    }
  }
  if (typeof value === "object") {
    if (value["@type"] && String(value["@type"]).toLowerCase().includes("product") && value.image) {
      if (Array.isArray(value.image)) return String(value.image[0] || "");
      if (typeof value.image === "object") return String(value.image.url || value.image.contentUrl || "");
      return String(value.image || "");
    }
    for (const key of Object.keys(value)) {
      const found = findImageInJsonLd(value[key]);
      if (found) return found;
    }
  }
  return "";
}

function cleanStorefrontTitle(title) {
  return String(title || "").replace(/\s*[|•-]\s*RUTH\s*ISTANBUL.*$/i, "").replace(/\s*[|•-]\s*Ruth.*$/i, "").trim();
}

function absolutizeUrl(url, baseUrl) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try { return new URL(raw, baseUrl).toString(); } catch (error) { return raw; }
}

function stripQueryHash(url) {
  try { const u = new URL(url); u.hash = ""; u.search = ""; return u.toString(); } catch (error) { return String(url || ""); }
}

function getSlugFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch (error) {
    return "";
  }
}

function normalizeSlug(value) {
  return slugifyForUrl(String(value || "").replace(/^\/+|\/+$/g, ""));
}

function slugifyForUrl(value) {
  return String(value || "")
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLookupText(value) {
  return slugifyForUrl(String(value || "").replace(/—.*$/g, "").replace(/\s+-\s+.*$/g, ""));
}

function normalizeStorefrontUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function decodeHtmlEntity(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function buildReadyProductTotals(readyOrders) {
  const map = new Map();

  readyOrders.forEach((order) => {
    order.items.forEach((item) => {
      const key = item.variantId || item.sku || item.name;
      const existing = map.get(key) || {
        key,
        name: item.name,
        baseName: item.baseName,
        variantText: item.variantText,
        sku: item.sku,
        image: item.image,
        mainImageId: item.mainImageId,
        quantity: 0,
        orders: []
      };
      existing.quantity += Number(item.quantity || 0);
      existing.orders.push({ orderNumber: order.number, quantity: Number(item.quantity || 0), customer: order.customer });
      if (!existing.image && item.image) existing.image = item.image;
      map.set(key, existing);
    });
  });

  return [...map.values()].sort((a, b) => Number(b.quantity || 0) - Number(a.quantity || 0));
}

function isReadyOrder(order) {
  const values = [
    order && order.packageStatusRaw,
    order && order.statusRaw,
    ...(order && order.items ? order.items.map((item) => item.statusRaw) : [])
  ].map((value) => String(value || "").toUpperCase());

  return values.some((value) =>
    value.includes("READY_FOR_SHIPMENT") ||
    value.includes("READY_TO_SHIP") ||
    value.includes("READY")
  );
}

function isDeliveredOrder(order) {
  const values = [
    order && order.packageStatusRaw,
    order && order.statusRaw,
    ...(order && order.items ? order.items.map((item) => item.statusRaw) : [])
  ].map((value) => String(value || "").toUpperCase());

  return values.some((value) =>
    value.includes("DELIVERED") ||
    value.includes("FULFILLED") ||
    value.includes("COMPLETED")
  );
}

function translateOrderStatus(status, packageStatus, paymentStatus) {
  const packageText = translatePackageStatus(packageStatus);
  const raw = String(status || "").toUpperCase();
  if (packageText && packageText !== "Durum Yok") return packageText;
  if (!raw) return translatePaymentStatus(paymentStatus) || "Yeni";
  if (raw.includes("CANCEL")) return "İptal Edildi";
  if (raw.includes("REFUND")) return "İade Edildi";
  if (raw.includes("FULFILLED") || raw.includes("DELIVERED") || raw.includes("COMPLETED")) return "Teslim Edildi";
  if (raw.includes("READY")) return "Kargoya Hazır";
  if (raw.includes("OPEN") || raw.includes("CREATED")) return "Yeni";
  return humanizeEnum(raw);
}

function translatePackageStatus(status) {
  const raw = String(status || "").toUpperCase();
  if (!raw) return "Durum Yok";
  if (raw.includes("READY_FOR_SHIPMENT") || raw.includes("READY_TO_SHIP") || raw.includes("READY")) return "Kargoya Hazır";
  if (raw.includes("FULFILLED") || raw.includes("DELIVERED") || raw.includes("COMPLETED")) return "Teslim Edildi";
  if (raw.includes("CANCEL")) return "İptal Edildi";
  if (raw.includes("REFUND")) return "İade Edildi";
  if (raw.includes("UNFULFILLED")) return "Hazırlanıyor";
  return humanizeEnum(raw);
}

function translatePaymentStatus(status) {
  const raw = String(status || "").toUpperCase();
  if (!raw) return "";
  if (raw.includes("PAID")) return "Ödendi";
  if (raw.includes("PENDING")) return "Ödeme Bekliyor";
  if (raw.includes("REFUND")) return "İade Edildi";
  if (raw.includes("CANCEL")) return "İptal Edildi";
  return humanizeEnum(raw);
}

function translateLineStatus(status) {
  const raw = String(status || "").toUpperCase();
  if (!raw) return "";
  if (raw.includes("READY")) return "Kargoya Hazır";
  if (raw.includes("FULFILLED") || raw.includes("DELIVERED") || raw.includes("COMPLETED")) return "Teslim Edildi";
  if (raw.includes("CANCEL")) return "İptal Edildi";
  if (raw.includes("REFUND")) return "İade Edildi";
  return humanizeEnum(raw);
}

function humanizeEnum(value) {
  return String(value || "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase("tr") + part.slice(1))
    .join(" ");
}

function valueOrEmpty(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeIkasDate(value) {
  const ms = ikasDateSortValue(value);
  if (!ms) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function setAdminTyping(conversationId, typing) {
  if (!conversationId) return;
  if (typing) {
    adminTypingState.set(String(conversationId), { typing: true, updatedAt: Date.now() });
  } else {
    adminTypingState.delete(String(conversationId));
  }
}

function isAdminTyping(conversationId) {
  const state = adminTypingState.get(String(conversationId));
  if (!state) return false;
  if (Date.now() - Number(state.updatedAt || 0) > 7000) {
    adminTypingState.delete(String(conversationId));
    return false;
  }
  return true;
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
  <meta name="theme-color" content="#08090b">
  <link rel="manifest" href="/manifest.webmanifest">
  <title>RUTH ISTANBUL Panel</title>
  <style>
    :root{
      --bg:#050607;
      --bg-soft:#0a0b0d;
      --sidebar:#090a0c;
      --panel:#111215;
      --panel-2:#15171a;
      --panel-3:#1a1c20;
      --line:#272a30;
      --line-soft:#1d2025;
      --text:#f7f2e8;
      --text-2:#d8d2c7;
      --muted:#8b8479;
      --muted-2:#68625b;
      --gold:#d4a237;
      --gold-2:#f0c66b;
      --gold-3:#9f7327;
      --gold-soft:rgba(212,162,55,.16);
      --green:#3bc77a;
      --danger:#ef6464;
      --shadow:0 18px 55px rgba(0,0,0,.42);
      --sidebar-w:282px;
      --top-h:68px;
      --radius:14px;
      color-scheme:dark;
    }
    *{box-sizing:border-box}
    html,body{min-height:100%; height:auto;}
    body{
      margin:0;
      overflow-y:auto;
      overflow-x:hidden;
      background:radial-gradient(circle at 72% 5%,rgba(212,162,55,.095),transparent 32%),linear-gradient(180deg,#090a0c 0%,#050607 55%,#030404 100%);
      color:var(--text);
      font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Arial,sans-serif;
      font-size:14px;
      letter-spacing:-.011em;
    }
    body:before{content:"";position:fixed;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.65),transparent 72%);opacity:.6}
    button,input,textarea{font:inherit;color:inherit}
    button{cursor:pointer;touch-action:manipulation}
    .hidden{display:none!important}
    .login-page{min-height:100dvh;display:grid;place-items:center;padding:22px;background:radial-gradient(circle at 50% 18%,rgba(212,162,55,.18),transparent 31%)}
    .login-card{width:min(420px,100%);border:1px solid rgba(212,162,55,.24);background:linear-gradient(180deg,rgba(20,22,25,.92),rgba(7,8,10,.96));border-radius:18px;padding:28px;box-shadow:var(--shadow);animation:rise .32s ease both}
    .brand{display:flex;align-items:center;gap:13px;min-width:0}
    .brand-mark{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:#08090b;border:1px solid rgba(212,162,55,.55);box-shadow:inset 0 0 0 1px rgba(255,255,255,.04),0 0 28px rgba(212,162,55,.09);color:var(--gold-2);font:700 30px Georgia,"Times New Roman",serif;flex:0 0 auto}
    .brand-word{font-family:Georgia,"Times New Roman",serif;letter-spacing:.12em;text-transform:uppercase;font-size:18px;color:#e8c679;white-space:nowrap}
    .brand-sub{font-size:12px;color:var(--muted);margin-top:2px}
    .login-card h1{margin:28px 0 8px;font-size:28px;line-height:1.05;letter-spacing:-.045em;font-weight:780}
    .login-card p{margin:0 0 22px;color:var(--muted);line-height:1.55}
    .field{display:grid;gap:7px;margin:13px 0}.field label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:750}
    .input,.textarea{width:100%;border:1px solid var(--line);border-radius:12px;background:#090a0c;color:var(--text);outline:none;padding:12px 13px;transition:border .18s,box-shadow .18s,background .18s}.textarea{resize:none;min-height:88px;max-height:180px}.input:focus,.textarea:focus{border-color:rgba(212,162,55,.62);box-shadow:0 0 0 4px rgba(212,162,55,.10);background:#0f1012}.error{min-height:20px;color:#ffaaa4;font-size:13px;margin-top:8px}
    .app{min-height:100dvh;height:auto;display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr);background:transparent}.app.nav-mini{--sidebar-w:78px}.sidebar{display:grid;grid-template-rows:var(--top-h) 1fr auto;min-width:0;background:linear-gradient(180deg,rgba(12,13,15,.96),rgba(6,7,8,.96));border-right:1px solid var(--line);z-index:40;transition:transform .2s, width .2s}.side-head{height:var(--top-h);display:flex;align-items:center;gap:12px;padding:0 20px;border-bottom:1px solid var(--line)}.app.nav-mini .side-head{justify-content:center;padding:0}.app.nav-mini .brand-copy,.app.nav-mini .nav-label,.app.nav-mini .nav-badge,.app.nav-mini .nav-heading,.app.nav-mini .side-foot span{display:none}.app.nav-mini .nav-item{justify-content:center;padding:12px}.nav{overflow:auto;padding:12px 10px}.nav-heading{padding:18px 10px 8px;color:#7d7569;font-size:12px;letter-spacing:.11em;text-transform:uppercase;font-weight:720}.nav-item{width:100%;border:1px solid transparent;border-radius:8px;background:transparent;color:#d6d1c8;display:flex;align-items:center;gap:12px;padding:12px 14px;text-decoration:none;font-weight:620;letter-spacing:-.01em;transition:background .15s,border-color .15s,transform .15s,color .15s}.nav-item:hover{background:rgba(255,255,255,.045);border-color:var(--line);transform:translateX(2px);color:#fff}.nav-item.active{background:linear-gradient(90deg,rgba(212,162,55,.18),rgba(212,162,55,.06));border-color:rgba(212,162,55,.22);color:#fff}.nav-ico{width:20px;height:20px;display:grid;place-items:center;color:var(--gold-2);flex:0 0 auto}.nav-ico svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.9}.nav-badge{margin-left:auto;min-width:28px;height:22px;border-radius:999px;background:#f0c66b;color:#100b04;display:grid;place-items:center;font-size:12px;font-weight:850;padding:0 7px}.side-foot{border-top:1px solid var(--line);padding:12px;display:grid;gap:8px}.main{display:grid;grid-template-rows:var(--top-h) auto;min-width:0;min-height:100dvh}.topbar{height:var(--top-h);display:flex;align-items:center;justify-content:space-between;gap:14px;border-bottom:1px solid var(--line);background:rgba(7,8,10,.78);backdrop-filter:blur(18px);padding:0 22px;z-index:20}.top-left{display:flex;align-items:center;gap:14px}.crumb-title{font-size:15px;font-weight:730}.top-actions{display:flex;align-items:center;gap:12px}.top-icon{width:38px;height:38px;border:0;background:transparent;border-radius:10px;color:#d5cec2;display:grid;place-items:center;position:relative}.top-icon:hover{background:rgba(255,255,255,.05)}.top-dot{position:absolute;right:4px;top:3px;min-width:18px;height:18px;border-radius:999px;background:#f0c66b;color:#0c0803;font-size:11px;font-weight:850;display:grid;place-items:center}.profile{display:flex;align-items:center;gap:12px;min-width:0}.avatar{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;border:1px solid rgba(212,162,55,.50);background:#08090b;color:var(--gold-2);font:700 25px Georgia,"Times New Roman",serif}.profile-name{font-weight:760}.profile-role{font-size:12px;color:var(--muted)}.mobile-menu{display:none}.icon-btn,.btn{border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.032);color:var(--text);display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:700;transition:transform .16s,border-color .16s,background .16s,box-shadow .16s}.icon-btn{width:38px;height:38px;padding:0}.btn{padding:10px 14px}.btn:hover,.icon-btn:hover{transform:translateY(-1px);border-color:rgba(212,162,55,.36);background:rgba(255,255,255,.055);box-shadow:0 12px 28px rgba(0,0,0,.18)}.btn.gold{background:linear-gradient(180deg,#efc86b,#b9862a);border-color:#c99737;color:#130c03}.btn.ghost{background:transparent}.btn.full{width:100%}.btn:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}.content{overflow:visible;padding:20px 24px 26px;min-height:calc(100dvh - var(--top-h))}.page{display:none;animation:fade .18s ease both}.page.active{display:block}.layout-overview{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:18px}.welcome{height:122px;border:1px solid var(--line);border-radius:8px;background:linear-gradient(135deg,rgba(255,255,255,.045),rgba(255,255,255,.015));display:flex;align-items:center;justify-content:space-between;padding:24px 28px;margin-bottom:18px;box-shadow:0 18px 45px rgba(0,0,0,.18)}.welcome h1{margin:0 0 10px;font-size:28px;line-height:1.05;letter-spacing:-.046em;font-weight:780}.welcome p{margin:0;color:var(--muted)}.date-pill{border:1px solid var(--line);border-radius:8px;background:#0c0d0f;padding:12px 16px;color:#f0eee8;min-width:210px;display:flex;align-items:center;justify-content:space-between}.head-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.date-filter{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--line);background:rgba(255,255,255,.025);border-radius:12px;padding:7px}.date-select,.date-input{border:1px solid var(--line);border-radius:9px;background:#090a0c;color:var(--text);outline:none;padding:9px 10px;font-weight:650}.date-select:focus,.date-input:focus{border-color:rgba(212,162,55,.55);box-shadow:0 0 0 3px rgba(212,162,55,.10)}.date-input{width:145px}.date-custom{display:none;align-items:center;gap:7px}.date-filter.custom .date-custom{display:flex}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:16px}.metric{height:126px;border:1px solid var(--line);border-radius:8px;background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.015));padding:18px 18px;position:relative;overflow:hidden}.metric:after{content:"";position:absolute;right:16px;bottom:15px;width:58px;height:24px;border-bottom:2px solid var(--gold);border-right:2px solid var(--gold);transform:skew(-32deg) rotate(-10deg);opacity:.9}.metric-row{display:flex;align-items:center;gap:14px}.metric-ico,.module-ico{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:rgba(212,162,55,.14);border:1px solid rgba(212,162,55,.20);color:var(--gold-2)}.metric-label{color:#bdb6ab;font-size:13px;margin-bottom:4px}.metric-num{font-size:27px;font-weight:780;letter-spacing:-.035em}.metric-sub{margin-top:10px;color:#c4beb4;font-size:13px}.modules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:16px}.module{min-height:220px;border:1px solid rgba(212,162,55,.22);border-radius:8px;background:radial-gradient(circle at 50% 0%,rgba(212,162,55,.08),transparent 38%),linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.012));display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:26px;transition:transform .16s,border-color .16s,box-shadow .16s}.module:hover{transform:translateY(-3px);border-color:rgba(212,162,55,.50);box-shadow:0 22px 60px rgba(0,0,0,.25)}.module h3{margin:15px 0 9px;font-size:17px;letter-spacing:.01em}.module p{margin:0;color:#d5cec4;line-height:1.55}.module .btn{margin-top:20px;min-width:184px}.bottom-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}.card{border:1px solid var(--line);border-radius:8px;background:rgba(15,16,19,.82);padding:18px;min-width:0}.card-title{font-size:16px;font-weight:780;margin-bottom:14px}.list{display:grid;gap:10px}.mini-row,.conversation,.customer-row,.product-row,.order-row,.quick-row,.note{border:1px solid transparent;border-radius:8px;padding:10px 12px;background:rgba(255,255,255,.018)}.conversation,.customer-row{cursor:pointer}.conversation:hover,.customer-row:hover,.quick-row:hover{background:rgba(255,255,255,.04);border-color:var(--line)}.conversation.active,.customer-row.active{border-color:rgba(212,162,55,.30);background:rgba(212,162,55,.10)}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.name{font-weight:730;color:#f4f0e9}.preview{font-size:12px;color:var(--muted);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.time{font-size:12px;color:var(--muted)}.badge{display:inline-grid;place-items:center;min-width:22px;height:22px;border-radius:999px;background:#f0c66b;color:#100b04;font-size:12px;font-weight:850;padding:0 7px}.empty{color:var(--muted);padding:18px;text-align:center}.right-rail{display:grid;gap:14px;align-content:start}.quick-row{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;padding:14px}.quick-left{display:flex;align-items:center;gap:12px}.rail-product{display:grid;grid-template-columns:48px minmax(0,1fr);gap:12px;align-items:center}.prod-img{width:48px;height:48px;border-radius:6px;background:linear-gradient(135deg,#2b2d31,#111215);border:1px solid var(--line);display:grid;place-items:center;color:var(--gold-2);overflow:hidden}.prod-img img{width:100%;height:100%;object-fit:cover}.page-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}.page-title{font-size:27px;line-height:1.1;letter-spacing:-.045em;font-weight:780}.page-sub{color:var(--muted);margin-top:6px}.support-grid{display:grid;grid-template-columns:330px minmax(0,1fr) 300px;gap:14px;height:calc(100dvh - 128px)}.crm-grid{display:grid;grid-template-columns:360px minmax(0,1fr);gap:14px;height:calc(100dvh - 128px)}.orders-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(360px,.8fr);gap:14px}.panel{border:1px solid var(--line);border-radius:8px;background:rgba(15,16,19,.82);min-width:0;overflow:hidden;display:flex;flex-direction:column}.panel-head{padding:16px 17px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px}.panel-title{font-weight:780}.panel-body{padding:14px;overflow:auto;min-height:0}.message-space{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px}.msg{max-width:72%;border:1px solid var(--line);border-radius:12px;padding:11px 12px;line-height:1.45;background:#17191d;color:#f4f0ea}.msg.admin{align-self:flex-end;background:linear-gradient(180deg,#d9ac4a,#b88227);color:#100b03;border-color:#c49133}.msg.customer,.msg.system{align-self:flex-start}.msg img{display:block;max-width:240px;border-radius:9px;margin-top:8px}.meta{font-size:11px;opacity:.65;margin-top:7px}.composer{border-top:1px solid var(--line);padding:14px;display:grid;grid-template-columns:1fr auto;gap:10px}.info-line{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line-soft);padding:12px 0;gap:12px}.info-line span:first-child{color:var(--muted)}.note.done{opacity:.58}.note-body{line-height:1.45}.note-meta{font-size:12px;color:var(--muted);margin-top:8px}.product-row,.order-row{display:grid;grid-template-columns:54px minmax(0,1fr) auto;gap:12px;align-items:center;padding:13px}.qty{font-size:22px;font-weight:780;color:var(--gold-2)}.footer-logo{margin:22px 0 4px;text-align:center;color:#7a5f27;font-family:Georgia,"Times New Roman",serif;letter-spacing:.25em}.toast{position:fixed;right:24px;bottom:24px;padding:12px 14px;border-radius:10px;border:1px solid rgba(212,162,55,.25);background:#121317;color:#fff;box-shadow:var(--shadow);z-index:80;opacity:0;transform:translateY(12px);transition:opacity .18s,transform .18s}.toast.show{opacity:1;transform:translateY(0)}.drawer-shade{display:none}
    @keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes rise{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
    .product-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.product-card,.collection-card{border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.022);padding:13px;display:grid;grid-template-columns:64px minmax(0,1fr);gap:12px;align-items:center}.product-card:hover,.collection-card:hover{border-color:rgba(212,162,55,.35);background:rgba(255,255,255,.04)}.prod-img.large{width:64px;height:64px;border-radius:8px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}.chip{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:3px 7px;color:#cfc7ba;background:rgba(255,255,255,.025)}.order-card{border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.022);padding:14px;margin-bottom:10px}.order-products{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin-top:10px}.order-product{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:9px;align-items:center;border:1px solid var(--line-soft);border-radius:8px;padding:8px;background:rgba(255,255,255,.018)}
    @media(max-width:1180px){.layout-overview{grid-template-columns:1fr}.right-rail{grid-template-columns:1fr 1fr}.metrics{grid-template-columns:repeat(2,1fr)}.modules,.bottom-grid{grid-template-columns:1fr}.support-grid,.crm-grid,.orders-grid{grid-template-columns:1fr;height:auto}.panel{min-height:360px}.page-head{align-items:flex-start;flex-direction:column}.head-tools{width:100%;justify-content:flex-start}.date-filter{width:100%}.date-select{flex:1;min-width:160px}.date-input{flex:1;min-width:130px}}
    @media(max-width:820px){body{overflow-y:auto;overflow-x:hidden}.app{display:block;height:auto;min-height:100dvh}.sidebar{position:fixed;left:0;top:0;bottom:0;width:286px;transform:translateX(-104%);box-shadow:var(--shadow)}.app.mobile-open .sidebar{transform:translateX(0)}.drawer-shade{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:35}.app.mobile-open .drawer-shade{display:block}.main{min-height:100dvh}.topbar{padding:0 14px}.mobile-menu{display:grid}.top-actions .top-icon:nth-child(1),.profile-copy{display:none}.content{padding:14px}.welcome{height:auto;display:block;padding:20px}.date-pill{margin-top:16px;width:100%}.metrics{grid-template-columns:1fr}.right-rail{grid-template-columns:1fr}.support-grid,.crm-grid{gap:12px}.modules{gap:12px}.module{min-height:170px}.bottom-grid{gap:12px}.message-space{min-height:360px}.msg{max-width:88%}.date-filter{display:grid;grid-template-columns:1fr}.date-custom{grid-template-columns:1fr auto 1fr}.date-filter.custom .date-custom{display:grid}}
  </style>
</head>
<body>
  <section id="loginPage" class="login-page">
    <form id="loginForm" class="login-card">
      <div class="brand"><div class="brand-mark">R</div><div><div class="brand-word">RUTH ISTANBUL</div><div class="brand-sub">Yönetim Paneli</div></div></div>
      <h1>Panele giriş yap</h1>
      <p>Canlı destek, CRM notları ve sipariş özetlerini tek yerden yönet.</p>
      <div class="field"><label>Kullanıcı adı</label><input id="loginUser" class="input" autocomplete="username" required></div>
      <div class="field"><label>Şifre</label><input id="loginPass" class="input" type="password" autocomplete="current-password" required></div>
      <button class="btn gold full" type="submit">Giriş Yap</button>
      <div id="loginError" class="error"></div>
    </form>
  </section>

  <section id="app" class="app hidden">
    <div id="drawerShade" class="drawer-shade"></div>
    <aside class="sidebar">
      <div class="side-head"><div class="brand-mark">R</div><div class="brand-copy"><div class="brand-word">RUTH ISTANBUL</div></div></div>
      <nav class="nav">
        <button class="nav-item active" data-route="overview"><span class="nav-ico"><svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V20h5v-5h4v5h5v-9.5"/></svg></span><span class="nav-label">Genel Bakış</span></button>
        <div class="nav-heading">İLETİŞİM</div>
        <button class="nav-item" data-route="support"><span class="nav-ico"><svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.8-5A8 8 0 1 1 21 12Z"/></svg></span><span class="nav-label">Canlı Destek</span><span id="badgeSupport" class="nav-badge">0</span></button>
        <button class="nav-item" data-route="notifications"><span class="nav-ico"><svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 6-3 9h18c0-3-3-2-3-9Z"/><path d="M10 21h4"/></svg></span><span class="nav-label">Bildirimler</span><span id="badgeNotify" class="nav-badge">0</span></button>
        <div class="nav-heading">MÜŞTERİ YÖNETİMİ</div>
        <button class="nav-item" data-route="crm"><span class="nav-ico"><svg viewBox="0 0 24 24"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/></svg></span><span class="nav-label">CRM</span></button>
        <div class="nav-heading">SİPARİŞ YÖNETİMİ</div>
        <button class="nav-item" data-route="orders"><span class="nav-ico"><svg viewBox="0 0 24 24"><path d="M6 7h12l1 14H5L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg></span><span class="nav-label">Siparişler</span><span id="badgeOrders" class="nav-badge">0</span></button>
        <button class="nav-item" data-route="products"><span class="nav-ico"><svg viewBox="0 0 24 24"><path d="m21 8-9-5-9 5 9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg></span><span class="nav-label">Ürünler</span></button>
        <div class="nav-heading">ENTEGRASYON</div>
        <button class="nav-item" data-route="integration"><span class="nav-ico"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/></svg></span><span class="nav-label">ikas Entegrasyonu</span></button>
        <button class="nav-item" data-route="ikas-orders"><span class="nav-ico">↳</span><span class="nav-label">Tüm Siparişler</span></button>
        <button class="nav-item" data-route="ikas-products"><span class="nav-ico">↳</span><span class="nav-label">Tüm Ürünler</span></button>
        <button class="nav-item" data-route="ikas-collections"><span class="nav-ico">↳</span><span class="nav-label">Tüm Koleksiyonlar</span></button>
        <button class="nav-item" data-route="ikas-ready-orders"><span class="nav-ico">↳</span><span class="nav-label">Hazırlanacak Siparişler</span><span id="badgeReadyOrders" class="nav-badge">0</span></button>
        <button class="nav-item" data-route="ikas-ready-products"><span class="nav-ico">↳</span><span class="nav-label">Hazırlanacak Ürün Toplamları</span></button>
        <div class="nav-heading">DİĞER</div>
        <button class="nav-item" data-route="reports"><span class="nav-ico"><svg viewBox="0 0 24 24"><path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19H2"/></svg></span><span class="nav-label">Raporlar</span></button>
        <button class="nav-item" data-route="settings"><span class="nav-ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20h-3v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L6.6 16.7l.1-.1A1.7 1.7 0 0 0 7 14.7a1.7 1.7 0 0 0-1.5-1H5v-3h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h3v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v3h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg></span><span class="nav-label">Ayarlar</span></button>
      </nav>
      <div class="side-foot"><button id="collapseBtn" class="btn ghost"><span>←</span><span>Menüyü Daralt</span></button><button id="logoutBtn" class="btn ghost"><span>Çıkış Yap</span></button></div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div class="top-left"><button id="mobileMenuBtn" class="icon-btn mobile-menu">☰</button><button id="deskMenuBtn" class="icon-btn">☰</button><div class="crumb-title" id="crumbTitle">Genel Bakış</div></div>
        <div class="top-actions"><button class="top-icon" title="Ara">⌕</button><button id="pushBtn" class="top-icon" title="Bildirimleri aç">♧<span id="topBadge" class="top-dot">0</span></button><div class="profile"><div class="avatar">R</div><div class="profile-copy"><div class="profile-name">Ruth Istanbul</div><div class="profile-role">Yönetici</div></div></div></div>
      </header>
      <section class="content">
        <div id="page-overview" class="page active">
          <div class="layout-overview">
            <div>
              <div class="welcome"><div><h1>Hoş geldiniz, Ruth Istanbul 👋</h1><p>İşletmenizin tüm verilerine genel bakış.</p></div><div class="date-pill"><span id="todayText">Bugün</span><span>▣</span></div></div>
              <div class="metrics">
                <div class="metric"><div class="metric-row"><div class="metric-ico">☏</div><div><div class="metric-label">Açık Konuşmalar</div><div id="statOpen" class="metric-num">0</div></div></div><div class="metric-sub">+0 bugün</div></div>
                <div class="metric"><div class="metric-row"><div class="metric-ico">✉</div><div><div class="metric-label">Okunmamış Mesajlar</div><div id="statUnread" class="metric-num">0</div></div></div><div class="metric-sub">+0 bugün</div></div>
                <div class="metric"><div class="metric-row"><div class="metric-ico">▣</div><div><div class="metric-label">Bugünkü Hatırlatmalar</div><div id="statReminders" class="metric-num">0</div></div></div><div class="metric-sub">CRM görevleri</div></div>
                <div class="metric"><div class="metric-row"><div class="metric-ico">♧</div><div><div class="metric-label">Toplam Sipariş</div><div id="statOrders" class="metric-num">0</div></div></div><div class="metric-sub">ikas bağlanınca canlı</div></div>
              </div>
              <div class="modules">
                <button class="module" data-route="support"><div class="module-ico">☏</div><h3>CANLI DESTEK</h3><p>Müşterilerinizle anlık olarak iletişime geçin ve destek verin.</p><span class="btn gold">Konuşmaları Görüntüle →</span></button>
                <button class="module" data-route="crm"><div class="module-ico">♙</div><h3>CRM</h3><p>Müşteri bilgileri, notlar ve hatırlatmaları yönetin.</p><span class="btn gold">CRM'ye Git →</span></button>
                <button class="module" data-route="orders"><div class="module-ico">♧</div><h3>SİPARİŞLER</h3><p>Gelen siparişleri, ürünleri ve istatistikleri görüntüleyin.</p><span class="btn gold">Siparişleri Görüntüle →</span></button>
              </div>
              <div class="bottom-grid">
                <div class="card"><div class="card-title">Son Konuşmalar</div><div id="recentConversations" class="list"><div class="empty">Yükleniyor...</div></div><button class="btn full" data-route="support">Tüm Konuşmaları Görüntüle</button></div>
                <div class="card"><div class="card-title">Hatırlatmalar</div><div id="remindersList" class="list"><div class="empty">Yükleniyor...</div></div><button class="btn full" data-route="crm">Tüm Hatırlatmaları Görüntüle</button></div>
                <div class="card"><div class="card-title">Sipariş Özeti (Bugün)</div><div class="info-line"><span>Toplam Sipariş</span><b id="ordersToday">0</b></div><div class="info-line"><span>Toplam Ürün Adedi</span><b id="unitsToday">0</b></div><div class="info-line"><span>Ürün Çeşidi</span><b id="kindsToday">0</b></div><button class="btn full" data-route="orders">Tüm Siparişleri Görüntüle</button></div>
              </div>
              <div class="footer-logo">RUTH ISTANBUL</div>
            </div>
            <aside class="right-rail">
              <div class="card"><div class="card-title">Hızlı Erişim</div><div class="list"><button class="quick-row" data-route="crm"><span class="quick-left"><span>✎</span><span>Yeni Not Ekle</span></span><span>›</span></button><button class="quick-row" data-route="crm"><span class="quick-left"><span>▣</span><span>Hatırlatma Oluştur</span></span><span>›</span></button><button class="quick-row" data-route="crm"><span class="quick-left"><span>♙</span><span>Yeni Müşteri Ekle</span></span><span>›</span></button><button id="quickSync" class="quick-row"><span class="quick-left"><span>↻</span><span>Siparişleri Senkronize Et</span></span><span>›</span></button></div></div>
              <div class="card"><div class="card-title">En Çok Satan Ürünler</div><div id="topProducts" class="list"><div class="empty">ikas API bağlanınca ürünler burada görünecek.</div></div><button class="btn full" data-route="orders">Tüm Ürünleri Görüntüle →</button></div>
            </aside>
          </div>
        </div>

        <div id="page-support" class="page">
          <div class="page-head"><div><div class="page-title">Canlı Destek</div><div class="page-sub">Siteden gelen konuşmaları buradan yanıtla.</div></div><button id="refreshSupport" class="btn">Yenile</button></div>
          <div class="support-grid"><div class="panel"><div class="panel-head"><div class="panel-title">Konuşmalar</div><input id="searchInput" class="input" placeholder="Ara..." style="max-width:160px"></div><div id="conversationList" class="panel-body"><div class="empty">Yükleniyor...</div></div></div><div class="panel"><div class="panel-head"><div><div id="activeTitle" class="panel-title">Konuşma seç</div><div id="activeSub" class="preview">Müşteri mesajı burada açılır.</div></div><button id="closeConversation" class="btn ghost" disabled>Kapat</button></div><div id="messages" class="message-space"><div class="empty">Bir konuşma seç.</div></div><form id="replyForm" class="composer"><textarea id="replyText" class="textarea" placeholder="Yanıt yaz..." disabled></textarea><button id="sendReply" class="btn gold" disabled>Gönder</button></form></div><div class="panel"><div class="panel-head"><div class="panel-title">Müşteri Bilgisi</div></div><div class="panel-body"><div class="info-line"><span>Ad</span><b id="infoName">-</b></div><div class="info-line"><span>Telefon</span><b id="infoPhone">-</b></div><div class="info-line"><span>Son Mesaj</span><b id="infoLast">-</b></div><div class="info-line"><span>Sayfa</span><b id="infoPage">-</b></div><button class="btn gold full" data-route="crm">CRM Kaydına Git</button></div></div></div>
        </div>

        <div id="page-crm" class="page">
          <div class="page-head"><div><div class="page-title">CRM</div><div class="page-sub">Müşteriye özel notlar, hatırlatmalar ve takip kayıtları.</div></div><button class="btn" id="refreshCrm">Yenile</button></div>
          <div class="crm-grid"><div class="panel"><div class="panel-head"><div class="panel-title">Müşteriler</div><input id="crmSearch" class="input" placeholder="Müşteri ara..." style="max-width:180px"></div><div id="customers" class="panel-body"><div class="empty">Yükleniyor...</div></div></div><div class="panel"><div class="panel-head"><div><div id="crmTitle" class="panel-title">Müşteri seç</div><div id="crmSub" class="preview">Özel not eklemek için müşteri seç.</div></div></div><div class="panel-body"><div class="bottom-grid"><div class="card"><div class="info-line"><span>Telefon</span><b id="crmPhone">-</b></div><div class="info-line"><span>Durum</span><b id="crmStatus">-</b></div><div class="info-line"><span>Son Mesaj</span><b id="crmLast">-</b></div></div><form id="noteForm" class="card"><div class="card-title">Müşteriye Özel Not</div><textarea id="noteText" class="textarea" placeholder="Bu müşteri hakkında not yaz..." disabled></textarea><div class="field"><label>Hatırlatma zamanı</label><input id="noteReminder" class="input" type="datetime-local" disabled></div><button id="noteBtn" class="btn gold full" disabled>Notu Kaydet</button></form><div class="card"><div class="card-title">Kayıtlar</div><div id="notesList" class="list"><div class="empty">Müşteri seç.</div></div></div></div></div></div></div>
        </div>

        <div id="page-orders" class="page">
          <div class="page-head"><div><div class="page-title">Siparişler</div><div class="page-sub">ikas'tan gelen tüm siparişler, hazırlanacak ürünler ve teslim edilenler.</div></div><div class="head-tools"><div class="date-filter" data-date-filter><select class="date-select" data-date-preset><option value="all">Tüm zamanlar</option><option value="today">Bugün</option><option value="yesterday">Dün</option><option value="this_week">Bu hafta</option><option value="last_week">Geçen hafta</option><option value="this_month">Bu ay</option><option value="last_month">Geçen ay</option><option value="this_year">Bu yıl</option><option value="custom">Özel tarih</option></select><div class="date-custom"><input class="date-input" type="date" data-date-start><span class="time">-</span><input class="date-input" type="date" data-date-end></div></div><button id="syncOrders" class="btn gold">Siparişleri Senkronize Et</button></div></div>
          <div class="metrics"><div class="metric"><div class="metric-label">Toplam Sipariş</div><div id="ordersTotal" class="metric-num">0</div></div><div class="metric"><div class="metric-label">Toplam Ürün Adedi</div><div id="unitsTotal" class="metric-num">0</div></div><div class="metric"><div class="metric-label">Ürün Çeşidi</div><div id="productKinds" class="metric-num">0</div></div><div class="metric"><div class="metric-label">ikas Durumu</div><div id="ikasStatus" class="metric-num" style="font-size:22px">Bekliyor</div></div></div>
          <div class="orders-grid"><div class="panel"><div class="panel-head"><div class="panel-title">Hazırlanacak Ürün Toplamları</div><span class="badge" id="readyOrdersBadge">0</span></div><div id="productTotals" class="panel-body"><div class="empty">Kargoya hazır siparişlerdeki ürün toplamları burada görünecek.</div></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Tüm Siparişler</div><span class="badge" id="allOrdersBadge">0</span></div><div id="ordersList" class="panel-body"><div class="empty">Henüz canlı sipariş verisi bağlı değil.</div></div></div><div class="panel" style="grid-column:1/-1"><div class="panel-head"><div class="panel-title">Teslim Edilen Siparişler</div><span class="badge" id="deliveredOrdersBadge">0</span></div><div id="deliveredOrdersList" class="panel-body"><div class="empty">Teslim edilen sipariş bulunamadı.</div></div></div></div>
        </div>

        <div id="page-integration" class="page">
          <div class="page-head"><div><div class="page-title">ikas Entegrasyonu</div><div class="page-sub">Sipariş, ürün, koleksiyon ve hazırlık listelerini ayrı ayrı yönet.</div></div><button class="btn gold" data-route="ikas-orders">Tüm Siparişler →</button></div>
          <div class="modules">
            <button class="module" data-route="ikas-orders"><div class="module-ico">♧</div><h3>TÜM SİPARİŞLER</h3><p>En güncel siparişler en üstte, durumları ve ürünleriyle görünür.</p><span class="btn gold">Aç →</span></button>
            <button class="module" data-route="ikas-products"><div class="module-ico">◇</div><h3>TÜM ÜRÜNLER</h3><p>Ürün adı, fotoğraf, varyant, SKU ve stok bilgileri.</p><span class="btn gold">Aç →</span></button>
            <button class="module" data-route="ikas-collections"><div class="module-ico">▣</div><h3>TÜM KOLEKSİYONLAR</h3><p>ikas kategori/koleksiyonları ve içindeki ürünler.</p><span class="btn gold">Aç →</span></button>
            <button class="module" data-route="ikas-ready-orders"><div class="module-ico">✓</div><h3>HAZIRLANACAK SİPARİŞLER</h3><p>Sadece kargoya hazır siparişler.</p><span class="btn gold">Aç →</span></button>
            <button class="module" data-route="ikas-ready-products"><div class="module-ico">＋</div><h3>HAZIRLANACAK ÜRÜN TOPLAMLARI</h3><p>Kargoya hazır siparişlerde hangi üründen kaç adet hazırlanacak.</p><span class="btn gold">Aç →</span></button>
          </div>
        </div>

        <div id="page-products" class="page"><div class="page-head"><div><div class="page-title">Ürünler</div><div class="page-sub">Tüm ikas ürünleri.</div></div><button class="btn gold" data-route="ikas-products">Ürünleri Aç</button></div><div id="productsGrid" class="panel-body"><div class="empty">Ürünler yükleniyor...</div></div></div>

        <div id="page-ikas-orders" class="page"><div class="page-head"><div><div class="page-title">Tüm Siparişler</div><div class="page-sub">Bütün siparişler tarihe göre; en güncel sipariş en üstte.</div></div><div class="head-tools"><div class="date-filter" data-date-filter><select class="date-select" data-date-preset><option value="all">Tüm zamanlar</option><option value="today">Bugün</option><option value="yesterday">Dün</option><option value="this_week">Bu hafta</option><option value="last_week">Geçen hafta</option><option value="this_month">Bu ay</option><option value="last_month">Geçen ay</option><option value="this_year">Bu yıl</option><option value="custom">Özel tarih</option></select><div class="date-custom"><input class="date-input" type="date" data-date-start><span class="time">-</span><input class="date-input" type="date" data-date-end></div></div><button class="btn gold ikas-refresh">Senkronize Et</button></div></div><div id="ikasAllOrders" class="panel-body"><div class="empty">Siparişler yükleniyor...</div></div></div>
        <div id="page-ikas-products" class="page"><div class="page-head"><div><div class="page-title">Tüm Ürünler</div><div class="page-sub">Ürün fotoğrafı, varyant, SKU ve stok bilgileri.</div></div><button class="btn gold ikas-refresh">Senkronize Et</button></div><div id="ikasAllProducts" class="panel-body"><div class="empty">Ürünler yükleniyor...</div></div></div>
        <div id="page-ikas-collections" class="page"><div class="page-head"><div><div class="page-title">Tüm Koleksiyonlar</div><div class="page-sub">ikas kategori/koleksiyonları ve içindeki ürünler.</div></div><button class="btn gold ikas-refresh">Senkronize Et</button></div><div id="ikasAllCollections" class="panel-body"><div class="empty">Koleksiyonlar yükleniyor...</div></div></div>
        <div id="page-ikas-ready-orders" class="page"><div class="page-head"><div><div class="page-title">Hazırlanacak Siparişler</div><div class="page-sub">Sadece kargoya hazır durumundaki siparişler.</div></div><div class="head-tools"><div class="date-filter" data-date-filter><select class="date-select" data-date-preset><option value="all">Tüm zamanlar</option><option value="today">Bugün</option><option value="yesterday">Dün</option><option value="this_week">Bu hafta</option><option value="last_week">Geçen hafta</option><option value="this_month">Bu ay</option><option value="last_month">Geçen ay</option><option value="this_year">Bu yıl</option><option value="custom">Özel tarih</option></select><div class="date-custom"><input class="date-input" type="date" data-date-start><span class="time">-</span><input class="date-input" type="date" data-date-end></div></div><button class="btn gold ikas-refresh">Senkronize Et</button></div></div><div id="ikasReadyOrders" class="panel-body"><div class="empty">Hazırlanacak siparişler yükleniyor...</div></div></div>
        <div id="page-ikas-ready-products" class="page"><div class="page-head"><div><div class="page-title">Hazırlanacak Ürün Toplamları</div><div class="page-sub">Kargoya hazır siparişlerden birleştirilmiş ürün hazırlık listesi.</div></div><div class="head-tools"><div class="date-filter" data-date-filter><select class="date-select" data-date-preset><option value="all">Tüm zamanlar</option><option value="today">Bugün</option><option value="yesterday">Dün</option><option value="this_week">Bu hafta</option><option value="last_week">Geçen hafta</option><option value="this_month">Bu ay</option><option value="last_month">Geçen ay</option><option value="this_year">Bu yıl</option><option value="custom">Özel tarih</option></select><div class="date-custom"><input class="date-input" type="date" data-date-start><span class="time">-</span><input class="date-input" type="date" data-date-end></div></div><button class="btn gold ikas-refresh">Senkronize Et</button></div></div><div id="ikasReadyProductTotals" class="panel-body"><div class="empty">Ürün toplamları yükleniyor...</div></div></div>
        <div id="page-notifications" class="page"><div class="page-title">Bildirimler</div><p class="page-sub">Push bildirimleri ve hatırlatmalar burada yönetilecek.</p></div>
        <div id="page-products" class="page"><div class="page-title">Ürünler</div><p class="page-sub">ikas ürün listesi bağlanınca burada görünecek.</p></div>
        <div id="page-reports" class="page"><div class="page-title">Raporlar</div><p class="page-sub">Satış ve destek raporları burada hazırlanacak.</p></div>
        <div id="page-settings" class="page"><div class="page-title">Ayarlar</div><p class="page-sub">Panel ayarları burada olacak.</p></div>
      </section>
    </main>
  </section>
  <div id="toast" class="toast"></div>

<script>
(function(){
  var token=localStorage.getItem('ruth_admin_token')||'';
  var conversations=[]; var reminders=[]; var ikasSummary={totals:{orders:0,units:0,readyOrders:0,readyUnits:0,deliveredOrders:0,products:0,collections:0},productTotals:[],readyProductTotals:[],orders:[],readyOrders:[],deliveredOrders:[],products:[],collections:[],connected:false}; var activeId=''; var activeRoute='overview'; var typingFor=''; var typingTimer=null; var typingStop=null;
  var datePreset=localStorage.getItem('ruth_panel_date_preset')||'all'; var dateStart=localStorage.getItem('ruth_panel_date_start')||''; var dateEnd=localStorage.getItem('ruth_panel_date_end')||'';
  var ISTANBUL_TZ='Europe/Istanbul'; var TR_OFFSET_MS=3*60*60*1000;
  function $(id){return document.getElementById(id)}
  function qsa(sel){return Array.prototype.slice.call(document.querySelectorAll(sel))}
  function setText(id,val){var el=$(id); if(el) el.textContent=(val===undefined||val===null)?'':String(val)}
  function escapeHtml(v){return String(v||'').replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]})}
  function fmtDate(v){if(!v)return '-'; try{return new Date(v).toLocaleString('tr-TR',{timeZone:ISTANBUL_TZ,day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}catch(e){return v}}
  function today(){try{return new Date().toLocaleString('tr-TR',{timeZone:ISTANBUL_TZ,day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'})}catch(e){return 'Bugün'}}
  function trParts(d){var parts=new Intl.DateTimeFormat('en-CA',{timeZone:ISTANBUL_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d||new Date()); var out={}; parts.forEach(function(p){out[p.type]=p.value}); return {year:Number(out.year),month:Number(out.month),day:Number(out.day)}}
  function trMidnightUtcMs(y,m,d){return Date.UTC(y,m-1,d)-TR_OFFSET_MS}
  function addDaysMs(ms,days){return ms+days*86400000}
  function activeDateRange(){var p=trParts(new Date()); var start=0,end=Infinity; var todayStart=trMidnightUtcMs(p.year,p.month,p.day); var jsDow=new Date(todayStart+TR_OFFSET_MS).getUTCDay(); var mondayOffset=(jsDow+6)%7; if(datePreset==='today'){start=todayStart;end=addDaysMs(start,1)} else if(datePreset==='yesterday'){end=todayStart;start=addDaysMs(end,-1)} else if(datePreset==='this_week'){start=addDaysMs(todayStart,-mondayOffset);end=addDaysMs(start,7)} else if(datePreset==='last_week'){end=addDaysMs(todayStart,-mondayOffset);start=addDaysMs(end,-7)} else if(datePreset==='this_month'){start=trMidnightUtcMs(p.year,p.month,1);end=p.month===12?trMidnightUtcMs(p.year+1,1,1):trMidnightUtcMs(p.year,p.month+1,1)} else if(datePreset==='last_month'){var ly=p.month===1?p.year-1:p.year; var lm=p.month===1?12:p.month-1; start=trMidnightUtcMs(ly,lm,1);end=trMidnightUtcMs(p.year,p.month,1)} else if(datePreset==='this_year'){start=trMidnightUtcMs(p.year,1,1);end=trMidnightUtcMs(p.year+1,1,1)} else if(datePreset==='custom'){ if(dateStart){var a=dateStart.split('-').map(Number); start=trMidnightUtcMs(a[0],a[1],a[2])} if(dateEnd){var b=dateEnd.split('-').map(Number); end=addDaysMs(trMidnightUtcMs(b[0],b[1],b[2]),1)} } return {start:start,end:end,preset:datePreset}}
  function orderTime(o){return Number(o.orderSort||Date.parse(o.orderedAt||o.createdAt||o.updatedAt||'')||0)}
  function applyDateFilter(list){var r=activeDateRange(); if(!list||datePreset==='all')return (list||[]).slice(); return (list||[]).filter(function(o){var t=orderTime(o); return t && t>=r.start && t<r.end})}
  function syncDateControls(){qsa('[data-date-filter]').forEach(function(w){var sel=w.querySelector('[data-date-preset]'); var st=w.querySelector('[data-date-start]'); var en=w.querySelector('[data-date-end]'); if(sel)sel.value=datePreset; if(st)st.value=dateStart; if(en)en.value=dateEnd; w.classList.toggle('custom',datePreset==='custom')})}
  function initDateFilters(){qsa('[data-date-filter]').forEach(function(w){var sel=w.querySelector('[data-date-preset]'); var st=w.querySelector('[data-date-start]'); var en=w.querySelector('[data-date-end]'); if(sel&&!sel.dataset.ready){sel.dataset.ready='1';sel.addEventListener('change',function(){datePreset=sel.value||'all'; localStorage.setItem('ruth_panel_date_preset',datePreset); syncDateControls(); renderIkas()})} [st,en].forEach(function(inp){if(inp&&!inp.dataset.ready){inp.dataset.ready='1';inp.addEventListener('change',function(){dateStart=st&&st.value||''; dateEnd=en&&en.value||''; localStorage.setItem('ruth_panel_date_start',dateStart); localStorage.setItem('ruth_panel_date_end',dateEnd); renderIkas()})}})}); syncDateControls()}
  function api(path,opts){opts=opts||{}; opts.headers=opts.headers||{}; opts.headers['Content-Type']='application/json'; if(token) opts.headers.Authorization='Bearer '+token; return fetch(path,opts).then(function(r){return r.text().then(function(t){var d=t?JSON.parse(t):{}; if(!r.ok){if(r.status===401 && path!='/api/admin/login') logout(false); throw new Error(d.error||d.message||'İstek başarısız')} return d})})}
  function toast(msg){var el=$('toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(function(){el.classList.remove('show')},2200)}
  function showApp(){ $('loginPage').classList.add('hidden'); $('app').classList.remove('hidden'); setText('todayText',today()); clearInterval(showApp._clock); showApp._clock=setInterval(function(){setText('todayText',today())},60000); initDateFilters(); setRoute(routeFromPath(),false); loadAll(); }
  function logout(push){token=''; localStorage.removeItem('ruth_admin_token'); $('app').classList.add('hidden'); $('loginPage').classList.remove('hidden'); if(push!==false) history.replaceState(null,'','/admin/'); }
  $('loginForm').addEventListener('submit',function(e){e.preventDefault(); setText('loginError',''); api('/api/admin/login',{method:'POST',body:JSON.stringify({username:$('loginUser').value.trim(),password:$('loginPass').value})}).then(function(d){token=d.token||''; if(!token){throw new Error('token alınamadı')} localStorage.setItem('ruth_admin_token',token); showApp();}).catch(function(err){setText('loginError','Giriş başarısız: '+err.message)})});
  $('logoutBtn').addEventListener('click',function(){logout()});
  $('collapseBtn').addEventListener('click',function(){ $('app').classList.toggle('nav-mini') });
  $('deskMenuBtn').addEventListener('click',function(){ $('app').classList.toggle('nav-mini') });
  $('mobileMenuBtn').addEventListener('click',function(){ $('app').classList.add('mobile-open') });
  $('drawerShade').addEventListener('click',function(){ $('app').classList.remove('mobile-open') });
  qsa('[data-route]').forEach(function(el){el.addEventListener('click',function(){setRoute(el.getAttribute('data-route'),true); $('app').classList.remove('mobile-open')})});
  window.addEventListener('popstate',function(){setRoute(routeFromPath(),false)});
  function routeFromPath(){var p=location.pathname||'/admin/'; if(p.indexOf('/admin/')===0){p=p.slice('/admin/'.length)} else if(p==='/admin'){p=''}; while(p.endsWith('/')) p=p.slice(0,-1); return p||'overview'}
  function setRoute(route,push){var allowed=['overview','support','crm','orders','integration','notifications','products','reports','settings','ikas-orders','ikas-products','ikas-collections','ikas-ready-orders','ikas-ready-products']; if(allowed.indexOf(route)<0) route='overview'; activeRoute=route; qsa('.page').forEach(function(p){p.classList.remove('active')}); var page=$('page-'+route); if(page) page.classList.add('active'); qsa('.nav-item').forEach(function(n){n.classList.toggle('active',n.getAttribute('data-route')===route)}); var titles={overview:'Genel Bakış',support:'Canlı Destek',crm:'CRM',orders:'Siparişler',integration:'ikas Entegrasyonu',notifications:'Bildirimler',products:'Ürünler',reports:'Raporlar',settings:'Ayarlar','ikas-orders':'Tüm Siparişler','ikas-products':'Tüm Ürünler','ikas-collections':'Tüm Koleksiyonlar','ikas-ready-orders':'Hazırlanacak Siparişler','ikas-ready-products':'Hazırlanacak Ürün Toplamları'}; setText('crumbTitle',titles[route]||'Panel'); if(push) history.pushState(null,'','/admin/'+(route==='overview'?'':route)); if(route==='support'){loadConversations(true)} if(route==='crm'){loadConversations(true)} if(['orders','integration','products','ikas-orders','ikas-products','ikas-collections','ikas-ready-orders','ikas-ready-products'].indexOf(route)>=0){loadIkasSummary()} }
  function loadAll(){ loadConversations(true); loadReminders(); loadIkasSummary(); setInterval(function(){if(token)loadConversations(true)},6000); }
  function loadConversations(silent){ return api('/api/admin/conversations').then(function(d){conversations=d.conversations||[]; renderAll(); if(activeId){ if(activeRoute==='support')loadMessages(activeId,true); if(activeRoute==='crm')loadCrmDetail(activeId,true); }}).catch(function(err){if(!silent)toast(err.message)})}
  function loadReminders(){return api('/api/admin/reminders/due').then(function(d){reminders=d.reminders||[]; renderReminders()}).catch(function(){})}
  function loadIkasSummary(){return api('/api/admin/ikas/summary').then(function(d){ikasSummary=d||ikasSummary; renderIkas();}).catch(function(){renderIkas()})}
  function renderAll(){ var open=conversations.filter(function(c){return c.status!=='closed'}).length; var unread=conversations.reduce(function(a,c){return a+Number(c.unreadAdminCount||0)},0); setText('statOpen',open); setText('statUnread',unread); setText('badgeSupport',unread); setText('topBadge',unread); renderRecent(); renderConversations(); renderCustomers(); }
  function renderRecent(){ var el=$('recentConversations'); if(!el)return; var items=conversations.slice(0,4); if(!items.length){el.innerHTML='<div class="empty">Henüz konuşma yok.</div>';return;} el.innerHTML=items.map(function(c){return '<div class="mini-row"><div class="row"><div class="name">'+escapeHtml(c.displayName||'Ziyaretçi')+'</div><span class="time">'+fmtDate(c.updatedAt)+'</span></div><div class="preview">'+escapeHtml(c.lastMessageText||'Yeni konuşma')+'</div></div>'}).join('') }
  function renderReminders(){setText('statReminders',reminders.length); setText('badgeNotify',reminders.length); var el=$('remindersList'); if(!el)return; if(!reminders.length){el.innerHTML='<div class="empty">Bekleyen hatırlatma yok.</div>';return;} el.innerHTML=reminders.slice(0,4).map(function(n){return '<div class="mini-row"><div class="row"><div class="name">'+escapeHtml(n.body||'Hatırlatma')+'</div><span class="time">□</span></div><div class="preview">'+fmtDate(n.reminderAt)+'</div></div>'}).join('')}
  function filteredConversations(){ var term=(($('searchInput')&&$('searchInput').value)||($('crmSearch')&&$('crmSearch').value)||'').toLowerCase(); if(!term)return conversations; return conversations.filter(function(c){return [c.displayName,c.visitorPhone,c.lastMessageText,c.pageTitle].join(' ').toLowerCase().indexOf(term)>=0}) }
  function renderConversations(){ var el=$('conversationList'); if(!el)return; var items=filteredConversations(); if(!items.length){el.innerHTML='<div class="empty">Konuşma yok.</div>';return;} el.innerHTML=items.map(function(c){return '<div class="conversation '+(c.id===activeId?'active':'')+'" data-id="'+escapeHtml(c.id)+'"><div class="row"><div class="name">'+escapeHtml(c.displayName||'Ziyaretçi')+'</div>'+(c.unreadAdminCount?'<span class="badge">'+c.unreadAdminCount+'</span>':'<span class="time">'+fmtDate(c.updatedAt)+'</span>')+'</div><div class="preview">'+escapeHtml(c.lastMessageText||c.pageTitle||'Yeni konuşma')+'</div></div>'}).join(''); qsa('#conversationList .conversation').forEach(function(x){x.addEventListener('click',function(){selectConversation(x.getAttribute('data-id'),'support')})}) }
  function renderCustomers(){ var el=$('customers'); if(!el)return; var items=filteredConversations(); if(!items.length){el.innerHTML='<div class="empty">Henüz müşteri yok.</div>';return;} el.innerHTML=items.map(function(c){return '<div class="customer-row '+(c.id===activeId?'active':'')+'" data-id="'+escapeHtml(c.id)+'"><div class="row"><div class="name">'+escapeHtml(c.displayName||'Ziyaretçi')+'</div><span class="time">'+escapeHtml(c.status||'open')+'</span></div><div class="preview">'+escapeHtml(c.visitorPhone||c.lastMessageText||'Müşteri kaydı')+'</div></div>'}).join(''); qsa('#customers .customer-row').forEach(function(x){x.addEventListener('click',function(){selectConversation(x.getAttribute('data-id'),'crm')})}) }
  function getActive(){return conversations.find(function(c){return c.id===activeId})||{}}
  function selectConversation(id,route){ if(activeId&&activeId!==id)sendTyping(false,activeId); activeId=id; renderConversations(); renderCustomers(); if(route)setRoute(route,true); if(route==='support')loadMessages(id); if(route==='crm')loadCrmDetail(id); }
  function fillInfo(c){setText('infoName',c.displayName||'-');setText('infoPhone',c.visitorPhone||'-');setText('infoLast',c.lastMessageText||'-');setText('infoPage',c.pageTitle||c.pageUrl||'-')}
  function loadMessages(id,silent){ var c=getActive(); setText('activeTitle',c.displayName||'Ziyaretçi'); setText('activeSub',(c.pageTitle||'')+(c.pageUrl?' • '+c.pageUrl:'')); fillInfo(c); $('replyText').disabled=false; $('sendReply').disabled=false; $('closeConversation').disabled=false; if(!silent)$('messages').innerHTML='<div class="empty">Mesajlar yükleniyor...</div>'; return api('/api/admin/conversations/'+encodeURIComponent(id)+'/messages').then(function(d){renderMessages(d.messages||[]); return api('/api/admin/conversations/'+encodeURIComponent(id)+'/read',{method:'POST'}).catch(function(){})}).catch(function(err){$('messages').innerHTML='<div class="empty">Mesajlar yüklenemedi: '+escapeHtml(err.message)+'</div>'}) }
  function renderMessages(items){var el=$('messages'); if(!items.length){el.innerHTML='<div class="empty">Bu konuşmada mesaj yok.</div>';return;} el.innerHTML=items.map(function(m){return '<div class="msg '+escapeHtml(m.sender)+'"><div>'+escapeHtml(m.body||(m.imageData?'Fotoğraf':''))+'</div>'+(m.imageData?'<img src="'+m.imageData+'" alt="Müşteri fotoğrafı">':'')+'<div class="meta">'+escapeHtml(m.sender)+' • '+fmtDate(m.createdAt)+'</div></div>'}).join(''); el.scrollTop=el.scrollHeight;}
  $('replyForm').addEventListener('submit',function(e){e.preventDefault(); var text=$('replyText').value.trim(); if(!activeId||!text)return; $('sendReply').disabled=true; sendTyping(false); api('/api/admin/conversations/'+encodeURIComponent(activeId)+'/reply',{method:'POST',body:JSON.stringify({message:text})}).then(function(){ $('replyText').value=''; loadMessages(activeId); loadConversations(true); toast('Mesaj gönderildi')}).catch(function(err){alert('Mesaj gönderilemedi: '+err.message)}).finally(function(){$('sendReply').disabled=false})});
  $('replyText').addEventListener('input',function(){ if(!activeId)return; clearTimeout(typingTimer); clearTimeout(typingStop); typingTimer=setTimeout(function(){sendTyping(true)},100); typingStop=setTimeout(function(){sendTyping(false)},2500); });
  function sendTyping(isTyping,forced){var id=forced||activeId; if(!id||!token)return; if(isTyping&&typingFor===id)return; if(!isTyping&&!typingFor&&!forced)return; if(isTyping)typingFor=id; if(!isTyping&&(!forced||typingFor===id))typingFor=''; api('/api/admin/conversations/'+encodeURIComponent(id)+'/typing',{method:'POST',body:JSON.stringify({typing:!!isTyping})}).catch(function(){})}
  $('closeConversation').addEventListener('click',function(){if(!activeId)return; var c=getActive(); api('/api/admin/conversations/'+encodeURIComponent(activeId)+'/status',{method:'POST',body:JSON.stringify({status:c.status==='closed'?'open':'closed'})}).then(function(){loadConversations(true);toast('Durum güncellendi')})});
  function loadCrmDetail(id,silent){var c=getActive(); setText('crmTitle',c.displayName||'Ziyaretçi'); setText('crmSub',c.pageTitle||c.pageUrl||'Müşteri kaydı'); setText('crmPhone',c.visitorPhone||'-'); setText('crmStatus',c.status||'open'); setText('crmLast',c.lastMessageText||'-'); $('noteText').disabled=false; $('noteReminder').disabled=false; $('noteBtn').disabled=false; if(!silent)$('notesList').innerHTML='<div class="empty">Notlar yükleniyor...</div>'; return api('/api/admin/conversations/'+encodeURIComponent(id)+'/messages').then(function(d){renderNotes(d.notes||[])}).catch(function(err){$('notesList').innerHTML='<div class="empty">CRM yüklenemedi: '+escapeHtml(err.message)+'</div>'})}
  function renderNotes(notes){var el=$('notesList'); if(!notes.length){el.innerHTML='<div class="empty">Bu müşteri için henüz özel not yok.</div>';return;} el.innerHTML=notes.map(function(n){return '<div class="note '+(n.completedAt?'done':'')+'"><div class="row"><div class="note-body">'+escapeHtml(n.body)+'</div><button class="btn ghost note-done" data-id="'+escapeHtml(n.id)+'" data-done="'+(n.completedAt?'1':'0')+'">'+(n.completedAt?'Geri Al':'Tamamla')+'</button></div><div class="note-meta">Hatırlatma: '+escapeHtml(n.reminderAt?fmtDate(n.reminderAt):'Yok')+' • Oluşturuldu: '+fmtDate(n.createdAt)+'</div></div>'}).join(''); qsa('.note-done').forEach(function(b){b.addEventListener('click',function(){api('/api/admin/notes/'+encodeURIComponent(b.getAttribute('data-id')),{method:'PATCH',body:JSON.stringify({completed:b.getAttribute('data-done')!=='1'})}).then(function(){loadCrmDetail(activeId);loadReminders()})})})}
  $('noteForm').addEventListener('submit',function(e){e.preventDefault(); if(!activeId)return; var text=$('noteText').value.trim(); if(!text)return; $('noteBtn').disabled=true; api('/api/admin/conversations/'+encodeURIComponent(activeId)+'/notes',{method:'POST',body:JSON.stringify({note:text,reminderAt:$('noteReminder').value||''})}).then(function(){$('noteText').value='';$('noteReminder').value='';loadCrmDetail(activeId);loadReminders();toast('Müşteri notu eklendi')}).catch(function(err){alert('Not eklenemedi: '+err.message)}).finally(function(){$('noteBtn').disabled=false})});
  function imgHtml(src, cls){return '<div class="prod-img '+(cls||'')+'">'+(src?'<img src="'+escapeHtml(src)+'" alt="" loading="lazy">':'◇')+'</div>'}
  function orderProductsHtml(o){var items=o.items||[]; if(!items.length)return '<div class="empty">Ürün yok</div>'; return '<div class="order-products">'+items.map(function(i){return '<div class="order-product">'+imgHtml(i.image,'')+'<div><div class="name">'+escapeHtml(i.name||'Ürün')+'</div><div class="preview">'+(i.sku?'SKU: '+escapeHtml(i.sku)+' • ':'')+escapeHtml(i.status||'')+'</div></div><div class="badge">× '+Number(i.quantity||0)+'</div></div>'}).join('')+'</div>'}
  function orderCard(o){var amount=(o.currency||'₺')+' '+Number(o.total||0).toLocaleString('tr-TR'); return '<div class="order-card"><div class="row"><div><div class="name">'+escapeHtml(o.number||'Sipariş')+' — '+escapeHtml(o.customer||'')+'</div><div class="preview">'+fmtDate(o.orderedAt)+' • '+escapeHtml(o.status||'Durum yok')+' • '+escapeHtml(o.paymentStatus||'')+' • '+amount+'</div></div><span class="badge">'+escapeHtml(o.packageStatus||o.status||'Yeni')+'</span></div>'+orderProductsHtml(o)+'</div>'}
  function productCard(p){var variantText=(p.variants||[]).slice(0,3).map(function(v){return [v.sku, v.variantText].filter(Boolean).join(' • ')}).filter(Boolean).join(' / '); var cats=(p.categoryNames||[]).slice(0,3).map(function(c){return '<span class="chip">'+escapeHtml(c)+'</span>'}).join(''); return '<div class="product-card">'+imgHtml(p.image,'large')+'<div><div class="name">'+escapeHtml(p.name||'Ürün')+'</div><div class="preview">Stok: '+Number(p.totalStock||0)+' • Varyant: '+Number(p.variantCount||0)+'</div><div class="preview">'+escapeHtml(variantText||'Varyant bilgisi yok')+'</div><div class="chips">'+cats+'</div></div></div>'}
  function readyProductRow(p){var orderText=(p.orders||[]).slice(0,6).map(function(o){return escapeHtml(o.orderNumber)+' × '+Number(o.quantity||0)}).join(' • '); return '<div class="product-row">'+imgHtml(p.image,'')+'<div><div class="name">'+escapeHtml(p.name||'Ürün')+'</div><div class="preview">'+(p.sku?'SKU: '+escapeHtml(p.sku)+' • ':'')+orderText+'</div></div><div class="qty">'+Number(p.quantity||0)+'</div></div>'}
  function collectionCard(c){var productNames=(c.products||[]).slice(0,5).map(function(p){return escapeHtml(p.name)}).join(' • '); return '<div class="collection-card">'+imgHtml(c.image,'large')+'<div><div class="name">'+escapeHtml(c.name||'Koleksiyon')+'</div><div class="preview">'+Number(c.productCount||0)+' ürün</div><div class="preview" style="white-space:normal">'+productNames+'</div></div></div>'}
  function buildClientReadyProductTotals(orders){var map={}; (orders||[]).forEach(function(o){(o.items||[]).forEach(function(i){var key=(i.variantId||i.productId||i.name||'urun')+'|'+(i.sku||''); if(!map[key])map[key]={name:i.name||'Ürün',sku:i.sku||'',image:i.image||'',mainImageId:i.mainImageId||'',quantity:0,orders:[]}; map[key].quantity+=Number(i.quantity||0); map[key].orders.push({orderNumber:o.number||o.orderNumber||'',quantity:Number(i.quantity||0)})})}); return Object.keys(map).map(function(k){return map[k]}).sort(function(a,b){return Number(b.quantity||0)-Number(a.quantity||0)||String(a.name).localeCompare(String(b.name),'tr')})}
  function renderIkas(){
    var totals=ikasSummary.totals||{};
    var ordersAll=(ikasSummary.orders||[]).slice().sort(function(a,b){return (Number(b.orderSort||0)-Number(a.orderSort||0)) || String(b.orderedAt||'').localeCompare(String(a.orderedAt||''))});
    var orders=applyDateFilter(ordersAll).sort(function(a,b){return (Number(b.orderSort||0)-Number(a.orderSort||0)) || String(b.orderedAt||'').localeCompare(String(a.orderedAt||''))});
    var readyOrders=orders.filter(function(o){return /Kargoya Hazır/i.test(o.packageStatus||o.status||'')}).sort(function(a,b){return (Number(b.orderSort||0)-Number(a.orderSort||0)) || String(b.orderedAt||'').localeCompare(String(a.orderedAt||''))});
    var delivered=orders.filter(function(o){return /Teslim Edildi/i.test(o.packageStatus||o.status||'')}).sort(function(a,b){return (Number(b.orderSort||0)-Number(a.orderSort||0)) || String(b.orderedAt||'').localeCompare(String(a.orderedAt||''))});
    var readyProducts=buildClientReadyProductTotals(readyOrders);
    var allProducts=ikasSummary.products||[];
    var collections=ikasSummary.collections||[];
    var units=orders.reduce(function(sum,o){return sum+(o.items||[]).reduce(function(s,i){return s+Number(i.quantity||0)},0)},0);
    var readyUnits=readyOrders.reduce(function(sum,o){return sum+(o.items||[]).reduce(function(s,i){return s+Number(i.quantity||0)},0)},0);
    setText('statOrders',orders.length||0); setText('badgeOrders',orders.length||0); setText('ordersToday',orders.length||0); setText('unitsToday',units||0); setText('kindsToday',readyProducts.length||allProducts.length||0); setText('ordersTotal',orders.length||0); setText('unitsTotal',readyUnits||units||0); setText('productKinds',allProducts.length||readyProducts.length||0); setText('ikasStatus',ikasSummary.connected?'Bağlı':'Bekliyor'); setText('readyOrdersBadge',readyOrders.length||0); setText('badgeReadyOrders',readyOrders.length||0); setText('allOrdersBadge',orders.length||0); setText('deliveredOrdersBadge',delivered.length||0);
    var top=$('topProducts'); if(top){ top.innerHTML=readyProducts.length?readyProducts.slice(0,5).map(function(p,i){return '<div class="rail-product">'+imgHtml(p.image,'')+'<div><div class="name">'+(i+1)+'. '+escapeHtml(p.name||'Ürün')+'</div><div class="preview">'+Number(p.quantity||0)+' adet • Kargoya hazır</div></div></div>'}).join(''):'<div class="empty">Kargoya hazır ürün bulunamadı.</div>'; }
    var el=$('productTotals'); if(el){ el.innerHTML=readyProducts.length?readyProducts.map(readyProductRow).join(''):'<div class="empty">Kargoya hazır olarak işaretlenmiş siparişlerde ürün yok.</div>'; }
    var list=$('ordersList'); if(list){ list.innerHTML=orders.length?orders.slice(0,60).map(orderCard).join(''):(ikasSummary.ikasError?'<div class="empty">'+escapeHtml(ikasSummary.ikasError)+'</div>':'<div class="empty">Henüz canlı sipariş verisi bağlı değil.</div>'); }
    var deliveredList=$('deliveredOrdersList'); if(deliveredList){ deliveredList.innerHTML=delivered.length?delivered.map(orderCard).join(''):'<div class="empty">Teslim edilen sipariş bulunamadı.</div>'; }
    var allOrdersEl=$('ikasAllOrders'); if(allOrdersEl){ allOrdersEl.innerHTML=orders.length?orders.map(orderCard).join(''):'<div class="empty">Sipariş bulunamadı.</div>'; }
    var readyOrdersEl=$('ikasReadyOrders'); if(readyOrdersEl){ readyOrdersEl.innerHTML=readyOrders.length?readyOrders.map(orderCard).join(''):'<div class="empty">Kargoya hazır sipariş bulunamadı.</div>'; }
    var readyProductsEl=$('ikasReadyProductTotals'); if(readyProductsEl){ readyProductsEl.innerHTML=readyProducts.length?readyProducts.map(readyProductRow).join(''):'<div class="empty">Hazırlanacak ürün toplamı yok.</div>'; }
    var productsEl=$('ikasAllProducts'); if(productsEl){ productsEl.innerHTML=allProducts.length?'<div class="product-grid">'+allProducts.map(productCard).join('')+'</div>':(ikasSummary.productError?'<div class="empty">Ürünler çekilemedi: '+escapeHtml(ikasSummary.productError)+'</div>':'<div class="empty">Ürün bulunamadı. Ürün API bağlantısı boş döndü.</div>'); }
    var productsGrid=$('productsGrid'); if(productsGrid){ productsGrid.innerHTML=allProducts.length?'<div class="product-grid">'+allProducts.map(productCard).join('')+'</div>':'<div class="empty">Ürün bulunamadı. Ürün API bağlantısı boş döndü.</div>'; }
    var collectionsEl=$('ikasAllCollections'); if(collectionsEl){ collectionsEl.innerHTML=collections.length?'<div class="product-grid">'+collections.map(collectionCard).join('')+'</div>':'<div class="empty">Koleksiyon/kategori bulunamadı.</div>'; }
  }
  function formatDate(value){if(!value)return ''; try{return new Date(value).toLocaleString('tr-TR',{timeZone:ISTANBUL_TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}catch(e){return ''}}
    if($('syncOrders'))$('syncOrders').addEventListener('click',function(){loadIkasSummary().then(function(){toast('ikas verisi yenilendi')})}); if($('quickSync'))$('quickSync').addEventListener('click',function(){setRoute('ikas-orders',true);loadIkasSummary().then(function(){toast('ikas verisi yenilendi')})}); qsa('.ikas-refresh').forEach(function(btn){btn.addEventListener('click',function(){loadIkasSummary().then(function(){toast('ikas verisi yenilendi')})})});
  $('refreshSupport').addEventListener('click',function(){loadConversations(false)}); $('refreshCrm').addEventListener('click',function(){loadConversations(false)}); $('searchInput').addEventListener('input',renderConversations); $('crmSearch').addEventListener('input',renderCustomers);
  $('pushBtn').addEventListener('click',subscribePush);
  function subscribePush(){ if(!('serviceWorker' in navigator)||!('PushManager' in window)){alert('Bu tarayıcı bildirim desteklemiyor.');return;} api('/api/admin/me').then(function(me){if(!me.vapidPublicKey)throw new Error('VAPID key yok'); return navigator.serviceWorker.register('/sw.js').then(function(reg){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(me.vapidPublicKey)})})}).then(function(sub){return api('/api/admin/push/subscribe',{method:'POST',body:JSON.stringify({subscription:sub})})}).then(function(){toast('Bildirimler açıldı')}).catch(function(err){alert('Bildirim açılamadı: '+err.message)})}
  function urlBase64ToUint8Array(base64String){var padding='='.repeat((4-base64String.length%4)%4); var base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/'); var raw=atob(base64); var arr=new Uint8Array(raw.length); for(var i=0;i<raw.length;++i)arr[i]=raw.charCodeAt(i); return arr}
  if(token){showApp()} else {$('loginPage').classList.remove('hidden')}
})();
</script>
</body>
</html>`;
}

function requireAdmin(req, res) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload || !isKnownAdmin(payload.sub)) {
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
  if (res.headersSent || res.writableEnded) return true;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
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
    customerType: String(conversation.visitorPhone || "").startsWith("Üye") ? "Üye" : (String(conversation.visitorPhone || "").startsWith("Misafir") ? "Misafir" : ""),
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


function normalizeCustomerInfo(input) {
  const raw = input && typeof input === "object" ? input : {};
  const type = raw.type === "member" ? "member" : "guest";
  const firstName = String(raw.firstName || "").trim().slice(0, 80);
  const lastName = String(raw.lastName || "").trim().slice(0, 80);
  const fullName = String(raw.fullName || [firstName, lastName].filter(Boolean).join(" ") || "").trim().replace(/\s+/g, " ").slice(0, 120);
  return {
    type,
    source: String(raw.source || "").slice(0, 80),
    fullName,
    firstName,
    lastName,
    email: String(raw.email || "").trim().slice(0, 160),
    phone: String(raw.phone || "").trim().slice(0, 80),
    customerId: String(raw.customerId || "").trim().slice(0, 120),
    merchantId: String(raw.merchantId || "").trim().slice(0, 120)
  };
}

function buildCustomerMetaLine(info, fallbackPhone) {
  const parts = [];
  parts.push(info.type === "member" ? "Üye" : "Misafir");
  if (info.email) parts.push(info.email);
  if (info.phone || fallbackPhone) parts.push(info.phone || fallbackPhone);
  if (info.customerId) parts.push(`ikas ID: ${info.customerId}`);
  return parts.filter(Boolean).join(" • ").slice(0, 260);
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
  const raw = String(value).trim();

  // <input type="datetime-local"> values arrive like "2026-06-24T14:30" with no timezone.
  // Render runs in UTC, so new Date(raw) would incorrectly treat that time as UTC.
  // The admin panel is used in Turkey, so timezone-less reminder inputs are interpreted
  // as Europe/Istanbul time (UTC+03:00) and stored as UTC ISO.
  const localMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (localMatch) {
    const year = Number(localMatch[1]);
    const month = Number(localMatch[2]);
    const day = Number(localMatch[3]);
    const hour = Number(localMatch[4]);
    const minute = Number(localMatch[5]);
    const second = Number(localMatch[6] || 0);
    const utcMs = Date.UTC(year, month - 1, day, hour - 3, minute, second);
    const date = new Date(utcMs);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString();
  }

  const date = new Date(raw);
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

function parseAdminUsers(rawValue, fallbackUser, fallbackPassword) {
  const raw = String(rawValue || "").trim();
  const users = [];
  if (raw) {
    raw.split(",").forEach((pair) => {
      const item = String(pair || "").trim();
      if (!item) return;
      const separator = item.indexOf(":");
      if (separator <= 0) return;
      const username = item.slice(0, separator).trim();
      const password = item.slice(separator + 1).trim();
      if (username && password) users.push({ username, password });
    });
  }
  if (!users.length && fallbackUser && fallbackPassword) {
    users.push({ username: fallbackUser, password: fallbackPassword });
  }
  return users;
}

function isValidAdminUser(username, password) {
  return ADMIN_USERS.some((admin) => admin.username === username && admin.password === password);
}

function isKnownAdmin(username) {
  return ADMIN_USERS.some((admin) => admin.username === username);
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
