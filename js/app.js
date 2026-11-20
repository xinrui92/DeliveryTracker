/* Delivery Tracker — single-page app (vanilla JS + Supabase) */
(() => {
  "use strict";

  const CFG = window.APP_CONFIG;
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---------------------------------------------------------------- state
  const S = {
    session: null,
    me: null,               // my profile row
    settings: null,
    deliveries: [],         // rows from delivery_metrics
    profiles: [],
    alerts: [],             // open alerts
    dismissed: new Set(),   // alert ids I dismissed
    route: "dashboard",
    filters: { q: "", view: "open", status: "", client: "", sort: "commitment_date", dir: 1 },
    tlRange: "quarter",
    alertTab: "open",
    channel: null,
    loaded: false,
  };

  // ---------------------------------------------------------------- constants
  const HEALTH = {
    on_track: "On track", tight: "Tight buffer", at_risk: "At risk", overdue: "Overdue",
    on_time: "Delivered on time", late: "Delivered late", cancelled: "Cancelled",
  };
  const HEALTH_COLOR = {
    on_track: "#1f8a5b", tight: "#d9a032", at_risk: "#e07b39", overdue: "#c8372d",
    on_time: "#7cc5a1", late: "#e89a93", cancelled: "#c4c9d2",
  };
  const STATUS = {
    planned: "Planned", in_production: "In production", ready_to_ship: "Ready to ship",
    shipped: "Shipped", delivered: "Delivered", on_hold: "On hold", cancelled: "Cancelled",
  };
  const SHIP_MODES = { sea: "Sea", air: "Air", road: "Road", courier: "Courier", other: "Other" };
  const ALERT_TYPES = {
    commitment_overdue: "Commitment date passed",
    late_forecast: "Forecast later than commitment",
    tight_buffer: "Tight buffer",
    due_soon: "Commitment due soon",
    production_overdue: "Production overdue",
    production_after_ship: "Production finishes after planned shipment",
    shipment_overdue: "Shipment overdue",
  };
  const ROLE_LABEL = { admin: "Admin", editor: "Editor", viewer: "Viewer" };
  const FIELD_LABEL = {
    commitment_date: "Commitment date", production_start: "Production start", production_due: "Production due",
    production_done: "Production done", ship_planned: "Planned ship", ship_actual: "Actual ship",
    eta: "ETA", delivered_date: "Delivered", status: "Status",
  };

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const todayStr = () => new Intl.DateTimeFormat("en-CA", { timeZone: CFG.TIMEZONE }).format(new Date());
  const toUTC = (d) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd); };
  const diffDays = (a, b) => (a && b ? Math.round((toUTC(a) - toUTC(b)) / 86400000) : null); // a - b
  const addDays = (d, n) => { const t = new Date(toUTC(d) + n * 86400000); return t.toISOString().slice(0, 10); };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = (d, withYear = true) => {
    if (!d) return "—";
    const [y, m, dd] = d.slice(0, 10).split("-");
    return `${Number(dd)} ${MONTHS[Number(m) - 1]}${withYear ? " " + y.slice(2) : ""}`;
  };
  const fmtDateTime = (ts) => {
    if (!ts) return "—";
    return new Intl.DateTimeFormat("en-SG", { timeZone: CFG.TIMEZONE, day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
  };
  const relTime = (ts) => {
    const s = (Date.now() - new Date(ts).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  // variance: positive = late (bad)
  const fmtVar = (n) => {
    if (n === null || n === undefined) return '<span class="muted">—</span>';
    if (n === 0) return '<span class="var zero">on time</span>';
    return n > 0 ? `<span class="var pos">+${n}d late</span>` : `<span class="var neg">${-n}d early</span>`;
  };
  // buffer: positive = days to spare (good)
  const fmtBuffer = (n) => {
    if (n === null || n === undefined) return '<span class="muted">—</span>';
    if (n === 0) return '<span class="var zero">0d</span>';
    return n > 0 ? `<span class="var neg">+${n}d</span>` : `<span class="var pos">${n}d</span>`;
  };
  const healthBadge = (h) => `<span class="badge h-${esc(h)}">${esc(HEALTH[h] || h)}</span>`;
  const sevBadge = (s) => `<span class="badge s-${esc(s)}">${esc(s[0].toUpperCase() + s.slice(1))}</span>`;
  const initials = (name) => (name || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join("");
  const isAdmin = () => S.me?.role === "admin";
  const canEdit = () => ["admin", "editor"].includes(S.me?.role);
  const profileName = (id) => { const p = S.profiles.find((x) => x.id === id); return p ? p.full_name || p.email : ""; };
  const isOpen = (d) => !d.delivered_date && d.status !== "cancelled";

  const SNAP_KEY = "dt-snapshot";
  const saveSnap = () => { try { localStorage.setItem(SNAP_KEY, JSON.stringify({ uid: S.me.id, at: Date.now(), me: S.me, deliveries: S.deliveries, profiles: S.profiles, settings: S.settings, alerts: S.alerts, dismissed: [...S.dismissed] })); } catch (_) {} };
  const readSnap = (uid) => { try { const j = JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); return j && j.uid === uid ? j : null; } catch (_) { return null; } };
  const clearSnap = () => { try { localStorage.removeItem(SNAP_KEY); } catch (_) {} };

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "error" ? 6000 : 3500);
  }

  function openModal(html, onMount) {
    $("#modal").innerHTML = html;
    $("#modal").classList.remove("hidden");
    $("#modal-backdrop").classList.remove("hidden");
    $$("[data-close-modal]", $("#modal")).forEach((b) => b.addEventListener("click", closeModal));
    onMount && onMount($("#modal"));
    const first = $("input, select, textarea", $("#modal")); first && first.focus();
  }
  function closeModal() { $("#modal").classList.add("hidden"); $("#modal-backdrop").classList.add("hidden"); $("#modal").innerHTML = ""; }
  function openDrawer(html) {
    $("#drawer").innerHTML = html;
    $("#drawer").classList.remove("hidden");
    $("#drawer-backdrop").classList.remove("hidden");
    $("#drawer").scrollTop = 0;
  }
  function closeDrawer() { $("#drawer").classList.add("hidden"); $("#drawer-backdrop").classList.add("hidden"); $("#drawer").innerHTML = ""; }

  function confirmBox(title, text, okLabel = "Confirm", danger = false) {
    return new Promise((resolve) => {
      openModal(`
        <div class="drawer-h"><h3>${esc(title)}</h3></div>
        <div class="drawer-b"><p style="margin:0">${esc(text)}</p></div>
        <div class="drawer-f"><button class="btn" data-no>Cancel</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes>${esc(okLabel)}</button></div>`,
        (m) => {
          $("[data-no]", m).onclick = () => { closeModal(); resolve(false); };
          $("[data-yes]", m).onclick = () => { closeModal(); resolve(true); };
        });
    });
  }

  // ---------------------------------------------------------------- auth UI
  function showScreen(name) {
    $("#auth-screen").classList.toggle("hidden", name !== "auth");
    $("#pending-screen").classList.toggle("hidden", name !== "pending");
    $("#app").classList.toggle("hidden", name !== "app");
  }
  function authForm(which) {
    ["login", "signup", "forgot", "newpass"].forEach((f) => $(`#${f}-form`).classList.toggle("hidden", f !== which));
    authMsg("");
  }
  function authMsg(text, error = false) {
    const el = $("#auth-msg");
    el.textContent = text;
    el.classList.toggle("hidden", !text);
    el.classList.toggle("error", error);
  }

  $$("[data-auth]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); authForm(a.dataset.auth); }));

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $("button[type=submit]", e.target); btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    btn.disabled = false;
    if (error) authMsg(error.message.includes("banned") ? "This account has been deactivated. Contact an admin." : error.message, true);
  });

  $("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $("button[type=submit]", e.target); btn.disabled = true;
    const { data, error } = await sb.auth.signUp({
      email: f.get("email").trim(), password: f.get("password"),
      options: { data: { full_name: f.get("full_name").trim() }, emailRedirectTo: location.origin },
    });
    btn.disabled = false;
    if (error) return authMsg(error.message, true);
    if (!data.session) authMsg("Check your email to confirm your address. An admin will then approve your account.");
  });

  $("#forgot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = new FormData(e.target).get("email").trim();
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
    if (error) return authMsg(error.message, true);
    authMsg("If that email has an account, a reset link is on its way.");
  });

  $("#newpass-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get("password") });
    if (error) return authMsg(error.message, true);
    toast("Password updated");
    history.replaceState(null, "", location.pathname + "#/dashboard");
    start();
  });

  document.addEventListener("click", (e) => {
    const lo = e.target.closest("[data-action=logout]");
    if (lo) { e.preventDefault(); logout(); }
    if (!e.target.closest(".me")) $("#me-menu").classList.add("hidden");
  });
  $("#me-btn").addEventListener("click", () => $("#me-menu").classList.toggle("hidden"));
  $("#pending-refresh").addEventListener("click", start);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  $("#modal-backdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#modal").classList.contains("hidden")) closeModal(); else closeDrawer();
  });

  async function logout() {
    if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
    clearSnap();
    await sb.auth.signOut();
    S.me = null; S.loaded = false;
    closeDrawer(); closeModal();
    authForm("login"); showScreen("auth");
  }

  // ---------------------------------------------------------------- boot
  let recovering = false;
  sb.auth.onAuthStateChange((event, session) => {
    S.session = session;
    if (event === "PASSWORD_RECOVERY") { recovering = true; showScreen("auth"); authForm("newpass"); return; }
    if (event === "SIGNED_IN" && !recovering && !S.loaded) start();
    if (event === "SIGNED_OUT") { showScreen("auth"); authForm("login"); }
  });

  let starting = false;
  async function start() {
    if (starting) return; starting = true;
    try {
      const { data: { session } } = await sb.auth.getSession();
      S.session = session;
      if (!session) { showScreen("auth"); authForm("login"); return; }
      let { data: me, error } = await sb.from("profiles").select("*").eq("id", session.user.id).single();
      if ((error || !me) && !navigator.onLine) { const snap = readSnap(session.user.id); if (snap) { me = snap.me; error = null; } }
      if (error || !me) { showScreen("auth"); authMsg("Could not load your profile. " + (error?.message || ""), true); return; }
      S.me = me;
      if (!me.is_active) { $("#pending-email").textContent = me.email; showScreen("pending"); return; }
      sb.from("profiles").update({ last_seen_at: new Date().toISOString() }).eq("id", me.id).then(() => {});
      showScreen("app");
      renderMe();
      await loadAll();
      subscribe();
      S.loaded = true;
      route();
    } finally { starting = false; }
  }

  function renderMe() {
    $("#me-name").textContent = S.me.full_name || S.me.email;
    $("#me-role").textContent = ROLE_LABEL[S.me.role];
    $("#me-avatar").textContent = initials(S.me.full_name || S.me.email);
    $$(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin()));
  }

  async function loadAll() {
    const [d, p, s, a, x] = await Promise.all([
      sb.from("delivery_metrics").select("*").order("commitment_date"),
      sb.from("profiles").select("id,email,full_name,role,is_active"),
      sb.from("settings").select("*").eq("id", 1).single(),
      sb.from("alerts").select("*").is("resolved_at", null).order("created_at", { ascending: false }),
      sb.from("alert_dismissals").select("alert_id").eq("user_id", S.me.id),
    ]);
    const err = [d, p, s, a, x].find((r) => r.error);
    if (err) {
      const snap = readSnap(S.me.id);
      if (snap) {
        Object.assign(S, { deliveries: snap.deliveries, profiles: snap.profiles, settings: snap.settings, alerts: snap.alerts, dismissed: new Set(snap.dismissed) });
        updateBadges();
        toast(`Offline: showing data from ${fmtDateTime(snap.at)}`, "warn");
        return;
      }
      toast("Load error: " + err.error.message, "error");
    }
    S.deliveries = d.data || [];
    S.profiles = p.data || [];
    S.settings = s.data || { due_soon_days: 7, min_buffer_days: 3, default_transit_days: 7 };
    S.alerts = a.data || [];
    S.dismissed = new Set((x.data || []).map((r) => r.alert_id));
    updateBadges();
    if (!err) saveSnap();
  }

  function updateBadges() {
    const n = S.alerts.filter((a) => !S.dismissed.has(a.id)).length;
    const el = $("#nav-alert-count");
    el.textContent = n; el.classList.toggle("hidden", !n);
    const pending = S.profiles.filter((p) => !p.is_active).length;
    const pe = $("#nav-pending-count");
    pe.textContent = pending; pe.classList.toggle("hidden", !(isAdmin() && pending));
  }

  let reloadTimer = null;
  function subscribe() {
    if (S.channel) sb.removeChannel(S.channel);
    S.channel = sb.channel("dt-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "deliveries" }, scheduleReload)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alerts" }, (payload) => {
        const a = payload.new;
        if (a && a.severity === "critical") toast("⚠ " + a.message, "warn");
        scheduleReload();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "alerts" }, scheduleReload)
      .subscribe();
  }
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      await loadAll();
      if (["dashboard", "deliveries", "timeline", "alerts"].includes(S.route)) render(false);
    }, 600);
  }

  // ---------------------------------------------------------------- router
  window.addEventListener("online", () => { if (S.loaded) scheduleReload(); else start(); });
  window.addEventListener("hashchange", route);
  function route() {
    if (!S.loaded) return;
    const r = (location.hash.replace(/^#\/?/, "").split("?")[0]) || "dashboard";
    const allowed = ["dashboard", "deliveries", "timeline", "alerts", "account"].concat(isAdmin() ? ["users", "settings"] : []);
    S.route = allowed.includes(r) ? r : "dashboard";
    $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === S.route));
    render(true);
  }
  function setHeader(title, sub = "", actions = "") {
    $("#page-title").textContent = title;
    $("#page-sub").innerHTML = sub;
    $("#page-actions").innerHTML = actions;
  }
  function render(scrollTop) {
    const v = $("#view");
    ({ dashboard: viewDashboard, deliveries: viewDeliveries, timeline: viewTimeline, alerts: viewAlerts,
       users: viewUsers, settings: viewSettings, account: viewAccount })[S.route](v);
    if (scrollTop) window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- filtering
  function filtered() {
    const f = S.filters;
    const q = f.q.trim().toLowerCase();
    let rows = S.deliveries.filter((d) => {
      if (f.view === "open" && !isOpen(d)) return false;
      if (f.view === "risk" && !["overdue", "at_risk", "tight"].includes(d.health)) return false;
      if (f.view === "delivered" && !d.delivered_date) return false;
      if (f.status && d.status !== f.status) return false;
      if (f.client && d.client !== f.client) return false;
      if (q && ![d.ref_no, d.client, d.project, d.description, d.notes].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    const k = f.sort, dir = f.dir;
    rows.sort((a, b) => {
      const va = a[k], vb = b[k];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      return (va > vb ? 1 : -1) * dir;
    });
    return rows;
  }

  // ---------------------------------------------------------------- dashboard
  function viewDashboard(v) {
    const t = todayStr();
    const all = S.deliveries;
    const open = all.filter(isOpen);
    const count = (h) => open.filter((d) => d.health === h).length;
    const since = addDays(t, -180);
    const delivered = all.filter((d) => d.delivered_date && d.delivered_date >= since);
    const onTime = delivered.filter((d) => d.health === "on_time").length;
    const rate = delivered.length ? Math.round((onTime / delivered.length) * 100) : null;

    setHeader("Dashboard", `Today is ${fmtDate(t)} · ${open.length} open deliveries`,
      canEdit() ? `<button class="btn btn-accent" id="dash-new">+ New delivery</button>` : "");
    $("#dash-new")?.addEventListener("click", () => openDelivery(null));

    const kpi = (label, value, sub, color, view) => `
      <div class="card kpi ${view ? "clickable" : ""}" ${view ? `data-goto="${view}"` : ""}>
        <div class="label">${label}</div><div class="value" ${color ? `style="color:${color}"` : ""}>${value}</div>
        <div class="sub">${sub}</div>
      </div>`;

    // lead time averages
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, x) => s + x, 0) / arr.length) : null);
    const withData = all.filter((d) => d.status !== "cancelled");
    const prodDays = avg(withData.map((d) => d.production_days_actual).filter((x) => x !== null && x >= 0));
    const waitDays = avg(withData.filter((d) => (d.ship_actual || d.ship_planned) && (d.production_done || d.production_due))
      .map((d) => diffDays(d.ship_actual || d.ship_planned, d.production_done || d.production_due)).filter((x) => x >= 0));
    const transit = avg(withData.map((d) => d.transit_days).filter((x) => x !== null && x >= 0));
    const window_ = avg(withData.filter((d) => d.production_start).map((d) => diffDays(d.commitment_date, d.production_start)));
    const buffer = avg(open.map((d) => d.buffer_days).filter((x) => x !== null));
    const prodVar = avg(all.map((d) => d.production_variance_days).filter((x) => x !== null));
    const shipVar = avg(all.map((d) => d.shipment_variance_days).filter((x) => x !== null));

    const attention = open.filter((d) => ["overdue", "at_risk", "tight"].includes(d.health))
      .sort((a, b) => (a.buffer_days ?? 0) - (b.buffer_days ?? 0)).slice(0, 8);

    // weekly upcoming commitments (next 8 weeks)
    const weeks = [];
    for (let i = 0; i < 8; i++) {
      const from = addDays(t, i * 7), to = addDays(t, i * 7 + 6);
      const ds = open.filter((d) => d.commitment_date >= from && d.commitment_date <= to);
      weeks.push({ from, ds });
    }
    const maxW = Math.max(1, ...weeks.map((w) => w.ds.length));

    const leadTotal = (prodDays || 0) + (waitDays || 0) + (transit || 0) + Math.max(buffer || 0, 0);
    const seg = (n, color, label) => n ? `<span style="width:${(n / leadTotal) * 100}%;background:${color}" title="${label}: ${n} days">${n}d</span>` : "";

    v.innerHTML = `
      <div class="grid grid-kpi">
        ${kpi("Open deliveries", open.length, `${all.length} total tracked`, "", "open")}
        ${kpi("On track", count("on_track"), `≥ ${S.settings.min_buffer_days} days buffer`, HEALTH_COLOR.on_track, "open")}
        ${kpi("Tight buffer", count("tight"), `< ${S.settings.min_buffer_days} days buffer`, HEALTH_COLOR.tight, "risk")}
        ${kpi("At risk", count("at_risk"), "Forecast after commitment", HEALTH_COLOR.at_risk, "risk")}
        ${kpi("Overdue", count("overdue"), "Commitment date passed", HEALTH_COLOR.overdue, "risk")}
        ${kpi("On-time rate", rate === null ? "—" : rate + "%", `${onTime} of ${delivered.length} delivered (6 months)`, "", "delivered")}
      </div>

      <div class="grid grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-h"><h3>Needs attention</h3><a href="#/deliveries" data-goto="risk">View all at-risk</a></div>
          ${attention.length ? `<div class="table-wrap"><table>
            <thead><tr><th>Delivery</th><th>Commitment</th><th>Forecast</th><th class="num">Buffer</th><th>Health</th></tr></thead>
            <tbody>${attention.map((d) => `
              <tr class="clickable" data-id="${d.id}">
                <td><strong>${esc(d.ref_no)}</strong><div class="sub">${esc(d.client)}${d.project ? " · " + esc(d.project) : ""}</div></td>
                <td>${fmtDate(d.commitment_date)}</td>
                <td>${fmtDate(d.forecast_delivery)}</td>
                <td class="num">${fmtBuffer(d.buffer_days)}</td>
                <td>${healthBadge(d.health)}</td>
              </tr>`).join("")}</tbody></table></div>`
            : `<div class="empty">Nothing at risk right now.</div>`}
        </div>

        <div class="card">
          <div class="card-h"><h3>Commitment vs production vs shipment</h3><span class="muted" style="font-size:12px">averages</span></div>
          <div class="card-b leadcmp">
            <div class="row">
              <div class="top"><span>Typical delivery window</span><strong>${window_ ?? "—"} days</strong></div>
              <div class="track">
                ${seg(prodDays, "var(--prod)", "Production")}
                ${seg(waitDays, "#a3abba", "Wait before shipping")}
                ${seg(transit, "var(--ship)", "Transit")}
                ${seg(Math.max(buffer || 0, 0), "var(--green)", "Buffer to commitment")}
              </div>
              <div class="legend" style="margin-top:8px">
                <span><i style="background:var(--prod)"></i>Production ${prodDays ?? "—"}d</span>
                <span><i style="background:#a3abba"></i>Wait to ship ${waitDays ?? "—"}d</span>
                <span><i style="background:var(--ship)"></i>Transit ${transit ?? "—"}d</span>
                <span><i style="background:var(--green)"></i>Buffer ${buffer ?? "—"}d</span>
              </div>
            </div>
            <div class="summary-strip" style="grid-template-columns:1fr 1fr;margin:0">
              <div><div class="label">Production vs plan</div><div class="value">${fmtVar(prodVar)}</div></div>
              <div><div class="label">Shipment vs plan</div><div class="value">${fmtVar(shipVar)}</div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-h"><h3>Upcoming client commitments · next 8 weeks</h3>
          <div class="legend">${["on_track", "tight", "at_risk"].map((h) => `<span><i style="background:${HEALTH_COLOR[h]}"></i>${HEALTH[h]}</span>`).join("")}</div>
        </div>
        <div class="card-b">
          ${weeks.map((w) => `
            <div class="hbar">
              <span>Week of ${fmtDate(w.from, false)}</span>
              <div class="track" style="width:${Math.max(4, (w.ds.length / maxW) * 100)}%">
                ${["on_track", "tight", "at_risk", "overdue"].map((h) => { const n = w.ds.filter((d) => d.health === h).length; return n ? `<span style="flex:${n};background:${HEALTH_COLOR[h]}" title="${HEALTH[h]}: ${n}"></span>` : ""; }).join("")}
              </div>
              <span class="n">${w.ds.length}</span>
            </div>`).join("")}
        </div>
      </div>`;

    $$("[data-goto]", v).forEach((el) => el.addEventListener("click", (e) => {
      e.preventDefault(); S.filters.view = el.dataset.goto; location.hash = "#/deliveries";
    }));
    $$("tr[data-id]", v).forEach((tr) => tr.addEventListener("click", () => openDelivery(tr.dataset.id)));
  }

  // ---------------------------------------------------------------- deliveries list
  function viewDeliveries(v) {
    setHeader("Deliveries", "Client commitment against production and shipment dates",
      `<button class="btn" id="btn-export">Export CSV</button>
       ${canEdit() ? `<button class="btn" id="btn-import">Import CSV</button><button class="btn btn-accent" id="btn-new">+ New delivery</button>` : ""}`);
    $("#btn-new")?.addEventListener("click", () => openDelivery(null));
    $("#btn-export").addEventListener("click", exportCsv);
    $("#btn-import")?.addEventListener("click", importCsvDialog);

    const clients = [...new Set(S.deliveries.map((d) => d.client))].sort();
    const f = S.filters;
    v.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <input type="search" id="f-q" placeholder="Search ref, client, project…" value="${esc(f.q)}" />
          <div class="seg" id="f-view">
            ${[["open", "Open"], ["risk", "At risk"], ["delivered", "Delivered"], ["all", "All"]].map(([k, l]) => `<button data-v="${k}" class="${f.view === k ? "on" : ""}">${l}</button>`).join("")}
          </div>
          <select id="f-status"><option value="">All statuses</option>${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${f.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select id="f-client"><option value="">All clients</option>${clients.map((c) => `<option ${f.client === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
          <span class="muted" id="f-count" style="margin-left:auto"></span>
        </div>
        <div class="table-wrap" id="d-table"></div>
      </div>`;

    const draw = () => {
      const rows = filtered();
      $("#f-count").textContent = `${rows.length} deliver${rows.length === 1 ? "y" : "ies"}`;
      const th = (k, label, cls = "") => `<th class="sortable ${cls}" data-sort="${k}">${label}${f.sort === k ? (f.dir > 0 ? " ↑" : " ↓") : ""}</th>`;
      $("#d-table").innerHTML = rows.length ? `<table>
        <thead><tr>
          ${th("ref_no", "Delivery")}
          ${th("commitment_date", "Client commitment")}
          ${th("production_due", "Production")}
          ${th("ship_planned", "Shipment")}
          ${th("forecast_delivery", "Forecast arrival")}
          ${th("buffer_days", "Buffer", "num")}
          ${th("health", "Health")}
          ${th("status", "Status")}
        </tr></thead>
        <tbody>${rows.map((d) => `
          <tr class="clickable" data-id="${d.id}">
            <td><strong>${esc(d.ref_no)}</strong><div class="sub">${esc(d.client)}${d.project ? " · " + esc(d.project) : ""}</div></td>
            <td><strong>${fmtDate(d.commitment_date)}</strong>${d.owner_id ? `<div class="sub">${esc(profileName(d.owner_id))}</div>` : ""}</td>
            <td>${d.production_done ? `Done ${fmtDate(d.production_done)}` : `Due ${fmtDate(d.production_due)}`}<div class="sub">${d.production_done ? fmtVar(d.production_variance_days) : (d.production_due && d.production_due < todayStr() ? '<span class="var pos">overdue</span>' : (d.production_days_planned !== null ? d.production_days_planned + "d planned" : ""))}</div></td>
            <td>${d.ship_actual ? `Shipped ${fmtDate(d.ship_actual)}` : `Plan ${fmtDate(d.ship_planned)}`}<div class="sub">${[d.ship_actual ? fmtVar(d.shipment_variance_days) : (d.ship_mode ? SHIP_MODES[d.ship_mode] : ""), d.transit_days !== null ? `${d.transit_days}d transit` : ""].filter(Boolean).join(" · ")}</div></td>
            <td>${d.delivered_date ? `Delivered ${fmtDate(d.delivered_date)}` : fmtDate(d.forecast_delivery)}${!d.eta && !d.delivered_date && d.forecast_delivery ? `<div class="sub">est. +${S.settings.default_transit_days}d</div>` : ""}</td>
            <td class="num">${fmtBuffer(d.buffer_days)}</td>
            <td>${healthBadge(d.health)}</td>
            <td><span class="badge nodot">${STATUS[d.status]}</span></td>
          </tr>`).join("")}</tbody></table>`
        : `<div class="empty">${S.deliveries.length ? "No deliveries match these filters." : (canEdit() ? "No deliveries yet. Click “New delivery” to add the first one." : "No deliveries yet.")}</div>`;
      $$("th[data-sort]").forEach((h) => h.addEventListener("click", () => {
        const k = h.dataset.sort;
        if (f.sort === k) f.dir *= -1; else { f.sort = k; f.dir = 1; }
        draw();
      }));
      $$("tr[data-id]", $("#d-table")).forEach((tr) => tr.addEventListener("click", () => openDelivery(tr.dataset.id)));
    };
    draw();

    $("#f-q").addEventListener("input", (e) => { f.q = e.target.value; draw(); });
    $$("#f-view button").forEach((b) => b.addEventListener("click", () => {
      f.view = b.dataset.v; $$("#f-view button").forEach((x) => x.classList.toggle("on", x === b)); draw();
    }));
    $("#f-status").addEventListener("change", (e) => { f.status = e.target.value; draw(); });
    $("#f-client").addEventListener("change", (e) => { f.client = e.target.value; draw(); });
  }

  // ---------------------------------------------------------------- CSV
  const CSV_COLS = ["ref_no", "client", "project", "description", "quantity", "ship_mode", "commitment_date",
    "production_start", "production_due", "production_done", "ship_planned", "ship_actual", "eta", "delivered_date", "status", "notes"];
  function exportCsv() {
    const rows = filtered();
    const cols = CSV_COLS.concat(["forecast_delivery", "buffer_days", "production_variance_days", "shipment_variance_days", "health"]);
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(",")].concat(rows.map((r) => cols.map((c) => q(r[c])).join(","))).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `deliveries-${todayStr()}.csv`;
    a.click();
  }
  function parseCsv(text) {
    const rows = []; let row = [], cell = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') inQ = false; else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ""));
  }
  const normDate = (s) => {
    s = (s || "").trim(); if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/); // DD/MM/YYYY
    if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
    const d = new Date(s); return isNaN(d) ? undefined : d.toISOString().slice(0, 10);
  };
  function importCsvDialog() {
    openModal(`
      <div class="drawer-h"><h3>Import deliveries from CSV</h3><button class="btn btn-ghost btn-sm" data-close-modal>✕</button></div>
      <div class="drawer-b stack">
        <p class="hint" style="font-size:13px">Required columns: <span class="mono">ref_no, client, commitment_date</span>. Optional: <span class="mono">${CSV_COLS.slice(2).filter((c) => c !== "commitment_date").join(", ")}</span>. Dates as YYYY-MM-DD or DD/MM/YYYY. Rows whose ref_no already exists are updated.</p>
        <a href="#" id="csv-template">Download template</a>
        <input type="file" id="csv-file" accept=".csv,text/csv" />
        <div id="csv-preview" class="hint"></div>
      </div>
      <div class="drawer-f"><button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="csv-go" disabled>Import</button></div>`,
      (m) => {
        let records = [];
        $("#csv-template", m).onclick = (e) => {
          e.preventDefault();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(new Blob([CSV_COLS.join(",") + "\nPO-1001,Example Client,Example Project,Spotlights,120,sea," + addDays(todayStr(), 45) + "," + todayStr() + "," + addDays(todayStr(), 21) + ",," + addDays(todayStr(), 25) + ",," + addDays(todayStr(), 38) + ",,,\n"], { type: "text/csv" }));
          a.download = "delivery-import-template.csv"; a.click();
        };
        $("#csv-file", m).onchange = async (e) => {
          const file = e.target.files[0]; if (!file) return;
          const rows = parseCsv(await file.text());
          const head = rows.shift().map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
          const errors = [];
          records = rows.map((r, i) => {
            const o = {};
            head.forEach((h, j) => { if (CSV_COLS.includes(h)) o[h] = (r[j] ?? "").trim() || null; });
            ["commitment_date", "production_start", "production_due", "production_done", "ship_planned", "ship_actual", "eta", "delivered_date"].forEach((k) => {
              if (k in o) { const d = normDate(o[k]); if (d === undefined) errors.push(`Row ${i + 2}: bad date in ${k}`); o[k] = d || null; }
            });
            if (o.quantity) o.quantity = Number(o.quantity) || null;
            if (o.ship_mode) o.ship_mode = o.ship_mode.toLowerCase(); if (o.ship_mode && !SHIP_MODES[o.ship_mode]) o.ship_mode = "other";
            if (o.status && !STATUS[o.status]) o.status = null;
            if (!o.ref_no || !o.client || !o.commitment_date) errors.push(`Row ${i + 2}: ref_no, client and commitment_date are required`);
            o.status = o.status || deriveStatus(o);
            return o;
          });
          $("#csv-preview", m).innerHTML = errors.length
            ? `<span style="color:var(--red)">${errors.slice(0, 6).map(esc).join("<br>")}${errors.length > 6 ? "<br>…" : ""}</span>`
            : `${records.length} row(s) ready to import.`;
          $("#csv-go", m).disabled = !!errors.length || !records.length;
        };
        $("#csv-go", m).onclick = async () => {
          $("#csv-go", m).disabled = true;
          let created = 0, updated = 0;
          for (const r of records) {
            const existing = S.deliveries.find((d) => d.ref_no === r.ref_no);
            const res = existing
              ? await sb.from("deliveries").update(r).eq("id", existing.id)
              : await sb.from("deliveries").insert(r);
            if (res.error) { toast(`${r.ref_no}: ${res.error.message}`, "error"); continue; }
            existing ? updated++ : created++;
          }
          closeModal();
          toast(`Imported: ${created} new, ${updated} updated`);
          await loadAll(); render(false);
        };
      });
  }

  // ---------------------------------------------------------------- delivery drawer
  function deriveStatus(d) {
    if (d.delivered_date) return "delivered";
    if (d.ship_actual) return "shipped";
    if (d.production_done) return "ready_to_ship";
    if (d.production_start && d.production_start <= todayStr()) return "in_production";
    return "planned";
  }

  async function openDelivery(id) {
    const d = id ? S.deliveries.find((x) => x.id === id) : null;
    if (id && !d) return toast("Delivery not found", "error");
    const ro = !canEdit();
    const v = (k) => esc(d?.[k] ?? "");
    const date = (k, label, hint = "") => `<label>${label}<input type="date" name="${k}" value="${v(k)}" ${ro ? "disabled" : ""} />${hint ? `<span class="hint">${hint}</span>` : ""}</label>`;
    const activeUsers = S.profiles.filter((p) => p.is_active);
    const manual = d && ["on_hold", "cancelled"].includes(d.status);
    const myAlerts = d ? S.alerts.filter((a) => a.delivery_id === d.id) : [];

    openDrawer(`
      <div class="drawer-h">
        <div><h2 style="margin:0">${d ? esc(d.ref_no) : "New delivery"}</h2>
          <div class="muted" style="margin-top:2px">${d ? `${esc(d.client)} · ${healthBadge(d.health)}` : "Enter the client commitment, then production and shipment plans."}</div></div>
        <button class="btn btn-ghost btn-sm" id="dr-close">✕</button>
      </div>
      <div class="drawer-b">
        ${d ? `
          <div class="summary-strip">
            <div><div class="label">Commitment</div><div class="value">${fmtDate(d.commitment_date)}</div></div>
            <div><div class="label">Forecast arrival</div><div class="value">${fmtDate(d.forecast_delivery)}</div></div>
            <div><div class="label">Buffer</div><div class="value">${fmtBuffer(d.buffer_days)}</div></div>
            <div><div class="label">Prod / ship vs plan</div><div class="value" style="font-size:13px">${fmtVar(d.production_variance_days)}<br>${fmtVar(d.shipment_variance_days)}</div></div>
          </div>
          ${miniTimeline(d)}
          ${myAlerts.length ? `<div class="fieldset" style="border-color:#f1d3cf">${myAlerts.map((a) => `<div style="display:flex;gap:8px;align-items:flex-start;padding:3px 0">${sevBadge(a.severity)}<span>${esc(a.message)}</span></div>`).join("")}</div>` : ""}
          ${!ro && isOpen(d) ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
            ${!d.production_done ? `<button class="btn btn-sm" data-quick="production_done">✓ Production done today</button>` : ""}
            ${!d.ship_actual ? `<button class="btn btn-sm" data-quick="ship_actual">✓ Shipped today</button>` : ""}
            <button class="btn btn-sm" data-quick="delivered_date">✓ Delivered today</button>
          </div>` : ""}
        ` : ""}
        <form id="dr-form">
          <div class="fieldset">
            <div class="fieldset-h"><span class="dot" style="background:var(--accent)"></span>Client commitment</div>
            <div class="form-grid">
              <label>Reference (PO / SO no.) *<input name="ref_no" required value="${v("ref_no")}" ${ro ? "disabled" : ""} /></label>
              <label>Client *<input name="client" required list="client-list" value="${v("client")}" ${ro ? "disabled" : ""} />
                <datalist id="client-list">${[...new Set(S.deliveries.map((x) => x.client))].map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>
              <label>Project<input name="project" value="${v("project")}" ${ro ? "disabled" : ""} /></label>
              <label>Quantity<input name="quantity" type="number" step="any" value="${v("quantity")}" ${ro ? "disabled" : ""} /></label>
              <label class="full">Description<input name="description" value="${v("description")}" ${ro ? "disabled" : ""} /></label>
              ${date("commitment_date", "Committed delivery date *")}
              <label>Owner<select name="owner_id" ${ro ? "disabled" : ""}><option value="">—</option>${activeUsers.map((p) => `<option value="${p.id}" ${d?.owner_id === p.id || (!d && p.id === S.me.id) ? "selected" : ""}>${esc(p.full_name || p.email)}</option>`).join("")}</select></label>
            </div>
          </div>
          <div class="fieldset">
            <div class="fieldset-h"><span class="dot" style="background:var(--prod)"></span>Production</div>
            <div class="form-grid form-grid-3">
              ${date("production_start", "Start")}
              ${date("production_due", "Planned completion")}
              ${date("production_done", "Actual completion")}
            </div>
          </div>
          <div class="fieldset">
            <div class="fieldset-h"><span class="dot" style="background:var(--ship)"></span>Shipment</div>
            <div class="form-grid">
              <label>Mode<select name="ship_mode" ${ro ? "disabled" : ""}><option value="">—</option>${Object.entries(SHIP_MODES).map(([k, l]) => `<option value="${k}" ${d?.ship_mode === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
              ${date("ship_planned", "Planned ship date (ETD)")}
              ${date("ship_actual", "Actual ship date")}
              ${date("eta", "ETA at client", `Blank = ship date + ${S.settings.default_transit_days} days`)}
              ${date("delivered_date", "Actual delivery date")}
              <label>Status<select name="status" ${ro ? "disabled" : ""}>
                <option value="auto" ${!manual ? "selected" : ""}>Automatic${d && !manual ? ` (${STATUS[d.status]})` : ""}</option>
                <option value="on_hold" ${d?.status === "on_hold" ? "selected" : ""}>On hold</option>
                <option value="cancelled" ${d?.status === "cancelled" ? "selected" : ""}>Cancelled</option>
              </select></label>
            </div>
          </div>
          <label>Notes<textarea name="notes" ${ro ? "disabled" : ""}>${v("notes")}</textarea></label>
          <button type="submit" class="hidden"></button>
        </form>
        ${d ? `<div style="margin-top:18px"><h3 style="margin-bottom:6px">Change history</h3><div id="dr-history" class="history muted">Loading…</div>
          <p class="hint" style="margin-top:10px">Created ${fmtDateTime(d.created_at)}${d.created_by ? " by " + esc(profileName(d.created_by)) : ""} · updated ${fmtDateTime(d.updated_at)}</p></div>` : ""}
      </div>
      <div class="drawer-f">
        ${d && isAdmin() ? `<button class="btn btn-danger" id="dr-delete">Delete</button>` : ""}
        <span class="spacer"></span>
        <button class="btn" id="dr-cancel">${ro ? "Close" : "Cancel"}</button>
        ${ro ? "" : `<button class="btn btn-primary" id="dr-save">${d ? "Save changes" : "Create delivery"}</button>`}
      </div>`);

    $("#dr-close").onclick = closeDrawer;
    $("#dr-cancel").onclick = closeDrawer;
    const form = $("#dr-form");
    form.addEventListener("submit", (e) => { e.preventDefault(); save(); });
    $("#dr-save")?.addEventListener("click", save);
    $("#dr-delete")?.addEventListener("click", async () => {
      if (!(await confirmBox("Delete delivery", `Delete ${d.ref_no}? This also removes its alerts and history.`, "Delete", true))) return;
      const { error } = await sb.from("deliveries").delete().eq("id", d.id);
      if (error) return toast(error.message, "error");
      toast("Deleted"); closeDrawer(); await loadAll(); render(false);
    });
    $$("[data-quick]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.quick;
      form.elements[k].value = todayStr();
      if (k === "ship_actual" && !form.elements.production_done.value) form.elements.production_done.value = todayStr();
      save();
    }));

    async function save() {
      if (!form.reportValidity()) return;
      const fd = new FormData(form);
      const rec = {};
      ["ref_no", "client", "project", "description", "ship_mode", "notes", "owner_id"].forEach((k) => rec[k] = (fd.get(k) || "").trim() || null);
      rec.quantity = fd.get("quantity") ? Number(fd.get("quantity")) : null;
      ["commitment_date", "production_start", "production_due", "production_done", "ship_planned", "ship_actual", "eta", "delivered_date"].forEach((k) => rec[k] = fd.get(k) || null);
      // sanity checks
      const warn = [];
      if (rec.production_start && rec.production_due && rec.production_due < rec.production_start) warn.push("Planned production completion is before the start date.");
      if (rec.ship_planned && rec.eta && rec.eta < rec.ship_planned) warn.push("ETA is before the planned ship date.");
      if (warn.length && !(await confirmBox("Check dates", warn.join(" ") + " Save anyway?", "Save anyway"))) return;
      const st = fd.get("status");
      rec.status = st === "auto" ? deriveStatus(rec) : st;
      const btn = $("#dr-save"); if (btn) btn.disabled = true;
      const res = d ? await sb.from("deliveries").update(rec).eq("id", d.id).select("id").single()
                    : await sb.from("deliveries").insert(rec).select("id").single();
      if (btn) btn.disabled = false;
      if (res.error) return toast(res.error.message, "error");
      toast(d ? "Saved" : "Delivery created");
      await loadAll();
      render(false);
      openDelivery(res.data.id);
    }

    if (d) {
      const { data: hist } = await sb.from("delivery_history").select("*").eq("delivery_id", d.id).order("changed_at", { ascending: false }).limit(50);
      const el = $("#dr-history"); if (!el) return;
      el.classList.remove("muted");
      el.innerHTML = hist?.length ? `<ul>${hist.map((h) => {
        const fmt = (x) => h.field === "status" ? (STATUS[x] || "—") : fmtDate(x);
        return `<li><strong>${esc(FIELD_LABEL[h.field] || h.field)}</strong>: ${fmt(h.old_value)} → ${fmt(h.new_value)} <span class="muted">· ${esc(profileName(h.changed_by) || "system")} · ${fmtDateTime(h.changed_at)}</span></li>`;
      }).join("")}</ul>` : `<span class="muted">No date changes yet.</span>`;
    }
  }

  function miniTimeline(d) {
    const pts = [d.production_start, d.production_due, d.production_done, d.ship_planned, d.ship_actual, d.forecast_delivery, d.delivered_date, d.commitment_date, todayStr()].filter(Boolean);
    let lo = pts.reduce((a, b) => (a < b ? a : b)), hi = pts.reduce((a, b) => (a > b ? a : b));
    lo = addDays(lo, -3); hi = addDays(hi, 3);
    const span = Math.max(1, diffDays(hi, lo));
    const x = (dt) => (diffDays(dt, lo) / span) * 100;
    return `<div class="card" style="margin-bottom:14px;overflow:hidden">
      <div class="tl-row" style="grid-template-columns:1fr;cursor:default;border:0;min-height:50px">
        <div class="tl-track">${trackBars(d, x, lo, hi)}</div>
      </div>
      <div style="display:flex;justify-content:space-between;padding:0 10px 8px" class="muted"><span style="font-size:11px">${fmtDate(lo)}</span><span style="font-size:11px">${fmtDate(hi)}</span></div>
    </div>`;
  }

  function trackBars(d, x, lo, hi) {
    const clamp = (v) => Math.max(0, Math.min(100, v));
    const bar = (from, to, cls, title) => {
      if (!from || !to) return "";
      if (to < lo || from > hi) return "";
      const l = clamp(x(from)), r = clamp(x(addDays(to, 1)));
      return `<div class="tl-bar ${cls}" style="left:${l}%;width:${Math.max(0.6, r - l)}%" title="${esc(title)}"></div>`;
    };
    const prodEnd = d.production_done || d.production_due;
    const shipStart = d.ship_actual || d.ship_planned;
    const shipEnd = d.delivered_date || d.forecast_delivery;
    const t = todayStr();
    let html = "";
    if (t >= lo && t <= hi) html += `<div class="tl-today" style="left:${x(t)}%"></div>`;
    html += bar(d.production_start || prodEnd, prodEnd, "prod" + (d.production_done ? " done" : ""),
      `Production ${fmtDate(d.production_start)} → ${fmtDate(prodEnd)}${d.production_done ? " (done)" : " (planned)"}`);
    html += bar(shipStart, shipEnd, "ship" + (d.delivered_date ? " done" : ""),
      `Shipment ${fmtDate(shipStart)} → ${fmtDate(shipEnd)}${d.delivered_date ? " (delivered)" : " (forecast)"}`);
    if (d.commitment_date >= lo && d.commitment_date <= hi) {
      const late = (d.buffer_days ?? 0) < 0;
      html += `<div class="tl-commit ${late ? "late" : ""}" style="left:${x(addDays(d.commitment_date, 1))}%" title="Client commitment ${fmtDate(d.commitment_date)}"></div>`;
    }
    return html;
  }

  // ---------------------------------------------------------------- timeline
  function viewTimeline(v) {
    setHeader("Timeline", "Production and shipment bars against each client commitment",
      `<div class="seg" id="tl-range">${[["month", "Next 6 weeks"], ["quarter", "Next 3 months"], ["half", "Next 6 months"], ["fit", "Fit all"]].map(([k, l]) => `<button data-r="${k}" class="${S.tlRange === k ? "on" : ""}">${l}</button>`).join("")}</div>`);
    const rows = filtered().slice().sort((a, b) => (a.commitment_date > b.commitment_date ? 1 : -1));
    const t = todayStr();
    let lo, hi;
    if (S.tlRange === "fit" && rows.length) {
      const pts = rows.flatMap((d) => [d.production_start, d.production_due, d.commitment_date, d.forecast_delivery, d.delivered_date]).filter(Boolean);
      lo = addDays(pts.reduce((a, b) => (a < b ? a : b)), -3); hi = addDays(pts.reduce((a, b) => (a > b ? a : b)), 3);
    } else {
      const ahead = { month: 42, quarter: 91, half: 182 }[S.tlRange] || 91;
      lo = addDays(t, -14); hi = addDays(t, ahead);
    }
    const span = Math.max(1, diffDays(hi, lo));
    const x = (dt) => (diffDays(dt, lo) / span) * 100;
    // ticks: weekly (Mondays) or monthly
    const ticks = [];
    const weekly = span <= 120;
    let cur = lo;
    while (cur <= hi) {
      const dt = new Date(toUTC(cur));
      if (weekly ? dt.getUTCDay() === 1 : dt.getUTCDate() === 1) ticks.push(cur);
      cur = addDays(cur, 1);
    }
    const f = S.filters;
    v.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <input type="search" id="f-q" placeholder="Search…" value="${esc(f.q)}" />
          <div class="seg" id="f-view">${[["open", "Open"], ["risk", "At risk"], ["delivered", "Delivered"], ["all", "All"]].map(([k, l]) => `<button data-v="${k}" class="${f.view === k ? "on" : ""}">${l}</button>`).join("")}</div>
          <div class="legend" style="margin-left:auto">
            <span><i style="background:var(--prod)"></i>Production</span>
            <span><i style="background:var(--ship)"></i>Shipment → arrival</span>
            <span><i style="background:var(--accent);border:2px solid var(--ink);width:10px;height:10px;transform:rotate(45deg)"></i>Client commitment</span>
            <span><i style="background:var(--blue);width:3px"></i>Today</span>
            <span class="muted">Light bars = planned, solid = actual</span>
          </div>
        </div>
        ${rows.length ? `<div class="tl">
          <div class="tl-head"><div class="tl-label muted" style="font-size:12px;padding-top:14px">${rows.length} deliveries</div>
            <div class="tl-scale">${ticks.map((tk) => `<div class="tick" style="left:${x(tk)}%">${fmtDate(tk, false)}</div>`).join("")}
              ${t >= lo && t <= hi ? `<div class="tl-today-label" style="left:${x(t)}%;top:24px">Today</div>` : ""}</div>
          </div>
          ${rows.map((d) => `
            <div class="tl-row" data-id="${d.id}">
              <div class="tl-label"><div class="ref">${esc(d.ref_no)} ${healthBadge(d.health).replace('class="badge', 'style="font-size:10.5px;padding:0 6px;margin-left:4px" class="badge')}</div><div class="sub">${esc(d.client)} · due ${fmtDate(d.commitment_date)}</div></div>
              <div class="tl-track">
                ${ticks.map((tk) => `<div class="tl-grid" style="left:${x(tk)}%"></div>`).join("")}
                ${trackBars(d, x, lo, hi)}
              </div>
            </div>`).join("")}
        </div>` : `<div class="empty">No deliveries to show.</div>`}
      </div>`;
    $$(".tl-row[data-id]", v).forEach((r) => r.addEventListener("click", () => openDelivery(r.dataset.id)));
    $$("#tl-range button").forEach((b) => b.addEventListener("click", () => { S.tlRange = b.dataset.r; render(false); }));
    $("#f-q").addEventListener("change", (e) => { f.q = e.target.value; render(false); });
    $$("#f-view button").forEach((b) => b.addEventListener("click", () => { f.view = b.dataset.v; render(false); }));
  }

  // ---------------------------------------------------------------- alerts
  async function viewAlerts(v) {
    const undismissed = S.alerts.filter((a) => !S.dismissed.has(a.id));
    setHeader("Alerts", `${undismissed.length} open alert${undismissed.length === 1 ? "" : "s"} · checked automatically on every change and daily at midnight`,
      undismissed.length ? `<button class="btn" id="dismiss-all">Dismiss all</button>` : "");
    const tab = S.alertTab;
    v.innerHTML = `
      <div class="card">
        <div class="toolbar">
          <div class="seg" id="a-tab">${[["open", "Open"], ["dismissed", "Dismissed"], ["resolved", "Resolved (30 days)"]].map(([k, l]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</div>
        </div>
        <div id="a-list"><div class="spinner"></div></div>
      </div>`;
    $$("#a-tab button").forEach((b) => b.addEventListener("click", () => { S.alertTab = b.dataset.t; render(false); }));
    $("#dismiss-all")?.addEventListener("click", async () => {
      const rows = undismissed.map((a) => ({ alert_id: a.id, user_id: S.me.id }));
      const { error } = await sb.from("alert_dismissals").upsert(rows);
      if (error) return toast(error.message, "error");
      rows.forEach((r) => S.dismissed.add(r.alert_id)); updateBadges(); render(false);
    });

    let list;
    if (tab === "resolved") {
      const { data, error } = await sb.from("alerts").select("*").not("resolved_at", "is", null)
        .gte("resolved_at", new Date(Date.now() - 30 * 86400000).toISOString()).order("resolved_at", { ascending: false }).limit(200);
      if (error) toast(error.message, "error");
      list = data || [];
    } else {
      list = S.alerts.filter((a) => (tab === "open") !== S.dismissed.has(a.id));
    }
    const order = { critical: 0, warning: 1, info: 2 };
    list.sort((a, b) => order[a.severity] - order[b.severity] || (a.created_at < b.created_at ? 1 : -1));
    const icon = {
      critical: '<svg viewBox="0 0 24 24"><path d="M12 2 1 21h22zm1 15h-2v-2h2zm0-4h-2V9h2z"/></svg>',
      warning: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>',
      info: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>',
    };
    const el = $("#a-list"); if (!el) return;
    el.innerHTML = list.length ? list.map((a) => {
      const d = S.deliveries.find((x) => x.id === a.delivery_id);
      return `<div class="alert-item ${tab !== "open" ? "dismissed" : ""}">
        <div class="alert-icon s-${a.severity}">${icon[a.severity]}</div>
        <div><div class="msg">${esc(a.message)}</div>
          <div class="meta">${sevBadge(a.severity)} &nbsp;${esc(ALERT_TYPES[a.type] || a.type)} · raised ${relTime(a.created_at)}${a.resolved_at ? ` · resolved ${relTime(a.resolved_at)}` : ""}${d?.owner_id ? ` · owner ${esc(profileName(d.owner_id))}` : ""}</div></div>
        <div style="display:flex;gap:6px">
          ${d ? `<button class="btn btn-sm" data-open="${d.id}">Open</button>` : ""}
          ${tab === "open" ? `<button class="btn btn-sm btn-ghost" data-dismiss="${a.id}">Dismiss</button>` : ""}
          ${tab === "dismissed" ? `<button class="btn btn-sm btn-ghost" data-restore="${a.id}">Restore</button>` : ""}
        </div>
      </div>`;
    }).join("") : `<div class="empty">${tab === "open" ? "No open alerts. Everything is on track." : "Nothing here."}</div>`;

    $$("[data-open]", el).forEach((b) => b.addEventListener("click", () => openDelivery(b.dataset.open)));
    $$("[data-dismiss]", el).forEach((b) => b.addEventListener("click", async () => {
      const { error } = await sb.from("alert_dismissals").upsert({ alert_id: b.dataset.dismiss, user_id: S.me.id });
      if (error) return toast(error.message, "error");
      S.dismissed.add(b.dataset.dismiss); updateBadges(); render(false);
    }));
    $$("[data-restore]", el).forEach((b) => b.addEventListener("click", async () => {
      const { error } = await sb.from("alert_dismissals").delete().eq("alert_id", b.dataset.restore).eq("user_id", S.me.id);
      if (error) return toast(error.message, "error");
      S.dismissed.delete(b.dataset.restore); updateBadges(); render(false);
    }));
  }

  // ---------------------------------------------------------------- users (admin)
  async function adminCall(body) {
    const { data, error } = await sb.functions.invoke("admin-users", { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); msg = j.error || msg; } catch (_) {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function viewUsers(v) {
    setHeader("Users", "Approve sign-ups, set roles and deactivate accounts",
      `<button class="btn btn-accent" id="u-add">+ Add user</button>`);
    v.innerHTML = `<div class="card"><div id="u-list"><div class="spinner"></div></div></div>
      <div class="card card-b" style="margin-top:16px;font-size:13px;line-height:1.6">
        <strong>Roles</strong><br>
        <span class="badge nodot">Admin</span> manages users and alert settings, can delete deliveries ·
        <span class="badge nodot">Editor</span> creates and updates deliveries ·
        <span class="badge nodot">Viewer</span> read-only access. People who use “Request access” wait here as inactive until you approve them.
      </div>`;
    $("#u-add").addEventListener("click", addUserDialog);
    let users;
    try { users = (await adminCall({ action: "list" })).users; }
    catch (e) { $("#u-list").innerHTML = `<div class="empty">Could not load users: ${esc(e.message)}</div>`; return; }
    S.profiles = users.map(({ id, email, full_name, role, is_active }) => ({ id, email, full_name, role, is_active }));
    updateBadges();
    users.sort((a, b) => (a.is_active === b.is_active ? (a.email > b.email ? 1 : -1) : a.is_active ? 1 : -1));
    $("#u-list").innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>User</th><th>Role</th><th>Active</th><th>Last sign-in</th><th></th></tr></thead>
      <tbody>${users.map((u) => `
        <tr data-uid="${u.id}" ${!u.is_active ? 'style="background:#fffaf0"' : ""}>
          <td><strong>${esc(u.full_name || "—")}</strong>${u.id === S.me.id ? ' <span class="badge nodot">You</span>' : ""}<div class="sub">${esc(u.email)}</div></td>
          <td><select data-role style="width:auto">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${l}</option>`).join("")}</select></td>
          <td>${!u.is_active && !u.last_sign_in_at ? `<button class="btn btn-sm btn-primary" data-approve>Approve</button>` : `<label class="switch"><input type="checkbox" data-active ${u.is_active ? "checked" : ""}/><span></span></label>`}</td>
          <td class="muted">${u.last_sign_in_at ? fmtDateTime(u.last_sign_in_at) : "Never"}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-sm btn-ghost" data-reset>Set password</button>
            ${u.id !== S.me.id ? `<button class="btn btn-sm btn-ghost btn-danger" data-del>Delete</button>` : ""}
          </td>
        </tr>`).join("")}</tbody></table></div>`;

    $$("tr[data-uid]").forEach((tr) => {
      const id = tr.dataset.uid;
      const u = users.find((x) => x.id === id);
      const run = async (body, okMsg) => {
        try { await adminCall({ id, ...body }); toast(okMsg); } catch (e) { toast(e.message, "error"); }
        viewUsers(v);
      };
      $("[data-role]", tr).addEventListener("change", (e) => run({ action: "update", role: e.target.value }, "Role updated"));
      $("[data-active]", tr)?.addEventListener("change", (e) => run({ action: "update", is_active: e.target.checked }, e.target.checked ? "User activated" : "User deactivated"));
      $("[data-approve]", tr)?.addEventListener("click", () => run({ action: "update", is_active: true, role: $("[data-role]", tr).value }, "User approved"));
      $("[data-reset]", tr).addEventListener("click", () => {
        openModal(`<div class="drawer-h"><h3>Set password for ${esc(u.email)}</h3></div>
          <form class="drawer-b stack" id="pw-form"><label>New password<input name="pw" type="text" minlength="8" required value="${genPassword()}" /></label>
          <p class="hint">Share it with the user securely. They can change it under My account.</p></form>
          <div class="drawer-f"><button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="pw-go">Set password</button></div>`,
          (m) => {
            const go = async (e) => { e && e.preventDefault(); const f = $("#pw-form", m); if (!f.reportValidity()) return; const pw = f.elements.pw.value; closeModal(); run({ action: "reset_password", password: pw }, "Password set"); };
            $("#pw-go", m).onclick = go; $("#pw-form", m).onsubmit = go;
          });
      });
      $("[data-del]", tr)?.addEventListener("click", async () => {
        if (await confirmBox("Delete user", `Permanently delete ${u.email}? Their deliveries stay, without an owner.`, "Delete", true))
          run({ action: "delete" }, "User deleted");
      });
    });
  }

  function genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const a = new Uint32Array(12); crypto.getRandomValues(a);
    return Array.from(a, (n) => chars[n % chars.length]).join("");
  }

  function addUserDialog() {
    openModal(`
      <div class="drawer-h"><h3>Add user</h3><button class="btn btn-ghost btn-sm" data-close-modal>✕</button></div>
      <form class="drawer-b stack" id="add-form">
        <label>Full name<input name="full_name" required /></label>
        <label>Email<input name="email" type="email" required /></label>
        <label>Role<select name="role"><option value="viewer">Viewer (read only)</option><option value="editor" selected>Editor</option><option value="admin">Admin</option></select></label>
        <label>Temporary password<input name="password" type="text" minlength="8" required value="${genPassword()}" /></label>
        <p class="hint">The account is active immediately. Send the user their email and temporary password.</p>
      </form>
      <div class="drawer-f"><button class="btn" data-close-modal>Cancel</button><button class="btn btn-primary" id="add-go">Create user</button></div>`,
      (m) => {
        const go = async (e) => {
          e && e.preventDefault();
          const f = $("#add-form", m); if (!f.reportValidity()) return;
          const body = Object.fromEntries(new FormData(f)); body.action = "create";
          $("#add-go", m).disabled = true;
          try {
            await adminCall(body);
            closeModal();
            openModal(`<div class="drawer-h"><h3>User created</h3></div>
              <div class="drawer-b"><p style="margin-top:0">Share these sign-in details:</p>
              <div class="mono" style="background:var(--bg);padding:12px;border-radius:8px;line-height:1.7">${esc(location.origin)}<br>${esc(body.email)}<br>${esc(body.password)}</div></div>
              <div class="drawer-f"><button class="btn" id="cp">Copy</button><button class="btn btn-primary" data-close-modal>Done</button></div>`,
              (m2) => { $("#cp", m2).onclick = () => { navigator.clipboard.writeText(`${location.origin}\nEmail: ${body.email}\nPassword: ${body.password}`); toast("Copied"); }; });
            if (S.route === "users") viewUsers($("#view"));
          } catch (err) { toast(err.message, "error"); $("#add-go", m).disabled = false; }
        };
        $("#add-go", m).onclick = go; $("#add-form", m).onsubmit = go;
      });
  }

  // ---------------------------------------------------------------- settings (admin)
  function viewSettings(v) {
    setHeader("Alert settings", "Thresholds used to raise alerts for every delivery");
    const s = S.settings;
    v.innerHTML = `
      <div class="grid grid-2">
        <form class="card" id="set-form">
          <div class="card-h"><h3>Thresholds</h3></div>
          <div class="card-b stack">
            <label>“Due soon” warning (days before commitment)<input type="number" min="0" max="120" name="due_soon_days" value="${s.due_soon_days}" /></label>
            <label>Minimum buffer (days between forecast arrival and commitment)<input type="number" min="0" max="60" name="min_buffer_days" value="${s.min_buffer_days}" />
              <span class="hint">Below this a delivery is flagged “Tight buffer”.</span></label>
            <label>Default transit time (days) when no ETA is entered<input type="number" min="0" max="120" name="default_transit_days" value="${s.default_transit_days}" /></label>
            <div><button class="btn btn-primary" type="submit">Save settings</button></div>
          </div>
        </form>
        <div class="card">
          <div class="card-h"><h3>Alerts raised</h3></div>
          <div class="card-b" style="font-size:13px;line-height:1.55">
            ${[
              ["critical", "Commitment date passed", "The client commitment date is past and the delivery is not confirmed."],
              ["critical", "Forecast later than commitment", "Delivered / ETA / ship date + transit falls after the commitment date."],
              ["warning", "Tight buffer", `Fewer than ${s.min_buffer_days} days between forecast arrival and commitment.`],
              ["warning", "Production overdue", "Planned production completion has passed without an actual completion date."],
              ["warning", "Production after shipment", "Production completes after the planned ship date."],
              ["warning", "Shipment overdue", "Planned ship date has passed without an actual ship date."],
              ["info", "Commitment due soon", `Commitment date is within ${s.due_soon_days} days.`],
            ].map(([sev, t, d]) => `<div style="display:grid;grid-template-columns:80px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid var(--line-2)">${sevBadge(sev)}<div><strong>${t}</strong><br><span class="muted">${d}</span></div></div>`).join("")}
            <p class="hint" style="margin-top:10px">Alerts are recalculated whenever a delivery changes and every night at 00:05 Singapore time. They close automatically when the condition clears.</p>
          </div>
        </div>
      </div>`;
    $("#set-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const rec = { due_soon_days: +f.due_soon_days, min_buffer_days: +f.min_buffer_days, default_transit_days: +f.default_transit_days, updated_at: new Date().toISOString() };
      const { error } = await sb.from("settings").update(rec).eq("id", 1);
      if (error) return toast(error.message, "error");
      toast("Settings saved — alerts recalculated");
      await loadAll(); render(false);
    });
  }

  // ---------------------------------------------------------------- account
  function viewAccount(v) {
    setHeader("My account", esc(S.me.email));
    v.innerHTML = `
      <div class="grid grid-2">
        <form class="card" id="acc-form">
          <div class="card-h"><h3>Profile</h3></div>
          <div class="card-b stack">
            <label>Full name<input name="full_name" value="${esc(S.me.full_name || "")}" required /></label>
            <label>Role<input value="${ROLE_LABEL[S.me.role]}" disabled /></label>
            <div><button class="btn btn-primary" type="submit">Save</button></div>
          </div>
        </form>
        <form class="card" id="pw-form2">
          <div class="card-h"><h3>Change password</h3></div>
          <div class="card-b stack">
            <label>New password<input type="password" name="pw" minlength="8" required autocomplete="new-password" /></label>
            <label>Confirm<input type="password" name="pw2" minlength="8" required autocomplete="new-password" /></label>
            <div><button class="btn btn-primary" type="submit">Update password</button></div>
          </div>
        </form>
      </div>`;
    $("#acc-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const full_name = new FormData(e.target).get("full_name").trim();
      const { error } = await sb.from("profiles").update({ full_name }).eq("id", S.me.id);
      if (error) return toast(error.message, "error");
      S.me.full_name = full_name; renderMe(); toast("Saved");
    });
    $("#pw-form2").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (f.get("pw") !== f.get("pw2")) return toast("Passwords don't match", "error");
      const { error } = await sb.auth.updateUser({ password: f.get("pw") });
      if (error) return toast(error.message, "error");
      e.target.reset(); toast("Password updated");
    });
  }

  // ---------------------------------------------------------------- go
  if (location.hash.includes("type=recovery")) { recovering = true; showScreen("auth"); authForm("newpass"); }
  else start();
})();
