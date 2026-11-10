/* NYRO interface. Talks to Python through one bridge: call(method, args) -> Promise, plus pushed events. */
"use strict";
try { document.documentElement.dataset.theme = localStorage.getItem("nyro-theme") || "dark"; } catch (e) {}

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  account: null, settings: {}, models: {}, chatId: null, chats: [], busy: false,
  mode: "task", model: "swift", attachments: [], streamEl: null, streamText: "",
  imageQualities: [], aspects: ["1:1", "16:9", "9:16", "4:3", "3:4"], aspect: "1:1", quality: "", version: "",
  voiceOpen: false, mic: false, status: "idle", levels: { mic: 0, speak: 0 },
};

/* ═════════════ bridge ═════════════ */
const Bridge = {
  obj: null, ready: null, handlers: {},
  init() {
    this.ready = new Promise((resolve) => {
      if (window.CloudBridge) { this.obj = CloudBridge; CloudBridge.emit = onEvent; resolve(); return; }     // the web app (phone/browser)
      if (window.qt && window.qt.webChannelTransport && window.QWebChannel) {
        new QWebChannel(qt.webChannelTransport, (ch) => {
          this.obj = ch.objects.nyro;
          this.obj.pushed.connect((s) => { try { const e = JSON.parse(s); onEvent(e.kind, e.data || {}); } catch (err) { console.error(err); } });
          resolve();
        });
      } else if (window.qt) {
        console.error("qwebchannel.js not loaded");
        document.body.innerHTML = '<p style="color:#fff;padding:40px;font-size:18px">Nyro did not start properly. Please close Nyro and open it again.</p>';
      } else { this.obj = MockBridge; MockBridge.emit = onEvent; resolve(); }     // browser design preview only
    });
    return this.ready;
  },
  call(method, args = {}) {
    return this.ready.then(() => new Promise((resolve) => {
      this.obj.call(method, JSON.stringify(args), (r) => {
        let res; try { res = JSON.parse(r); } catch { res = { ok: false, error: "bad reply" }; }
        resolve(res);
      });
    }));
  },
};

/* ═════════════ markdown (safe: everything is escaped first) ═════════════ */
function md(src) {
  if (/\[\[image:[^\]]+\]\]/.test(String(src))) {     // photos Zylos-Gen made
    return String(src).split(/(\[\[image:[^\]]+\]\])/).map((part) => {
      const m = part.match(/^\[\[image:([^\]]+)\]\]$/);
      return m ? photoHTML(m[1]) : part.trim() ? md(part) : "";
    }).join("");
  }
  const blocks = [];
  let text = String(src ?? "").replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
    blocks.push({ lang, code: code.replace(/\n$/, "") });
    return `\u0000${blocks.length - 1}\u0000`;
  });
  text = esc(text);
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ext="1">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" data-ext="1">$2</a>');
  const out = []; let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const cb = line.match(/^\u0000(\d+)\u0000$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/), h = line.match(/^(#{1,4})\s+(.*)$/);
    if ((ul || ol) && !cb) {
      const type = ul ? "ul" : "ol";
      if (!list || list.type !== type) { if (list) out.push(`</${list.type}>`); list = { type }; out.push(`<${type}>`); }
      out.push(`<li>${inline((ul || ol)[1])}</li>`); continue;
    }
    if (list) { out.push(`</${list.type}>`); list = null; }
    if (cb) { const b = blocks[+cb[1]];
      out.push(`<div class="codeblock"><div class="cb-head">${esc(b.lang || "code")}<button class="cb-copy">Copy</button></div><pre>${esc(b.code)}</pre></div>`); continue; }
    if (h) { out.push(`<h4>${inline(h[2])}</h4>`); continue; }
    if (!line.trim()) { out.push(""); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list.type}>`);
  return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${esc(blocks[+i].code)}</pre>`);
}

/* ═════════════ helpers ═════════════ */
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), ms); }
const STATUS_TEXT = { idle: "Idle", listening: "Listening...", thinking: "Thinking...", working: "Working...", speaking: "Speaking...", confirm: "Needs your OK", loading: "Starting…" };
function setStatus(s) {
  S.status = s;
  for (const pill of [$("#statusPill"), $("#vStatus")]) pill.dataset.s = s;
  $("#statusText").textContent = STATUS_TEXT[s] || s;
  $("#vStatusText").textContent = STATUS_TEXT[s] || s;
  $("#voice").dataset.s = s;
}
function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }
function fmtDate(iso) { try { return new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } }

/* ═════════════ login ═════════════ */
let loginTab = "login";
function showLogin() {
  $("#app").hidden = true; $("#voice").hidden = true; $("#login").hidden = false;
  $("#loginName").focus();
}
$$("#loginTabs .seg-btn").forEach((b) => b.addEventListener("click", () => {
  loginTab = b.dataset.tab;
  $$("#loginTabs .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
  const up = loginTab === "signup";
  $("#loginSubmit").textContent = up ? "Create account" : "Sign in";
  $("#loginPassLabel").textContent = up ? "Set a password (at least 6 characters)" : "Password";
  $$(".signup-only").forEach((el) => (el.hidden = !up));
  ["#loginFirst", "#loginLast", "#loginPass2"].forEach((id) => ($(id).required = up));
  (up ? $("#loginFirst") : $("#loginName")).focus();
  $("#loginError").textContent = "";
}));
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#loginSubmit"); btn.disabled = true; $("#loginError").textContent = "";
  const up = loginTab === "signup";
  if (up && $("#loginPass").value !== $("#loginPass2").value) { btn.disabled = false; $("#loginError").textContent = "The two passwords are not the same."; return; }
  const r = await Bridge.call(up ? "signup" : "login", up
    ? { first_name: $("#loginFirst").value, last_name: $("#loginLast").value, email: $("#loginName").value,
        password: $("#loginPass").value, password2: $("#loginPass2").value, marketing_ok: $("#loginNews").checked }
    : { email: $("#loginName").value, password: $("#loginPass").value });
  btn.disabled = false;
  if (!r.ok) { $("#loginError").textContent = r.error; return; }
  $("#loginPass").value = ""; $("#loginPass2").value = "";
  enterApp(r.data);
});
$("#guestBtn").addEventListener("click", async () => { const r = await Bridge.call("guest"); if (r.ok) enterApp(r.data); });
$("#loginBack").addEventListener("click", () => $("#guestBtn").click());

/* ═════════════ app ═════════════ */
function enterApp(data) {
  S.account = data.account; S.settings = data.settings || {}; S.models = data.models || {};
  S.imageQualities = data.image_qualities || []; S.aspects = data.aspects || S.aspects; S.version = data.version || "";
  S.aspect = S.settings.image_aspect || "1:1"; S.quality = S.settings.image_quality || S.imageQualities[S.imageQualities.length - 1] || "";
  S.mode = S.account.tier === "guest" ? "chat" : (S.settings.chat_mode || "task");
  const chatModels = S.account.models.filter((m) => m !== "zylos");
  S.model = chatModels.includes(S.settings.model_tier) ? S.settings.model_tier : chatModels[chatModels.length > 1 ? 1 : 0];
  $("#login").hidden = true; $("#app").hidden = false;
  renderAccount(); renderModels(); renderMode(); renderPhotoBar(); setStatus(data.status || "idle");
  $("#helpVersion").textContent = S.version ? `Nyro ${S.version}` : ""; $("#versionInfo").textContent = S.version ? `Nyro version ${S.version}` : "";
  applyTheme(S.settings.theme || "dark");
  newChat(); loadChats(); loadReminderCount(); loadTodoCount();
  if (!data.has_ai_key) addSystemNote("Welcome! Before you start, open ⚙ Settings → AI, paste your Gemini API key and press Save.");
  if (data.update) showUpdate(data.update);
  $("#input").focus();
}
function renderAccount() {
  const a = S.account;
  $("#avatar").textContent = (a.name || "G").slice(0, 1).toUpperCase();
  $("#whoName").textContent = a.name;
  $("#whoTier").innerHTML = a.tier === "pro" ? '<span class="badge-pro">PRO</span>'
    : a.tier === "free" ? 'Free <button class="upgrade" data-view="upgrade">Upgrade</button>'
    : 'Guest <button class="upgrade" data-action="signin">Sign in</button>';
  $("#accountAction").innerHTML = a.tier === "pro" ? '<span class="top-pro" title="Nyro Pro is active">PRO</span>'
    : a.tier === "free" ? '<button class="top-btn upgrade-btn" data-view="upgrade">✨ Upgrade</button>'
    : '<button class="top-btn signin-btn" data-action="signin">Sign in / Sign up</button>';
  $("#accountInfo").innerHTML = `<b>${esc(a.name)}</b> · ${a.tier === "pro" ? '<span class="badge-pro">PRO</span>' : esc(a.tier)}`
    + (a.email ? `<br><span class="muted small">${esc(a.email)}</span>` : "");
  $$(".pro-only").forEach((el) => (el.hidden = a.tier !== "pro"));
  $("#chips").hidden = a.tier === "guest";
}
function renderModels() {
  const menu = $("#modelMenu"); menu.innerHTML = "";
  for (const [key, m] of Object.entries(S.models)) {
    const allowed = S.account.models.includes(key);
    if (key === "zylos") menu.appendChild(Object.assign(document.createElement("div"), { className: "mo-sep" }));
    const b = document.createElement("button");
    b.className = "model-opt" + (allowed ? "" : " locked") + (key === "zylos" ? " zylos" : "");
    b.innerHTML = `<div><div class="mo-name">${key === "zylos" ? "🖼️ " : ""}${esc(m.label)} ${allowed ? "" : "🔒"}</div><div class="mo-note">${esc(m.note)}</div></div>${key === S.model ? '<span class="mo-check">✓</span>' : ""}`;
    b.addEventListener("click", () => {
      if (!allowed) {
        if (key === "zylos") { menu.hidden = true; askSignIn("Creating photos needs an account. Sign in, or sign up for free."); }
        else if (key === "pro") { menu.hidden = true; showView("upgrade"); }
        else { menu.hidden = true; askSignIn("This model needs an account. Sign in, or sign up for free."); }
        return;
      }
      S.model = key; menu.hidden = true; renderModels(); renderPhotoBar();
      if (key !== "zylos") Bridge.call("settings_save", { model_tier: key });
    });
    menu.appendChild(b);
  }
  $("#modelLabel").textContent = (S.models[S.model] || {}).label || "Swift 1.1";
}
$("#modelBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#modelMenu").hidden = !$("#modelMenu").hidden; });
document.addEventListener("click", (e) => { if (!e.target.closest("#modelPicker")) $("#modelMenu").hidden = true; });

