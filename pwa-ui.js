/* NYRO web app: small UI changes for phones, loaded after app.js. */
"use strict";
(() => {
  const small = () => matchMedia("(max-width: 760px)").matches;
  const app = document.getElementById("app");

  /* sidebar slides over the chat on phones; tap outside to close */
  const scrim = document.createElement("div"); scrim.id = "sbScrim"; app.prepend(scrim);
  const closeSb = () => { if (!small()) return; app.classList.add("sb-closed"); document.getElementById("sbOpen").hidden = false; };
  scrim.addEventListener("click", closeSb);
  if (small()) closeSb();
  document.addEventListener("click", (e) => {
    if (!small() || app.classList.contains("sb-closed")) return;
    const hit = e.target.closest("#sidebar .nav-item, #sidebar .chat-item, #sidebar [data-view='settings']");
    if (hit && !e.target.closest(".dots") && !e.target.closest(".rename")) setTimeout(closeSb, 60);
  });

  /* links and photos open in a new tab right away (a phone blocks windows opened later) */
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-ext]");
    if (a) { e.stopImmediatePropagation(); e.preventDefault(); window.open(a.href, "_blank", "noopener"); return; }
    const ph = e.target.closest("[data-photo]");
    if (ph && /^https?:\/\//.test(ph.dataset.photo || "")) { e.stopImmediatePropagation(); if (ph.dataset.folder !== "1") window.open(ph.dataset.photo, "_blank", "noopener"); }
  }, true);

  /* Settings: show the Facebook Page that the laptop already connected; ask for notifications for reminders */
  const origLoad = window.loadSettings;
  if (typeof origLoad === "function") {
    window.loadSettings = async function () {
      await origLoad.apply(this, arguments);
      const st = await Bridge.call("meta_status");
      if (st.ok && st.data) {
        if (st.data.text) document.getElementById("metaStatus").textContent = st.data.text;
        if (st.data.page_id) document.getElementById("setPageId").value = st.data.page_id;
      }
      const s = await Bridge.call("settings_get");
      const box = document.getElementById("webNotify");
      if (box && s.ok) {
        const p = s.data.notify;
        box.querySelector("span").textContent = p === "granted" ? "Notifications are on ✓" : p === "denied" ? "Notifications are blocked in the phone's settings." :
          p === "unsupported" ? "Add Nyro to your Home Screen to get notifications." : "Get reminder and Inbox notifications";
        box.querySelector("button").hidden = p !== "default";
      }
    };
  }
  document.getElementById("webNotifyBtn")?.addEventListener("click", async () => {
    const r = await Bridge.call("notify_ask"); if (r.ok) window.loadSettings();
  });

  /* "Add to Home Screen" tip on the welcome screen (once, until closed) */
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let closed = false; try { closed = !!localStorage.getItem("nyro-install-tip"); } catch {}
  if (!standalone && !closed) {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const tip = document.createElement("div"); tip.className = "install-tip";
    tip.innerHTML = ios ? "<span>📲 <b>Install Nyro:</b> tap <b>Share</b> <span aria-hidden='true'>⬆︎</span> → <b>Add to Home Screen</b>. Then open Nyro from its icon.</span><button title='Close'>×</button>"
      : "<span>📲 <b>Install Nyro:</b> open the browser menu <b>⋮</b> → <b>Install app</b> (or <b>Add to Home screen</b>).</span><button title='Close'>×</button>";
    tip.querySelector("button").addEventListener("click", () => { tip.remove(); try { localStorage.setItem("nyro-install-tip", "1"); } catch {} });
    document.getElementById("welcome")?.appendChild(tip);
  }

  /* service worker: works offline-first for the app files (never for your data) */
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
