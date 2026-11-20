/* PWA: service worker registration, install prompt, update + offline banners */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // ---- Service worker + updates
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        const showUpdate = (worker) => {
          $("#update-bar").classList.remove("hidden");
          $("#update-btn").onclick = () => worker.postMessage("skipWaiting");
        };
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          nw && nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdate(nw);
          });
        });
        // check for a new version every 30 minutes while open
        setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      } catch (e) { console.warn("SW registration failed", e); }
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return; reloading = true; location.reload();
    });
  }

  // ---- Install button
  const btn = $("#install-btn");
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    if (!standalone) btn.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => { deferred = null; btn.classList.add("hidden"); });

  // iOS Safari has no install prompt: show the button with instructions instead
  if (isIOS && !standalone) btn.classList.remove("hidden");

  btn.addEventListener("click", async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      btn.classList.add("hidden");
      return;
    }
    const modal = $("#modal"), back = $("#modal-backdrop");
    modal.innerHTML = `
      <div class="drawer-h"><h3>Install Delivery Tracker</h3></div>
      <div class="drawer-b" style="line-height:1.6">
        ${isIOS
          ? `1. Tap the <strong>Share</strong> button in Safari's toolbar.<br>2. Choose <strong>Add to Home Screen</strong>.<br>3. Tap <strong>Add</strong>.`
          : `Use your browser's menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.`}
      </div>
      <div class="drawer-f"><button class="btn btn-primary" id="pwa-ok">OK</button></div>`;
    modal.classList.remove("hidden"); back.classList.remove("hidden");
    $("#pwa-ok").onclick = () => { modal.classList.add("hidden"); back.classList.add("hidden"); modal.innerHTML = ""; };
  });

  // ---- Offline banner
  const setOnline = () => {
    const off = !navigator.onLine;
    document.body.classList.toggle("offline", off);
    $("#offline-bar").classList.toggle("hidden", !off);
  };
  window.addEventListener("online", setOnline);
  window.addEventListener("offline", setOnline);
  setOnline();
})();