function renderMode() {
  $$(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === S.mode));
}
$$(".mode-btn").forEach((b) => b.addEventListener("click", () => {
  if (S.account.tier === "guest" && b.dataset.mode === "task") { askSignIn("Task mode needs an account. Sign in, or sign up for free."); return; }
  S.mode = b.dataset.mode; renderMode(); Bridge.call("settings_save", { chat_mode: S.mode });
}));

/* ═════════════ navigation ═════════════ */
function showView(name) {
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  $$(".sb-nav .nav-item, .sb-links .nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === name && name !== "chat"));
  if (name === "notes") loadNotes();
  if (name === "memory") loadMemory();
  if (name === "activity") loadActivity();
  if (name === "settings") loadSettings();
  if (name === "reminders") loadReminders();
  if (name === "todo") loadTodos();
  if (name === "inbox") loadInbox(true);
}
document.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="signin"]')) { goSignIn(); return; }
  const v = e.target.closest("[data-view]");
  if (!v || v.closest("#modelMenu")) return;
  if (v.id === "navNewChat") { newChat(); return; }
  showView(v.dataset.view);
});
$("#topNewChat").addEventListener("click", newChat);
$("#sbToggle").addEventListener("click", () => { $("#app").classList.add("sb-closed"); $("#sbOpen").hidden = false; });
$("#sbOpen").addEventListener("click", () => { $("#app").classList.remove("sb-closed"); $("#sbOpen").hidden = true; });
$("#sbSearchBtn").addEventListener("click", () => { const s = $("#sbSearch"); s.hidden = !s.hidden; if (!s.hidden) $("#chatFilter").focus(); });
$("#chatFilter").addEventListener("input", onChatSearch);
$("#chatFilter").addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#chatFilter").value = ""; onChatSearch(); $("#sbSearch").hidden = true; } });

/* ═════════════ chats ═════════════ */
async function loadChats() { const r = await Bridge.call("chats"); if (r.ok) { S.chats = r.data; renderChats(); } }
let searchTimer = null, searchHits = null;
function onChatSearch() {
  const q = $("#chatFilter").value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { searchHits = null; renderChats(); return; }
  searchTimer = setTimeout(async () => {
    const r = await Bridge.call("search_chats", { q });
    if ($("#chatFilter").value.trim() !== q) return;
    searchHits = r.ok ? r.data : []; renderChats();
  }, 220);
}
function renderChats() {
  const q = $("#chatFilter").value.trim().toLowerCase();
  const list = $("#chatList"); list.innerHTML = "";
  if (searchHits && q.length >= 2) {
    list.insertAdjacentHTML("beforeend", `<div class="sb-label">Search results</div>`);
    if (!searchHits.length) { list.insertAdjacentHTML("beforeend", `<div class="chat-empty">Nothing found</div>`); return; }
    for (const c of searchHits) list.appendChild(chatRow(c, c.snippet));
    return;
  }
  const items = S.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  if (!items.length) { list.innerHTML = `<div class="sb-label">All chats</div><div class="chat-empty">${q ? "Nothing found" : "No chats yet"}</div>`; return; }
  const pinned = items.filter((c) => c.pinned), rest = items.filter((c) => !c.pinned);
  for (const [label, group] of [["Pinned", pinned], ["All chats", rest]]) {
    if (!group.length) continue;
    list.insertAdjacentHTML("beforeend", `<div class="sb-label">${label}</div>`);
    for (const c of group) list.appendChild(chatRow(c));
  }
}
function chatRow(c, snippet) {
  const el = document.createElement("div");
  el.className = "chat-item" + (c.id === S.chatId ? " active" : "");
  el.title = `${c.title}\n${fmtDate(c.updated_at)}`;
  el.innerHTML = `${c.pinned ? '<span class="pin">📌</span>' : ""}<span class="t">${esc(c.title)}${snippet ? `<span class="hit">${esc(snippet)}</span>` : ""}</span><button class="dots" title="More">⋯</button>`;
  if (snippet) el.classList.add("with-hit");
  el.addEventListener("click", (e) => { if (e.target.closest(".dots") || e.target.closest(".rename")) return; openChat(c.id, c.title); });
  $(".dots", el).addEventListener("click", (e) => { e.stopPropagation(); openChatMenu(c, el, e.currentTarget); });
  return el;
}
function openChatMenu(c, row, btn) {
  const m = $("#chatMenu");
  m.innerHTML = `<button data-a="pin">📌 ${c.pinned ? "Unpin" : "Pin"}</button>
    <button data-a="rename">✏️ Rename</button>
    <div class="mp-sub"><button data-a="share">📤 Share <span class="arrow">›</span></button>
      <div class="mp-side"><button data-a="md">Markdown (.md)</button><button data-a="pdf">PDF (.pdf)</button></div></div>
    <div class="mp-sep"></div>
    <button data-a="delete" class="danger">🗑️ Delete</button>`;
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.min(r.left, innerWidth - 230)}px`; m.style.top = `${Math.min(r.bottom + 4, innerHeight - 200)}px`;
  m.hidden = false;
  m.onclick = async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return;
    if (a === "share") { m.querySelector(".mp-sub").classList.toggle("open"); return; }
    m.hidden = true;
    if (a === "pin") { await Bridge.call("pin_chat", { id: c.id, pinned: !c.pinned }); loadChats(); }
    if (a === "rename") startRename(c, row);
    if (a === "md" || a === "pdf") {
      const res = await Bridge.call("export_chat", { id: c.id, format: a });
      if (!res.ok) toast(res.error); else if (res.data.saved) toast(`Saved ${a.toUpperCase()} ✓`);
    }
    if (a === "delete") {
      const yes = await ask("Delete this chat?", `“${esc(c.title)}” and all its messages will be deleted.`, "Delete", true);
      if (!yes) return;
      await Bridge.call("delete_chat", { id: c.id }); if (c.id === S.chatId) newChat(); loadChats();
    }
  };
}
document.addEventListener("click", (e) => { if (!e.target.closest("#chatMenu") && !e.target.closest(".dots")) $("#chatMenu").hidden = true; });
function startRename(c, row) {
  const t = $(".t", row); const inp = document.createElement("input");
  inp.className = "rename"; inp.value = c.title; t.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const title = inp.value.trim();
    if (save && title && title !== c.title) {
      const r = await Bridge.call("rename_chat", { id: c.id, title });
      if (!r.ok) toast(r.error);
      if (c.id === S.chatId) $("#chatTitle").textContent = title;
    }
    loadChats();
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") { e.stopPropagation(); finish(false); } });
  inp.addEventListener("blur", () => finish(true));
}
function clearMessages() { const m = $("#messages"); $$(".msg, .confirm-card, .sys-note", m).forEach((x) => x.remove()); }
function newChat() {
  if (S.busy) { toast("Nyro is still working…"); return; }
  S.chatId = null; Bridge.call("new_chat");
  clearMessages(); $("#welcome").hidden = false; $("#chatTitle").textContent = "";
  showView("chat"); renderChats(); $("#input").focus();
}
async function openChat(id, title) {
  if (S.busy) { toast("Nyro is still working…"); return; }
  const r = await Bridge.call("open_chat", { id }); if (!r.ok) return;
  S.chatId = id; clearMessages(); $("#welcome").hidden = r.data.length > 0;
  for (const m of r.data) addMessage(m.role === "user" ? "user" : "nyro", m.content, m.created_at);
  $("#chatTitle").textContent = title || ""; showView("chat"); renderChats(); scrollDown(true);
}

/* ═════════════ messages ═════════════ */
function scrollDown(force) { const m = $("#messages"); if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight; }
function addMessage(who, text, time, files) {
  $("#welcome").hidden = true;
  const row = document.createElement("div"); row.className = `msg ${who}`;
  const bubble = document.createElement("div"); bubble.className = "bubble";
  if (who === "user") {
    const [body, ...att] = String(text).split("\n📎 ");
    bubble.innerHTML = esc(body).replace(/\n/g, "<br>");
    const names = files && files.length ? files : att.length ? att.join(", ").split(", ") : [];
    if (names.length) bubble.innerHTML += `<div class="files">${names.map((n) => `<span class="file-tag">📎 ${esc(n)}</span>`).join("")}</div>`;
  } else bubble.innerHTML = md(text);
  if (who === "nyro") { const av = document.createElement("img"); av.className = "av"; av.src = "assets/mark.webp"; row.appendChild(av); }
  row.appendChild(bubble);
  $("#messages").appendChild(row); scrollDown(who === "user");
  return bubble;
}
function addSystemNote(text) { const b = addMessage("nyro", text); b.parentElement.classList.add("sys-note"); }
function startStream() {
  S.streamText = "";
  S.streamEl = addMessage("nyro", "");
  S.streamEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
}
function renderStream(final) {
  if (!S.streamEl) startStream();
  const tags = S.streamEl._tags || "";
  S.streamEl.innerHTML = tags + (S.streamText ? md(S.streamText) : (final ? "" : '<span class="typing"><i></i><i></i><i></i></span>'));
  if (!final && S.streamText) { const last = S.streamEl.lastElementChild; if (last) last.classList.add("caret"); }
  scrollDown();
}
document.addEventListener("click", (e) => {
  const c = e.target.closest(".cb-copy");
  if (c) { copyText(c.closest(".codeblock").querySelector("pre").textContent); c.textContent = "Copied ✓"; setTimeout(() => (c.textContent = "Copy"), 1500); }
  const ph = e.target.closest("[data-photo]");
  if (ph) Bridge.call("open_path", { path: ph.dataset.photo, folder: ph.dataset.folder === "1" }).then((r) => !r.ok && toast(r.error));
  const a = e.target.closest("a[data-ext]");
  if (a) { e.preventDefault(); Bridge.call("open_url", { url: a.href }); }
});

/* ═════════════ composer ═════════════ */
const input = $("#input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; }
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("#sendBtn").addEventListener("click", () => (S.busy ? Bridge.call("stop") : send()));
$$(".chip").forEach((c) => c.addEventListener("click", () => {
  if (S.mode !== "task") { S.mode = "task"; renderMode(); }
  input.value = c.dataset.cmd; send();
}));
function setBusy(b) {
  S.busy = b;
  const s = $("#sendBtn"); s.classList.toggle("stop", b);
  s.innerHTML = b ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>'
                  : '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  s.title = b ? "Stop" : "Send";
}
async function send(textOverride) {
  const text = (textOverride ?? input.value).trim();
  if (!text && !S.attachments.length) return;
  if (S.busy) { const r = await Bridge.call("send", { text }); if (!r.ok) toast(r.error); input.value = ""; return; }   // e.g. "yes" for a permission
  if (S.model === "zylos" && !text) { toast("Describe the photo you want first."); return; }
  const r = await Bridge.call("send", { text, mode: S.mode, model: S.model, aspect: S.aspect, quality: S.quality,
    attachments: S.attachments.map(({ name, mime, data }) => ({ name, mime, data })) });
  if (!r.ok) { toast(r.error); return; }
  input.value = ""; autosize(); S.attachments = []; renderAttachments();
}

/* attachments */
$("#attachBtn").addEventListener("click", () => {
  if (S.account.tier === "guest") { /* guests may still attach a picture to ask about it */ }
  $("#fileInput").click();
});
function copyText(t) {
  const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch {} ta.remove();
}
["dragover", "drop"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
document.addEventListener("drop", (e) => { if (S.account && e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });
$("#fileInput").addEventListener("change", async (e) => { await addFiles(e.target.files); e.target.value = ""; });
async function addFiles(fileList) {
  showView("chat");
  for (const f of fileList) {
    const isVideo = (f.type || "").startsWith("video/");
    if (f.size > (isVideo ? 100 : 15) * 1024 * 1024) { toast(`${f.name}: ${isVideo ? "videos" : "files"} bigger than ${isVideo ? 100 : 15} MB can't be added`); continue; }
    const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.readAsDataURL(f); });
    S.attachments.push({ name: f.name, mime: f.type || "application/octet-stream", data, preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null });
  }
  renderAttachments(); input.focus();
}
function renderAttachments() {
  const row = $("#attachRow"); row.innerHTML = ""; row.hidden = !S.attachments.length;
  S.attachments.forEach((a, i) => {
    const el = document.createElement("div"); el.className = "attach";
    el.innerHTML = `${a.preview ? `<img src="${a.preview}">` : `<span class="ic">${(a.mime || "").startsWith("video/") ? "🎬" : "📄"}</span>`}<span>${esc(a.name)}</span><button title="Remove">×</button>`;
    $("button", el).addEventListener("click", () => { S.attachments.splice(i, 1); renderAttachments(); });
    row.appendChild(el);
  });
}

/* ═════════════ permission card ═════════════ */
function showConfirm(summary) {
  removeConfirm();
  const wrap = document.createElement("div"); wrap.className = "confirm-card"; wrap.id = "confirmCard";
  wrap.innerHTML = `<div class="confirm-inner"><h4>🔐 Nyro needs your OK</h4><div>${esc(summary)}</div>
    <div class="row"><button class="btn yes">✅ Yes, do it</button><button class="btn no">❌ No</button><span class="muted small">You can also say “yes” or “no”.</span></div></div>`;
  $(".yes", wrap).addEventListener("click", () => Bridge.call("confirm", { answer: true }));
  $(".no", wrap).addEventListener("click", () => Bridge.call("confirm", { answer: false }));
  $("#messages").appendChild(wrap); scrollDown(true);
  $("#vConfirmText").textContent = summary; $("#vConfirm").hidden = false;
}
function removeConfirm() { $("#confirmCard")?.remove(); $("#vConfirm").hidden = true; }
$$("#vConfirm [data-answer]").forEach((b) => b.addEventListener("click", () => Bridge.call("confirm", { answer: b.dataset.answer === "yes" })));

/* ═════════════ events from Python ═════════════ */
function onEvent(kind, d) {
  switch (kind) {
    case "status": setStatus(d.status); break;
    case "user_message":
      if (d.conversation_id) S.chatId = d.conversation_id;
      setBusy(true); showView("chat");
      addMessage("user", d.text, null, d.files);
      if (S.voiceOpen) { $("#vUser").textContent = d.text; $("#vReply").textContent = ""; }
      S.streamEl = null; startStream(); break;
    case "tool": {
      if (!S.streamEl) startStream();
      const names = { open_app: "Opening app", open_website: "Opening website", play_youtube: "Playing on YouTube", media_control: "Media control",
        set_volume: "Volume", save_note: "Saving note", remember: "Remembering", search_files: "Searching files", open_file: "Opening file",
        take_screenshot: "Screenshot", send_email: "Email", facebook_post: "Facebook", instagram_post: "Instagram", forget: "Deleting", search_memory: "Checking memory",
        web_search: "Searching the web", create_image: "Creating photo", add_todo: "Adding to-do", list_todos: "To-do list",
        complete_todo: "Ticking off", delete_todo: "Deleting to-do", daily_brief: "Daily brief", look_at_screen: "Looking at your screen", set_reminder: "Setting reminder", list_reminders: "Reminders", cancel_reminder: "Cancelling reminder" };
      S.streamEl._tags = (S.streamEl._tags || "") + `<span class="tool-tag">⚡ ${esc(names[d.name] || d.name)}</span>`;
      renderStream(false); break; }
    case "delta":
      S.streamText += d.text; renderStream(false);
      if (S.voiceOpen) $("#vReply").textContent = S.streamText.replace(/[*#`_>]/g, "").slice(-260);
      break;
    case "done":
      if (!S.streamText.trim() || d.error || d.stopped) S.streamText = d.text;
      renderStream(true); S.streamEl = null; setBusy(false); removeConfirm();
      if (S.voiceOpen) $("#vReply").textContent = S.streamText.replace(/[*#`_>]/g, "").slice(-260);
      S.streamText = ""; loadTodoCount(); break;
    case "confirm": showConfirm(d.summary); break;
    case "confirm_done": removeConfirm(); break;
    case "chats_changed": loadChats(); break;
    case "activity": if (!$("#view-activity").hidden) loadActivity(); break;
    case "voice": S.mic = d.mic; renderVoiceMic(); if (d.voice_mode && !S.voiceOpen) openVoice(false); if (!d.voice_mode && S.voiceOpen) closeVoice(false); break;
    case "levels": S.levels = d; break;
    case "f8":
      if (!S.account) return;
      if (!S.voiceOpen) { openVoice(true); }
      else Bridge.call("mic", { on: !S.mic });
      break;
    case "toast": toast(d.text); break;
    case "image": {
      if (!S.streamEl) startStream();
      S.streamEl._tags = (S.streamEl._tags || "") + photoHTML(d.path);
      renderStream(false); break; }
    case "reminder": showAlarm(d); loadReminderCount(); if (!$("#view-reminders").hidden) loadReminders(); break;
    case "gmail": $("#gmailStatus").textContent = d.text; break;
    case "update": showUpdate(d); break;
    case "daily_post": showDailyPost(d); break;
    case "autoreply": $("#arMsgText").textContent = d.text; $("#arSave").disabled = false; loadInbox(true); break;
    case "inbox": $("#inboxCount").hidden = !d.need; $("#inboxCount").textContent = d.need || "";
      if (!$("#view-inbox").hidden) loadInbox(false); break;
    case "update_progress":
      $("#updateBar").hidden = false;
      if (d.error) { $("#updateText").textContent = d.error; $("#updateBtn").disabled = false; $("#updateBtn").textContent = "Try again"; }
      else if (d.installing) $("#updateText").textContent = "Installing… Nyro will close and open again by itself.";
      else $("#updateText").textContent = d.pct >= 0 ? `Downloading the update… ${d.pct}%` : `Downloading the update… ${d.mb} MB`;
      break;
    case "account": applyAccount(d); toast(d.account.tier === "pro" ? "Nyro Pro is active ✨" : "Your plan changed: " + d.account.tier); break;
    case "meta": $("#metaStatus").textContent = d.text; $("#metaPermBtn").disabled = false;
      if (d.permanent) { $("#metaPermState").textContent = "· ✅ On"; $("#metaPerm").open = false; } break;
  }
}

/* ═════════════ pages ═════════════ */
async function loadNotes() {
  const r = await Bridge.call("notes"); const list = $("#notesList"); list.innerHTML = "";
  if (!r.ok || !r.data.length) { list.innerHTML = '<div class="empty">No notes yet. Tell Nyro: “Note this…”</div>'; return; }
  for (const n of r.data) {
    const c = document.createElement("div"); c.className = "card item-card";
    c.innerHTML = `<div class="body">${esc(n.content)}<div class="meta">${fmtDate(n.updated_at)}</div></div>
      <div class="acts"><button class="icon-btn" title="Edit">✎</button><button class="icon-btn" title="Delete">🗑</button></div>`;
    const [edit, del] = $$("button", c);
    edit.addEventListener("click", () => openNoteEditor(n));
    del.addEventListener("click", async () => { if (await ask("Delete this note?", esc(n.content.slice(0, 120)), "Delete", true)) { await Bridge.call("note_delete", { id: n.id }); loadNotes(); } });
    list.appendChild(c);
  }
}
let editingNote = null;
function openNoteEditor(n) { editingNote = n || null; $("#noteText").value = n ? n.content : ""; $("#noteEditor").hidden = false; $("#noteText").focus(); }
$("#noteNew").addEventListener("click", () => openNoteEditor(null));
$("#noteCancel").addEventListener("click", () => ($("#noteEditor").hidden = true));
$("#noteSave").addEventListener("click", async () => {
  const text = $("#noteText").value.trim(); if (!text) return;
  await Bridge.call("note_save", { id: editingNote?.id, text }); $("#noteEditor").hidden = true; loadNotes();
});
async function loadMemory() {
  const r = await Bridge.call("memory"); const list = $("#memoryList"); list.innerHTML = "";
  const kinds = { fact: "Fact", contact: "Contact", preference: "Preference", custom_command: "Custom command" };
  if (!r.ok || !r.data.length) { list.innerHTML = '<div class="empty">Nyro hasn\'t remembered anything yet.</div>'; return; }
  for (const m of r.data) {
    const c = document.createElement("div"); c.className = "card item-card";
    c.innerHTML = `<div class="body"><span class="kind">${esc(kinds[m.kind] || m.kind)}</span><br>${esc(m.content)}</div><div class="acts"><button class="icon-btn" title="Delete">🗑</button></div>`;
    $("button", c).addEventListener("click", async () => { if (await ask("Delete from memory?", esc(m.content.slice(0, 120)), "Delete", true)) { await Bridge.call("memory_delete", { id: m.id }); loadMemory(); } });
    list.appendChild(c);
  }
}
async function loadActivity() {
  const r = await Bridge.call("activity"); const list = $("#activityList"); list.innerHTML = "";
  if (!r.ok || !r.data.length) { list.innerHTML = '<div class="empty">Nothing done yet.</div>'; return; }
  for (const a of r.data) { const el = document.createElement("div"); el.className = "act"; el.innerHTML = `<span class="tm">${esc(a.time)}</span><span>${esc(a.icon)}</span><span>${esc(a.text)}</span>`; list.appendChild(el); }
}
$("#feedbackSend").addEventListener("click", async () => {
  const text = $("#feedbackText").value.trim(); if (!text) return;
  const r = await Bridge.call("feedback", { text });
  $("#feedbackMsg").textContent = r.ok ? "Thank you! Your feedback was saved ✓" : r.error; if (r.ok) $("#feedbackText").value = "";
});

/* settings */
async function loadSettings() {
  const r = await Bridge.call("settings_get"); if (!r.ok) return; const s = r.data;
  $("#setSpeechLang").value = s.speech_language || "auto"; $("#setAutostart").checked = !!s.start_with_windows;
  $("#setDpOn").checked = !!s.daily_post_on; $("#setDpTime").value = s.daily_post_time || "21:00";
  $("#setDpApprove").checked = s.daily_post_approve !== false; $("#setDpTopics").value = s.daily_post_topics || "";
  $("#setTheme").value = s.theme || "dark"; $("#setBrief").checked = !!s.brief_auto;
  $("#setBriefTime").value = s.brief_time || "08:00"; $("#setBriefCity").value = s.brief_city || "";
  $("#setVoice").checked = s.voice_enabled; $("#setWake").checked = s.wake_word_enabled;
  $("#setF8").checked = s.f8_enabled; $("#setStt").value = s.stt_model; $("#setSens").value = Math.round(s.speech_rms * 1000);
  $("#setTimeout").value = s.confirm_timeout_s; $("#setProvider").value = s.ai_provider;
  $("#geminiSaved").textContent = s.has_gemini_key ? "(saved)" : ""; $("#claudeSaved").textContent = s.has_claude_key ? "(saved)" : "";
  $('[data-remove="gemini"]').hidden = !s.has_gemini_key; $('[data-remove="claude"]').hidden = !s.has_claude_key;
  $("#setGemini").value = ""; $("#setClaude").value = ""; $("#setPageId").value = s.facebook_page_id || "";
  $("#gmailStatus").textContent = s.gmail || "Not connected"; $("#metaStatus").textContent = s.meta || "";
  $("#metaPermState").textContent = s.fb_permanent ? "· ✅ On" : "";
  $("#settingsMsg").textContent = "";
  $("#importBtn").hidden = !s.online;
  $("#accountMore").textContent = !s.online ? (S.account && S.account.tier !== "guest" ? "This account is saved only on this laptop. Sign up with your email to use it everywhere." : "")
    : S.account.tier === "pro" ? (s.pro_until ? `Pro until ${new Date(s.pro_until).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}` : "Pro for life")
    : "Online account: chats and memory sync to every laptop you sign in on.";
}
$$(".key-remove").forEach((b) => b.addEventListener("click", async (e) => {
  e.preventDefault();
  const which = b.dataset.remove === "gemini" ? "Gemini" : "Claude";
  if (!(await ask(`Remove your ${which} key?`, "It will be deleted from this laptop. Nyro will use the Nyro server instead.", "Remove", true))) return;
  const r = await Bridge.call("settings_save", { remove_key: b.dataset.remove });
  if (r.ok) loadSettings().then(() => ($("#settingsMsg").textContent = `✓ ${which} key removed`)); else toast(r.error);
}));
$("#importBtn").addEventListener("click", async () => {
  const yes = await ask("Bring chats from an old account",
    `Enter the username and password of an older Nyro account that was made on this laptop. Its chats, notes and reminders will be copied into this account.
     <label class="field"><span>Old username</span><input id="impName" autocomplete="off"></label>
     <label class="field"><span>Old password</span><input id="impPass" type="password"></label>`, "Copy chats");
  if (!yes) return;
  const r = await Bridge.call("import_local", { name: $("#impName").value, password: $("#impPass").value });
  if (!r.ok) { toast(r.error, 4000); return; }
  toast(`Done ✓ ${r.data.imported} items copied`); loadChats();
});
$("#settingsSave").addEventListener("click", async () => {
  const r = await Bridge.call("settings_save", {
    speech_language: $("#setSpeechLang").value, start_with_windows: $("#setAutostart").checked,
    daily_post_on: $("#setDpOn").checked, daily_post_time: $("#setDpTime").value || "21:00",
    daily_post_approve: $("#setDpApprove").checked, daily_post_topics: $("#setDpTopics").value,
    theme: $("#setTheme").value, brief_auto: $("#setBrief").checked, brief_time: $("#setBriefTime").value || "08:00",
    brief_city: $("#setBriefCity").value.trim() || "Dhaka",
    voice_enabled: $("#setVoice").checked, wake_word_enabled: $("#setWake").checked,
    f8_enabled: $("#setF8").checked, stt_model: $("#setStt").value, speech_rms: +$("#setSens").value / 1000,
    confirm_timeout_s: +$("#setTimeout").value, ai_provider: $("#setProvider").value,
    gemini_api_key: $("#setGemini").value.trim(), claude_api_key: $("#setClaude").value.trim() });
  if (!r.ok) $("#settingsMsg").textContent = r.error;
  if (r.ok) loadSettings().then(() => ($("#settingsMsg").textContent = "✓ Saved" + (r.data && r.data.restart ? " · restart Nyro to use the new speech model" : "")));
});
$("#gmailConnect").addEventListener("click", () => { $("#gmailStatus").textContent = "Allow access in your browser…"; Bridge.call("gmail_connect"); });
$("#gmailDisconnect").addEventListener("click", async () => { await Bridge.call("gmail_disconnect"); loadSettings(); });
$("#metaConnect").addEventListener("click", async () => {
  const r = await Bridge.call("meta_connect", { page_id: $("#setPageId").value, token: $("#setPageToken").value });
  $("#metaStatus").textContent = r.ok ? r.data : "❌ " + r.error; $("#setPageToken").value = "";
});
$("#metaDisconnect").addEventListener("click", async () => { await Bridge.call("meta_disconnect"); loadSettings(); });
$("#metaPermBtn").addEventListener("click", async (e) => {
  e.preventDefault(); $("#metaPermBtn").disabled = true;
  const r = await Bridge.call("meta_permanent", { page_id: $("#setPageId").value, app_id: $("#permAppId").value,
    app_secret: $("#permSecret").value, user_token: $("#permUserToken").value });
  $("#permSecret").value = ""; $("#permUserToken").value = "";
  $("#metaStatus").textContent = r.ok ? r.data : "❌ " + r.error;
  if (!r.ok) $("#metaPermBtn").disabled = false;
});
$("#logoutBtn").addEventListener("click", async () => { if (!(await ask("Log out?", "You can sign in again any time.", "Log out", true))) return; await Bridge.call("logout"); S.account = null; showLogin(); });

/* ═════════════ voice mode ═════════════ */
$("#micBtn").addEventListener("click", (e) => openVoice(true, e.currentTarget));
function openVoice(micOn, fromEl) {
  if (S.voiceOpen) return;
  const v = $("#voice");
  if (fromEl) { const r = fromEl.getBoundingClientRect(); v.style.setProperty("--vx", `${r.left + r.width / 2}px`); v.style.setProperty("--vy", `${r.top + r.height / 2}px`); }
  else { v.style.setProperty("--vx", "50%"); v.style.setProperty("--vy", "50%"); }
  v.classList.remove("closing"); v.hidden = false; S.voiceOpen = true;
  $("#vUser").textContent = ""; $("#vReply").textContent = S.account.tier === "guest" ? "Guest: chat only" : "";
  Bridge.call("voice", { on: true }).then(() => micOn && Bridge.call("mic", { on: true }));
  startCanvas();
}
function closeVoice(tell = true) {
  if (!S.voiceOpen) return;
  S.voiceOpen = false; const v = $("#voice"); v.classList.add("closing");
  setTimeout(() => { v.hidden = true; v.classList.remove("closing"); }, 340);
  if (tell) Bridge.call("voice", { on: false });
}
$("#vClose").addEventListener("click", () => closeVoice());
$("#vMic").addEventListener("click", () => Bridge.call("mic", { on: !S.mic }));
function renderVoiceMic() { $("#vMic").classList.toggle("on", S.mic); }
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.voiceOpen) { Bridge.call("stop"); closeVoice(); }
});

/* animated waves + particles around the centre image */
let raf = 0;
function startCanvas() {
  cancelAnimationFrame(raf);
  const cv = $("#vCanvas"), ctx = cv.getContext("2d"), core = $("#vCore");
  const dpr = window.devicePixelRatio || 1;
  const parts = Array.from({ length: 70 }, () => ({ a: Math.random() * Math.PI * 2, r: 0.3 + Math.random() * 0.9, s: 0.0006 + Math.random() * 0.0018, z: Math.random() }));
  let t = 0, smooth = 0;
  const bars = 64, hist = new Array(bars).fill(0);
  function frame() {
    if (!S.voiceOpen && $("#voice").hidden) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    t += 1;
    const st = S.status;
    const live = st === "listening" ? S.levels.mic : st === "speaking" ? S.levels.speak : 0;
    const base = st === "thinking" ? 0.22 + 0.12 * Math.sin(t / 9) : st === "idle" ? 0.06 : 0.1;
    const target = Math.max(base, Math.min(1, live * 1.4));
    smooth += (target - smooth) * 0.18;
    const cx = w / 2, cy = h * 0.46, R = Math.min(w, h) * 0.23;
    core.style.transform = `translate(-50%, -50%) scale(${1 + smooth * 0.08 + 0.012 * Math.sin(t / 30)})`;
    const col = st === "thinking" ? [167, 139, 250] : st === "speaking" ? [251, 160, 90] : [34, 227, 139];
    // glow ring
    const g = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.9);
    g.addColorStop(0, `rgba(${col},${0.22 + smooth * 0.3})`); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.9, 0, Math.PI * 2); ctx.fill();
    // waveform bars to the left and right
    hist.shift(); hist.push(smooth);
    const span = Math.min(w * 0.46, 620), gap = span / bars;
    for (let i = 0; i < bars; i++) {
      const k = i / bars, fall = Math.pow(1 - k, 1.4);
      const amp = (hist[bars - 1 - i] * 0.85 + 0.15 * Math.abs(Math.sin(t / 7 + i * 0.7))) * fall;
      const hh = 4 + amp * R * 1.2 * (0.6 + 0.4 * Math.sin(i * 1.7 + t / 5));
      const alpha = 0.25 + 0.65 * fall;
      for (const dir of [-1, 1]) {
        const x = cx + dir * (R * 0.95 + i * gap);
        const grd = ctx.createLinearGradient(x, cy - hh, x, cy + hh);
        grd.addColorStop(0, `rgba(${col},0)`); grd.addColorStop(0.5, `rgba(${col},${alpha})`); grd.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = grd; ctx.fillRect(x - 1.2, cy - hh, 2.4, hh * 2);
      }
    }
    // centre line
    ctx.strokeStyle = `rgba(${col},0.35)`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(cx - span - R, cy); ctx.lineTo(cx + span + R, cy); ctx.stroke();
    // floating particles
    for (const p of parts) {
      p.a += p.s * (1 + smooth * 3);
      const rr = R * (1.15 + p.r) + Math.sin(t / 40 + p.z * 9) * 8;
      const x = cx + Math.cos(p.a) * rr, y = cy + Math.sin(p.a) * rr * 0.82;
      const size = 1 + p.z * 2.4 + smooth * 1.5;
      ctx.fillStyle = `rgba(${col},${0.25 + p.z * 0.6})`; ctx.shadowColor = `rgba(${col},0.9)`; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
}


/* ═════════════ photos (Zylos-Gen 1.1) ═════════════ */
const PHOTO_CACHE = new Map();
function photoHTML(path) {
  const p = esc(path), cached = PHOTO_CACHE.get(path);
  return `<figure class="photo"><div class="ph-frame">${cached && cached.url ? `<img src="${cached.url}" data-photo="${p}" alt="">`
    : `<img data-load="${p}" alt=""><div class="ph-wait">Creating photo…</div>`}</div>
    <figcaption><span class="ph-name">${esc(path.split(/[\\/]/).pop())}${cached && cached.width ? ` · ${cached.width}×${cached.height}` : ""}</span>
    <button data-photo="${p}">Open</button><button data-photo="${p}" data-folder="1">Show in folder</button></figcaption></figure>`;
}
async function hydratePhotos() {
  for (const img of $$("img[data-load]")) {
    const path = img.dataset.load; img.removeAttribute("data-load");
    let info = PHOTO_CACHE.get(path);
    if (!info) { const r = await Bridge.call("image", { path }); info = r.ok ? r.data : { missing: true }; if (!info.missing) PHOTO_CACHE.set(path, info); }
    const fig = img.closest("figure");
    if (info.missing) { if (fig) fig.querySelector(".ph-frame").innerHTML = '<div class="ph-wait">This photo was moved or deleted.</div>'; continue; }
    img.src = info.url; img.dataset.photo = path; fig?.querySelector(".ph-wait")?.remove();
    const nm = fig?.querySelector(".ph-name"); if (nm) nm.textContent = `${info.name} · ${info.width}×${info.height}`;
    scrollDown();
  }
}
new MutationObserver(() => { if ($("img[data-load]")) hydratePhotos(); }).observe(document.body, { childList: true, subtree: true });

function renderPhotoBar() {
  const on = S.model === "zylos";
  $("#photoBar").hidden = !on; $("#composer").classList.toggle("photo-mode", on);
  $("#input").placeholder = on ? "Describe the photo you want…" : 'Ask "Nyro" …';
  $("#chips").hidden = on || !S.account || S.account.tier === "guest";
  const ar = { "1:1": "Square", "16:9": "Wide", "9:16": "Story", "4:3": "4:3", "3:4": "3:4" };
  $("#aspectChips").innerHTML = S.aspects.map((a) => `<button class="pb-chip${a === S.aspect ? " on" : ""}" data-aspect="${a}" title="${ar[a] || a}"><i class="shape s${a.replace(":", "x")}"></i>${a}</button>`).join("");
  $("#qualityChips").innerHTML = S.imageQualities.map((q) => `<button class="pb-chip${q === S.quality ? " on" : ""}" data-quality="${q}">${q}</button>`).join("")
    + (S.account && S.account.tier === "free" ? '<button class="pb-chip locked" data-view="upgrade" title="Pro: 2K–4K">2K–4K 🔒</button>' : "");
}
$("#photoBar").addEventListener("click", (e) => {
  const a = e.target.closest("[data-aspect]"), q = e.target.closest("[data-quality]");
  if (a) S.aspect = a.dataset.aspect;
  if (q) S.quality = q.dataset.quality;
  if (a || q) renderPhotoBar();
});

/* ═════════════ account: sign in / upgrade ═════════════ */
function askSignIn(text) {
  ask("Sign in to continue", esc(text), "Sign in / Sign up").then((yes) => yes && goSignIn());
}
async function goSignIn() {
  if (S.account && S.account.tier !== "guest") return;
  if (S.busy) { toast("Nyro is still working…"); return; }
  await Bridge.call("logout"); S.account = null; showLogin();
  $("#loginBack").hidden = false;
}
$("#getPro").addEventListener("click", () => ask("Get Nyro Pro", "Buy a Pro code from Nyro, then type it in the box below and press Activate.", "OK", false, true).then(() => $("#redeemCode").focus()));
$("#redeemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!S.account || S.account.tier === "guest") { askSignIn("Sign in or sign up first, then activate your Pro code."); return; }
  const btn = $("#redeemBtn"); btn.disabled = true; $("#redeemError").textContent = "";
  const r = await Bridge.call("redeem", { code: $("#redeemCode").value });
  btn.disabled = false;
  if (!r.ok) { $("#redeemError").textContent = r.error; return; }
  $("#redeemCode").value = "";
  applyAccount(r.data);
  const until = r.data.pro_until ? new Date(r.data.pro_until).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
  ask("Welcome to Nyro Pro ✨", until ? `Pro is active until <b>${esc(until)}</b>.` : "Pro is active for life.", "Great", false, true);
  showView("chat");
});
function applyAccount(data) {
  S.account = data.account; S.imageQualities = data.image_qualities || [];
  S.quality = S.imageQualities.includes(S.quality) ? S.quality : (S.imageQualities[S.imageQualities.length - 1] || "");
  renderAccount(); renderModels(); renderPhotoBar();
}

/* ═════════════ theme ═════════════ */
const darkQuery = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
function applyTheme(t) {
  S.theme = t;
  const real = t === "system" ? (darkQuery && !darkQuery.matches ? "light" : "dark") : t;
  document.documentElement.dataset.theme = real;
  try { localStorage.setItem("nyro-theme", real); } catch (e) {}
}
if (darkQuery) darkQuery.addEventListener("change", () => S.theme === "system" && applyTheme("system"));
$("#setTheme").addEventListener("change", (e) => applyTheme(e.target.value));      // preview right away

/* ═════════════ to-do ═════════════ */
async function loadTodoCount() {
  const r = await Bridge.call("todos"); const n = r.ok ? r.data.filter((t) => !t.done).length : 0;
  $("#todoCount").hidden = !n; $("#todoCount").textContent = n;
}
async function loadTodos() {
  const r = await Bridge.call("todos"); const list = $("#todoList"); list.innerHTML = "";
  const items = r.ok ? r.data : [];
  $("#todoClear").hidden = !items.some((t) => t.done);
  if (!items.length) { list.innerHTML = '<p class="muted center">Nothing to do. 🎉</p>'; loadTodoCount(); return; }
  const today = new Date().toISOString().slice(0, 10);
  for (const t of items) {
    const row = document.createElement("div"); row.className = "todo" + (t.done ? " done" : "");
    const late = t.due && !t.done && t.due < today;
    row.innerHTML = `<label class="tick"><input type="checkbox" ${t.done ? "checked" : ""}><span></span></label>
      <span class="todo-text">${esc(t.text)}</span>${t.due ? `<span class="todo-due${late ? " late" : ""}">${esc(fmtDue(t.due))}</span>` : ""}
      <button class="icon-btn todo-del" title="Delete">✕</button>`;
    $("input", row).addEventListener("change", async (e) => { await Bridge.call("todo_set", { id: t.id, done: e.target.checked }); loadTodos(); });
    $(".todo-del", row).addEventListener("click", async () => { await Bridge.call("todo_delete", { id: t.id }); loadTodos(); });
    list.appendChild(row);
  }
  loadTodoCount();
}
function fmtDue(d) {
  const today = new Date(); const t = today.toISOString().slice(0, 10);
  const tm = new Date(today.getTime() + 864e5).toISOString().slice(0, 10);
  if (d === t) return "Today"; if (d === tm) return "Tomorrow";
  return new Date(d + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
$("#todoForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#todoText").value.trim(); if (!text) return;
  const r = await Bridge.call("todo_add", { text, due: $("#todoDue").value });
  if (!r.ok) { toast(r.error); return; }
  $("#todoText").value = ""; $("#todoDue").value = ""; loadTodos(); $("#todoText").focus();
});
$("#todoClear").addEventListener("click", async () => { await Bridge.call("todo_clear_done"); loadTodos(); });

/* ═════════════ daily Facebook post (approval card) ═════════════ */
$("#dpWriteNow").addEventListener("click", async () => {
  const r = await Bridge.call("daily_post_write", { topics: $("#setDpTopics").value });
  if (!r.ok) { toast(r.error, 5000); return; }
  toast("Writing today's post…");
});
function showDailyPost(d) {
  showView("chat");
  const card = document.createElement("div"); card.className = "alarm dp";
  card.innerHTML = `<div class="al-icon">📣</div><div class="al-body"><div class="al-title">Today's Facebook post</div>
    <textarea class="dp-text" rows="7">${esc(d.text)}</textarea>
    <label class="dp-when"><input type="checkbox"> Schedule for <input type="datetime-local"></label>
    <div class="al-acts"><button class="btn primary" data-a="post">Post</button><button class="btn ghost" data-a="skip">Skip today</button></div></div>`;
  const when = $('input[type="datetime-local"]', card), chk = $('input[type="checkbox"]', card);
  when.addEventListener("input", () => (chk.checked = !!when.value));
  card.addEventListener("click", async (e) => {
    const a = e.target.dataset && e.target.dataset.a; if (!a) return;
    if (a === "skip") { card.remove(); return; }
    e.target.disabled = true;
    const r = await Bridge.call("daily_post_publish", { text: $(".dp-text", card).value,
      schedule_at: chk.checked && when.value ? when.value.replace("T", " ") : "" });
    if (!r.ok) { toast(r.error, 6000); e.target.disabled = false; return; }
    toast(r.data); card.remove();
  });
  $("#messages").appendChild(card); card.scrollIntoView({ behavior: "smooth", block: "end" });
}

/* ═════════════ Inbox (Facebook auto-reply) ═════════════ */
let inboxFilter = "", arMode = "draft";
function setArMode(m) { arMode = m; $$("#arMode button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m)); }
$$("#arMode button").forEach((b) => b.addEventListener("click", () => setArMode(b.dataset.mode)));
$$("#inboxFilter button").forEach((b) => b.addEventListener("click", () => {
  inboxFilter = b.dataset.f; $$("#inboxFilter button").forEach((x) => x.classList.toggle("on", x === b)); loadInbox(false);
}));
$("#inboxRefresh").addEventListener("click", () => loadInbox(true));
async function loadInbox(withSettings) {
  const note = $("#inboxNote");
  if (withSettings) {
    const r = await Bridge.call("autoreply_get"); const g = r.ok ? r.data : {};
    const problem = !g.online ? "Sign in with your email (online account) to use the Inbox."
      : !g.pro ? "Auto-reply is a Nyro Pro feature. Upgrade with a Pro code to turn it on."
      : !g.page_connected ? "First connect your Facebook Page in ⚙ Settings → Facebook Page." : "";
    note.hidden = !problem; note.textContent = problem;
    $("#arCard").hidden = !!problem;
    const c = g.config;
    setArMode(c ? c.mode : "draft");
    $("#arInfo").value = c ? c.business_info : $("#arInfo").value;
    $("#arMsg").checked = c ? c.reply_messages : true; $("#arCom").checked = c ? c.reply_comments : true;
    $("#arState").textContent = !c ? "Not set up" : c.mode === "auto" ? "● Auto" : c.mode === "draft" ? "● Draft" : "Off";
    $("#arState").className = "ar-state " + (c && c.mode !== "off" ? "on" : "");
    if (!c && !problem) $("#arCard").open = true;
    if (problem) { $("#inboxList").innerHTML = ""; return; }
  }
  const r = await Bridge.call("inbox", { filter: inboxFilter });
  const list = $("#inboxList"); list.innerHTML = "";
  const items = r.ok ? r.data : [];
  if (!r.ok) { list.innerHTML = `<p class="muted">${esc(r.error)}</p>`; return; }
  if (!items.length) { list.innerHTML = '<p class="muted center">No customer messages yet.</p>'; return; }
  const label = { replied: "Nyro replied", sent: "You replied", draft: "Draft · waiting", escalated: "Needs you", error: "Error", done: "Done", skipped: "Skipped", pending: "Working…" };
  for (const m of items) {
    const needs = ["draft", "escalated", "error"].includes(m.status);
    const el = document.createElement("div"); el.className = "ib " + m.status;
    const when = new Date(m.created_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    el.innerHTML = `<div class="ib-head"><span class="ib-ch">${m.channel === "comment" ? "🗨️ Comment" : "💬 Messenger"}</span>
        <b>${esc(m.sender_name || "Customer")}</b><span class="muted small">${esc(when)}</span><span class="grow"></span>
        <span class="ib-st">${label[m.status] || m.status}</span></div>
      <div class="ib-q">${esc(m.customer_text)}</div>
      ${m.note && m.status !== "replied" ? `<div class="ib-note">${esc(m.note)}</div>` : ""}
      ${needs ? `<textarea class="ib-edit" rows="3" placeholder="Write a reply…">${esc(m.reply_text || "")}</textarea>
        <div class="row"><button class="btn primary ib-send">Send</button><button class="btn ghost ib-done">Mark done</button></div>`
        : m.reply_text ? `<div class="ib-a"><span>↳</span>${esc(m.reply_text)}</div>` : ""}`;
    if (needs) {
      $(".ib-send", el).addEventListener("click", async (e) => {
        e.target.disabled = true;
        const s = await Bridge.call("inbox_send", { id: m.id, text: $(".ib-edit", el).value });
        if (!s.ok) { toast(s.error, 5000); e.target.disabled = false; return; }
        toast("Sent ✓"); loadInbox(false);
      });
      $(".ib-done", el).addEventListener("click", async () => { await Bridge.call("inbox_done", { id: m.id }); loadInbox(false); });
    }
    list.appendChild(el);
  }
}
$("#arSave").addEventListener("click", async () => {
  $("#arSave").disabled = true; $("#arMsgText").textContent = "";
  const r = await Bridge.call("autoreply_save", { mode: arMode, business_info: $("#arInfo").value,
    reply_messages: $("#arMsg").checked, reply_comments: $("#arCom").checked });
  if (!r.ok) { $("#arMsgText").textContent = "❌ " + r.error; $("#arSave").disabled = false; }
  else $("#arMsgText").textContent = r.data;
});

/* ═════════════ auto-update ═════════════ */
function showUpdate(u) {
  $("#updateText").textContent = `Nyro ${u.version} is ready${u.notes ? ": " + u.notes : "."}`;
  $("#updateBtn").disabled = false; $("#updateBtn").textContent = "Update now"; $("#updateBar").hidden = false;
}
$("#updateClose").addEventListener("click", () => ($("#updateBar").hidden = true));
$("#updateBtn").addEventListener("click", async () => {
  if (S.busy) { toast("Wait until Nyro finishes, then update."); return; }
  $("#updateBtn").disabled = true; $("#updateText").textContent = "Downloading the update…";
  const r = await Bridge.call("update_install");
  if (!r.ok) { $("#updateText").textContent = r.error; $("#updateBtn").disabled = false; }
});

/* ═════════════ modal (replaces the browser's confirm box) ═════════════ */
function ask(title, html, okText = "OK", danger = false, okOnly = false) {
  return new Promise((resolve) => {
    const box = $("#modalBox");
    box.innerHTML = `<h3>${esc(title)}</h3><p>${html}</p><div class="row"><span class="grow"></span>
      ${okOnly ? "" : '<button class="btn ghost" data-r="0">Cancel</button>'}<button class="btn ${danger ? "danger-solid" : "primary"}" data-r="1">${esc(okText)}</button></div>`;
    $("#modal").hidden = false;
    const done = (v) => { $("#modal").hidden = true; document.removeEventListener("keydown", key, true); resolve(v); };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } if (e.key === "Enter") { e.preventDefault(); done(true); } };
    document.addEventListener("keydown", key, true);
    box.onclick = (e) => { const b = e.target.closest("[data-r]"); if (b) done(b.dataset.r === "1"); };
    $("#modal").onclick = (e) => { if (e.target.id === "modal") done(false); };
    setTimeout(() => box.querySelector('[data-r="1"]').focus(), 30);
  });
}

/* ═════════════ reminders & alarms ═════════════ */
function showAlarm(d) {
  const card = document.createElement("div"); card.className = "alarm" + (d.missed ? " missed" : "");
  card.innerHTML = `<div class="al-icon">${d.missed ? "🔔" : "⏰"}</div><div class="al-body"><div class="al-title">${d.missed ? "Missed reminder" : "Reminder"} · ${esc(d.time)}</div>
    <div class="al-text">${esc(d.text)}</div><div class="al-acts">${d.missed ? '<button class="btn primary" data-a="ok">OK</button>'
    : '<button class="btn primary" data-a="stop">Stop</button><button class="btn ghost" data-a="snooze">Snooze 10 min</button>'}</div></div>`;
  card.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return;
    if (a === "snooze") { await Bridge.call("reminder_snooze", { id: d.id, text: d.text, minutes: 10 }); toast("I'll remind you again in 10 minutes"); }
    else if (a === "stop") Bridge.call("reminder_stop", { id: d.id });
    card.classList.add("out"); setTimeout(() => card.remove(), 250); loadReminderCount();
  });
  $("#alarms").appendChild(card);
}
async function loadReminderCount() {
  const r = await Bridge.call("reminders"); const n = r.ok ? r.data.length : 0;
  $("#remCount").hidden = !n; $("#remCount").textContent = n;
}
async function loadReminders() {
  const r = await Bridge.call("reminders"); const list = $("#remList"); list.innerHTML = "";
  const now = new Date(Date.now() + 60 * 60000); now.setSeconds(0, 0);
  if (!$("#remWhen").value) $("#remWhen").value = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  if (!r.ok || !r.data.length) { list.innerHTML = '<div class="empty">No reminders yet.</div>'; loadReminderCount(); return; }
  const rep = { none: "", daily: "Every day", weekdays: "Weekdays", weekly: "Every week" };
  for (const x of r.data) {
    const c = document.createElement("div"); c.className = "card item-card rem";
    c.innerHTML = `<div class="body"><span class="kind">⏰ ${esc(x.when)}${rep[x.repeat] ? " · " + rep[x.repeat] : ""}</span><br>${esc(x.text)}</div>
      <div class="acts"><button class="icon-btn" title="Delete">🗑</button></div>`;
    $("button", c).addEventListener("click", async () => {
      if (await ask("Delete this reminder?", esc(x.text), "Delete", true)) { await Bridge.call("reminder_delete", { id: x.id }); loadReminders(); }
    });
    list.appendChild(c);
  }
  loadReminderCount();
}
$("#remForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await Bridge.call("reminder_add", { text: $("#remText").value, when: $("#remWhen").value, repeat: $("#remRepeat").value });
  if (!r.ok) { toast(r.error); return; }
  $("#remText").value = ""; toast("Reminder added ✓"); loadReminders();
});

/* ═════════════ browser preview (no Python): fake answers, for design testing only ═════════════ */
const MockBridge = {
  emit: null, msgs: {}, notes: [{ id: "n1", content: "Doctor's appointment tomorrow at 10 am", updated_at: new Date().toISOString() }],
  chats: [{ id: "c1", title: "Trip plan for Cox's Bazar", updated_at: new Date().toISOString(), pinned: 1 },
          { id: "c2", title: "hello", updated_at: new Date().toISOString(), pinned: 0 }],
  rems: [{ id: "r1", text: "ঔষধ খাওয়ার সময়", when: "Sat 07 Nov, 05:00 PM", repeat: "daily" }],
  acct: null, mic: false,
  pushed: { connect() {} },
  call(method, argsJson, cb) {
    const a = JSON.parse(argsJson || "{}"); const ok = (data) => cb(JSON.stringify({ ok: true, data })); const e = (m) => cb(JSON.stringify({ ok: false, error: m }));
    const models = { vision: { label: "Vision 1.1", note: "Free for All" }, swift: { label: "Swift 1.1", note: "Fast Response" },
      core: { label: "Core 1.1", note: "High Thinking" }, pro: { label: "Pro 1.1", note: "More High Thinking & More Fast Response" },
      zylos: { label: "Zylos-Gen 1.1", note: "Create Photo" } };
    const tier = (location.hash.match(/tier=(\w+)/) || [])[1] || "pro";
    const acc = (t) => ({ name: t === "guest" ? "Guest" : t === "free" ? "MK_Rohit" : "MK_Ashborn_22", tier: t,
      models: t === "guest" ? ["vision"] : t === "free" ? ["vision", "swift", "core", "zylos"] : ["vision", "swift", "core", "pro", "zylos"] });
    const q = { guest: [], free: ["720p", "1080p"], pro: ["2K", "4K"] };
    const pack = () => ({ account: this.acct, settings: { model_tier: "swift", chat_mode: "task", image_aspect: "1:1", theme: (location.hash.match(/theme=(\w+)/) || [])[1] || "dark" }, models,
      image_qualities: q[this.acct.tier], aspects: ["1:1", "16:9", "9:16", "4:3", "3:4"], has_ai_key: true, status: "idle", version: "1.0.2",
      online: true, update: location.hash.includes("update") ? { version: "1.0.3", notes: "Faster replies" } : null });
    switch (method) {
      case "init": return ok(location.hash.includes("login") ? { account: null } : (this.acct = acc(tier), pack()));
      case "login": return a.name ? (this.acct = acc("pro"), ok(pack())) : e("Wrong name or password.");
      case "signup": return (this.acct = acc("free"), ok(pack()));
      case "guest": return (this.acct = acc("guest"), ok(pack()));
      case "chats": return ok(this.chats);
      case "open_chat": return ok(this.msgs[a.id] || [{ role: "user", content: "make a sunset photo", created_at: new Date().toISOString() },
        { role: "assistant", content: "[[image:C:\\Users\\you\\Pictures\\NYRO Images\\Zylos 2026-11-07 10-00-00.png]]", created_at: new Date().toISOString() }]);
      case "image": return ok({ url: "assets/voice_core.jpg", width: 1080, height: 1080, name: a.path.split("\\").pop() });
      case "reminders": return ok(this.rems);
      case "pin_chat": { const c = this.chats.find((x) => x.id === a.id); if (c) c.pinned = a.pinned ? 1 : 0; return ok(true); }
      case "rename_chat": { const c = this.chats.find((x) => x.id === a.id); if (c) c.title = a.title; return ok(true); }
      case "delete_chat": this.chats = this.chats.filter((x) => x.id !== a.id); return ok(true);
      case "export_chat": return ok({ saved: true, path: "C:\\Users\\you\\Documents\\chat." + a.format });
      case "send": {
        ok({ accepted: true });
        const id = this.cur || (this.cur = "c" + Date.now(), this.chats.unshift({ id: this.cur, title: a.text.slice(0, 40), updated_at: new Date().toISOString(), pinned: 0 }), this.cur);
        setTimeout(() => this.emit("user_message", { conversation_id: id, text: a.text, files: (a.attachments || []).map((x) => x.name) }), 10);
        setTimeout(() => this.emit("status", { status: "thinking" }), 30);
        if (a.model === "zylos") {
          setTimeout(() => this.emit("image", { conversation_id: id, path: "C:\\Users\\you\\Pictures\\NYRO Images\\Zylos new.png" }), 600);
          setTimeout(() => { this.emit("done", { conversation_id: id, text: "" }); this.emit("status", { status: "idle" }); }, 700);
          return;
        }
        const answer = /chrome/i.test(a.text) ? "OK, **Chrome** is open. ✅" :
          "Sure! A few points:\n\n- **First:** answers appear while they are written\n- **Second:** code looks clean\n\n```python\nprint('Hello, Nyro!')\n```\nAnything else?";
        if (/chrome/i.test(a.text)) setTimeout(() => this.emit("tool", { name: "open_app" }), 300);
        let i = 0; const step = () => { if (i >= answer.length) { this.emit("done", { conversation_id: id, text: answer }); this.emit("status", { status: "idle" }); this.emit("chats_changed", {}); return; }
          this.emit("delta", { text: answer.slice(i, i + 6) }); i += 6; setTimeout(step, 30); };
        setTimeout(step, 500); return;
      }
      case "new_chat": this.cur = null; return ok(true);
      case "logout": this.acct = null; return ok(true);
      case "redeem": return /^NYRO-/i.test(a.code || "") ? (this.acct = acc("pro"), ok({ ...pack(), pro_until: new Date(Date.now() + 30 * 864e5).toISOString() })) : e("This code is not valid. Check it and try again.");
      case "import_local": return ok({ imported: 42 });
      case "autoreply_get": return ok({ online: true, pro: true, page_connected: true, webhook_url: "https://x.supabase.co/functions/v1/nyro-meta-webhook",
        config: { mode: "auto", business_info: "Nyro Fashion: T-shirts 450 Tk…", reply_messages: true, reply_comments: true } });
      case "autoreply_save": setTimeout(() => this.emit("autoreply", { text: "✅ Auto-reply is ON: Nyro answers customers by itself." }), 400); return ok("Saving…");
      case "inbox": return ok([
        { id: 3, channel: "messenger", sender_name: "", customer_text: "ভাই, আমার অর্ডার এখনো আসেনি, টাকা ফেরত চাই", reply_text: "দুঃখিত! আমাদের টিম এখনই আপনার অর্ডারটা দেখে জানাবে।", status: "escalated", note: "Refund request", created_at: new Date().toISOString() },
        { id: 2, channel: "comment", sender_name: "Rahim Uddin", customer_text: "price koto?", reply_text: "T-shirt 450 টাকা 😊 অর্ডার করতে পেজে মেসেজ দিন!", status: "replied", created_at: new Date(Date.now() - 36e5).toISOString() },
        { id: 1, channel: "messenger", sender_name: "", customer_text: "Do you deliver to Sylhet?", reply_text: "Yes! Delivery to Sylhet takes 2–3 days, charge 120 Tk.", status: "draft", created_at: new Date(Date.now() - 72e5).toISOString() }]);
      case "inbox_send": case "inbox_done": return ok(true);
      case "daily_post_write": setTimeout(() => this.emit("daily_post", { text: "🚀 আজকের টিপ: Nyro-কে বলুন “আজকের to-do দেখাও”…\n\n#NYRO #AI" }), 500); return ok("Writing…");
      case "daily_post_publish": return ok(a.schedule_at ? "Scheduled ✓" : "Posted on your Page ✓");
      case "todos": return ok(this.todos || (this.todos = [{ id: "t1", text: "Buy milk", done: 0, due: new Date().toISOString().slice(0, 10) },
        { id: "t2", text: "Send the report to Rahim", done: 0, due: "2026-11-01" }, { id: "t3", text: "Call mom", done: 1, due: null }]));
      case "todo_add": this.todos.unshift({ id: "t" + Date.now(), text: a.text, done: 0, due: a.due || null }); return ok("x");
      case "todo_set": { const t = this.todos.find((x) => x.id === a.id); if (t) t.done = a.done ? 1 : 0; return ok(true); }
      case "todo_delete": this.todos = this.todos.filter((x) => x.id !== a.id); return ok(true);
      case "todo_clear_done": this.todos = this.todos.filter((x) => !x.done); return ok(true);
      case "search_chats": return ok(this.chats.map((c) => ({ ...c, snippet: "…we talked about " + a.q + " here…" })));
      case "notes": return ok(this.notes);
      case "note_save": this.notes.unshift({ id: "n" + Date.now(), content: a.text, updated_at: new Date().toISOString() }); return ok(true);
      case "memory": return ok([{ id: "m1", kind: "contact", content: "Rahim: rahim@gmail.com" }, { id: "m2", kind: "preference", content: "Reply in Bangla" }]);
      case "activity": return ok([{ time: "20:31:05", icon: "✅", text: "open_app – Opened Chrome." }]);
      case "settings_get": return ok({ speech_language: "auto", start_with_windows: true, version: "1.0.2", online: true, pro_until: "", voice_enabled: true, wake_word_enabled: true, f8_enabled: true, stt_model: "small", speech_rms: 0.015, confirm_timeout_s: 20, ai_provider: "gemini", has_gemini_key: true, gmail: "Not connected" });
      case "voice": setTimeout(() => this.emit("voice", { voice_mode: a.on, mic: this.mic }), 5); return ok(true);
      case "mic": this.mic = a.on; setTimeout(() => { this.emit("voice", { voice_mode: true, mic: a.on }); this.emit("status", { status: a.on ? "listening" : "idle" }); }, 5);
        clearInterval(this._lv); if (a.on) this._lv = setInterval(() => this.emit("levels", { mic: Math.random() * 0.6, speak: 0 }), 80); return ok(true);
      default: return ok(true);
    }
  },
};

/* ═════════════ start ═════════════ */
Bridge.init().then(async () => {
  const r = await Bridge.call("init");
  if (r.ok && r.data.account) enterApp(r.data); else showLogin();
});
