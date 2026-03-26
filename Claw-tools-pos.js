// claw-tools-pos.js — DIGIY MON COMMERCE / POS bridge v1
// Doctrine : on n'invente pas. Terrain extrait de dashboard-pro.html + guard.js POS.
// API canonique : window.DIGIY_CLAW_POS
// Alias confort  : window.CLAW_POS = window.DIGIY_CLAW_POS
// ─────────────────────────────────────────────────────────────────────────────

(() => {
  "use strict";

  const CFG = {
    MODULE:       "POS",
    MODULE_LOWER: "pos",

    PATHS: {
      home:      "./index.html",
      pin:       "./pin.html",
      caisse:    "./caisse.html",
      admin:     "./admin.html",
      dashboard: "./dashboard-pro.html"
    },

    TABLES: {
      SUBSCRIPTIONS_PUBLIC: "digiy_subscriptions_public"
    },

    // RPCs réels déclarés dans dashboard-pro.html
    RPCS: {
      HAS_ACCESS:             "digiy_has_access",
      GET_SUBSCRIPTION:       "digiy_get_subscription_status",
      GET_DASHBOARD_STATS:    "digiy_get_dashboard_stats",
      GET_BOOST_STATUS:       "digiy_get_boost_status",
      BUILD_PAY_URL:          "digiy_build_pay_url",
      GET_STORE_CONTEXT:      "digiy_pos_get_store_context_by_slug"
    },

    STORAGE: {
      SESSION_LIST: [
        "DIGIY_POS_PIN_SESSION",
        "DIGIY_PIN_SESSION",
        "DIGIY_ACCESS",
        "DIGIY_SESSION_POS",
        "digiy_pos_session"
      ],
      SLUG:      "digiy_pos_last_slug",
      PHONE:     "digiy_pos_last_phone",
      LAST_SLUG: "digiy_pos_last_slug"
    },

    SUPABASE_URL:
      window.DIGIY_SUPABASE_URL ||
      "https://wesqmwjjtsefyjnluosj.supabase.co",

    SUPABASE_ANON_KEY:
      window.DIGIY_SUPABASE_ANON ||
      window.DIGIY_SUPABASE_ANON_KEY ||
      "sb_publishable_tGHItRgeWDmGjnd0CK1DVQ_BIep4Ug3",

    ABOS_URL: "https://commencer-a-payer.digiylyfe.com/"
  };

  // ── CACHE ──────────────────────────────────────────────────────────────────
  const CACHE = { sb: null };

  // ── NORMALISEURS ───────────────────────────────────────────────────────────
  function normSlug(v) {
    return String(v || "").trim().toLowerCase()
      .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-").replace(/^-|-$/g, "");
  }

  function normPhone(v) {
    const raw     = String(v || "").trim();
    const cleaned = raw.replace(/[^\d+]/g, "");
    const digits  = cleaned.replace(/[^\d]/g, "");
    if (!digits) return "";
    return cleaned.startsWith("+") ? `+${digits}` : digits;
  }

  function cleanDigits(v) {
    return String(v || "").replace(/[^\d]/g, "");
  }

  // ── HELPERS ────────────────────────────────────────────────────────────────
  function asError(message, extra = {}) {
    return { ok: false, error: String(message || "Erreur."), ...extra };
  }

  function withIdentity(pathname, ctx = {}) {
    const url   = new URL(pathname, location.href);
    const slug  = normSlug(ctx.slug  || "");
    const phone = normPhone(ctx.phone || "");
    if (slug)  url.searchParams.set("slug",   slug);
    if (phone) url.searchParams.set("phone",  phone);
    return url.toString();
  }

  // ── CLIENT SUPABASE ────────────────────────────────────────────────────────
  // Priorité : window.sb existant → makeFallback (même config que dashboard-pro)
  function getSupabaseClient() {
    if (CACHE.sb) return CACHE.sb;

    if (window.sb && typeof window.sb.from === "function") {
      CACHE.sb = window.sb;
      return CACHE.sb;
    }

    if (!window.supabase?.createClient) return null;

    CACHE.sb = window.supabase.createClient(
      CFG.SUPABASE_URL,
      CFG.SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    );
    return CACHE.sb;
  }

  // ── CONTEXTE GUARD ────────────────────────────────────────────────────────
  async function getContext() {
    const g = window.DIGIY_GUARD;

    if (!g) {
      // Fallback storage — miroir de getSlug() / getPhone() du dashboard
      let slug  = normSlug(new URLSearchParams(location.search).get("slug") || "");
      let phone = cleanDigits(new URLSearchParams(location.search).get("phone") || "");

      try {
        slug  = slug  || normSlug(localStorage.getItem(CFG.STORAGE.SLUG) || "");
        phone = phone || cleanDigits(localStorage.getItem(CFG.STORAGE.PHONE) || "");
      } catch (_) {}

      return {
        ok: true, module: CFG.MODULE,
        slug, phone, owner_id: null,
        access_ok: false, preview: true,
        source: "guard_missing", pin_url: null, pay_url: null
      };
    }

    let state = null;
    if (typeof g.getSession === "function") state = g.getSession();
    if (!state?.ready_flag && typeof g.ready === "function") state = await g.ready();
    state = state || {};

    return {
      ok:        true,
      module:    String(state.module || CFG.MODULE).toUpperCase(),
      slug:      normSlug(state.slug  || ""),
      phone:     normPhone(state.phone || ""),
      owner_id:  state.owner_id || null,
      access_ok: !!(state.access_ok || state.access),
      preview:   !!state.preview,
      source:    state.source || "guard",
      pin_url:   state.pin_url || null,
      pay_url:   state.pay_url || null
    };
  }

  async function requireContext() {
    const ctx = await getContext();
    if (!ctx.ok) return ctx;
    if (!ctx.slug) return asError("Slug POS manquant.", { context: ctx });
    return ctx;
  }

  async function requireAccess() {
    const ctx = await requireContext();
    if (!ctx.ok) return ctx;
    if (!ctx.access_ok || ctx.preview) {
      return asError("Accès POS non actif.", { context: ctx, code: "access_required" });
    }
    return ctx;
  }

  // ── RPC helper ─────────────────────────────────────────────────────────────
  // Miroir de rpcFirstSuccess() dans dashboard-pro.html
  async function rpcFirstSuccess(name, payloads) {
    const sb = getSupabaseClient();
    if (!sb) throw new Error("supabase_not_ready");

    let lastErr = null;
    for (const payload of payloads) {
      const { data, error } = await sb.rpc(name, payload);
      if (!error) return data;
      lastErr = error;
    }
    throw lastErr || new Error(`RPC ${name} échouée`);
  }

  // ── TOOLS MÉTIER ───────────────────────────────────────────────────────────

  async function getStoreContext(payload = {}) {
    const ctx = await requireContext();
    if (!ctx.ok) return ctx;

    try {
      const data = await rpcFirstSuccess(CFG.RPCS.GET_STORE_CONTEXT, [
        { p_slug: ctx.slug },
        { slug:   ctx.slug }
      ]);
      return { ok: true, tool: "get_store_context", context: ctx, data };
    } catch (err) {
      return asError(`get_store_context: ${err?.message || err}`, { context: ctx });
    }
  }

  async function getSubscription(payload = {}) {
    const ctx = await requireAccess();
    if (!ctx.ok) return ctx;

    try {
      const data = await rpcFirstSuccess(CFG.RPCS.GET_SUBSCRIPTION, [
        { p_phone: ctx.phone, p_module: CFG.MODULE },
        { phone:   ctx.phone, module:   CFG.MODULE }
      ]);
      return { ok: true, tool: "get_subscription", context: ctx, data };
    } catch (err) {
      return asError(`get_subscription: ${err?.message || err}`, { context: ctx });
    }
  }

  async function getDashboardStats(payload = {}) {
    const ctx = await requireAccess();
    if (!ctx.ok) return ctx;

    try {
      const data = await rpcFirstSuccess(CFG.RPCS.GET_DASHBOARD_STATS, [
        { p_phone: ctx.phone, p_module: CFG.MODULE },
        { phone:   ctx.phone, module:   CFG.MODULE }
      ]);
      return { ok: true, tool: "get_dashboard_stats", context: ctx, data };
    } catch (err) {
      return asError(`get_dashboard_stats: ${err?.message || err}`, { context: ctx });
    }
  }

  async function getBoostStatus(payload = {}) {
    const ctx = await requireAccess();
    if (!ctx.ok) return ctx;

    try {
      const data = await rpcFirstSuccess(CFG.RPCS.GET_BOOST_STATUS, [
        { p_phone: ctx.phone },
        { phone:   ctx.phone }
      ]);
      return { ok: true, tool: "get_boost_status", context: ctx, data };
    } catch (err) {
      return asError(`get_boost_status: ${err?.message || err}`, { context: ctx });
    }
  }

  async function buildPayUrl(payload = {}) {
    const ctx = await requireAccess();
    if (!ctx.ok) return ctx;

    const module = String(payload.module || CFG.MODULE);
    const plan   = String(payload.plan   || "");

    try {
      const data = await rpcFirstSuccess(CFG.RPCS.BUILD_PAY_URL, [
        { p_module: module, p_phone: ctx.phone, p_plan: plan },
        { module,           phone:   ctx.phone, plan         }
      ]);
      const url = typeof data === "string" ? data : (data?.url || data?.pay_url || null);
      return { ok: true, tool: "build_pay_url", context: ctx, url };
    } catch (err) {
      return asError(`build_pay_url: ${err?.message || err}`, { context: ctx });
    }
  }

  // Navigation
  async function openCaisse()    { const ctx = await requireContext(); if (!ctx.ok) return ctx; return { ok: true, url: withIdentity(CFG.PATHS.caisse,    ctx) }; }
  async function openAdmin()     { const ctx = await requireContext(); if (!ctx.ok) return ctx; return { ok: true, url: withIdentity(CFG.PATHS.admin,     ctx) }; }
  async function openDashboard() { const ctx = await requireContext(); if (!ctx.ok) return ctx; return { ok: true, url: withIdentity(CFG.PATHS.dashboard, ctx) }; }
  async function openPin() {
    const ctx = await getContext();
    const g   = window.DIGIY_GUARD;
    if (g?.goPin) { g.goPin({ slug: ctx.slug, phone: ctx.phone }); return { ok: true, tool: "open_pin" }; }
    location.replace(withIdentity(CFG.PATHS.pin, ctx));
    return { ok: true, tool: "open_pin" };
  }

  async function refreshContext() {
    const g = window.DIGIY_GUARD;
    if (!g?.refresh) return asError("refresh guard indisponible.");
    const state = await g.refresh();
    return { ok: true, tool: "refresh_context", context: {
      module:    String(state?.module   || CFG.MODULE).toUpperCase(),
      slug:      normSlug(state?.slug   || ""),
      phone:     normPhone(state?.phone || ""),
      access_ok: !!(state?.access_ok || state?.access),
      preview:   !!state?.preview,
      source:    state?.source || "guard"
    }};
  }

  // ── SNAPSHOT ───────────────────────────────────────────────────────────────
  async function snapshot() {
    const ctx = await getContext();
    return {
      guard_loaded:  !!window.DIGIY_GUARD,
      authenticated: ctx.ok && ctx.access_ok,
      slug:          ctx.slug      || "(aucun)",
      phone:         ctx.phone     || "(aucun)",
      preview:       ctx.preview   ?? true,
      source:        ctx.source    || "none",
      error:         ctx.error     || null,
      module:        CFG.MODULE,
      tools:         listTools().map(t => t.name)
    };
  }

  // ── NAVIGATION CONSOLE ─────────────────────────────────────────────────────
  async function goTo(page) {
    const map = { caisse: "open_caisse", admin: "open_admin", dashboard: "open_dashboard", pin: "open_pin" };
    const action = map[String(page || "").toLowerCase()];
    if (!action) return asError(`Navigation inconnue : "${page}"`);
    const res = await runAction(action);
    if (res?.url) location.href = res.url;
    return res;
  }

  // ── REGISTRE TOOLS ─────────────────────────────────────────────────────────
  const tools = {
    get_context:         { description: "Retourne le contexte réel du module POS.",                       run: getContext },
    get_store_context:   { description: "Charge le contexte du commerce via digiy_pos_get_store_context_by_slug.", run: getStoreContext },
    get_subscription:    { description: "Charge le statut d'abonnement POS.",                             run: getSubscription },
    get_dashboard_stats: { description: "Charge les stats du dashboard (CA mois, tx, today_hint).",       run: getDashboardStats },
    get_boost_status:    { description: "Charge le statut boost actif.",                                  run: getBoostStatus },
    build_pay_url:       { description: "Construit l'URL de paiement via digiy_build_pay_url (payload: {module?, plan?}).", run: buildPayUrl },
    open_caisse:         { description: "Retourne l'URL de caisse.html avec le slug actif.",              run: openCaisse },
    open_admin:          { description: "Retourne l'URL de admin.html avec le slug actif.",               run: openAdmin },
    open_dashboard:      { description: "Retourne l'URL de dashboard-pro.html avec le slug actif.",       run: openDashboard },
    open_pin:            { description: "Renvoie vers pin.html si la session est cassée.",                run: openPin },
    refresh_context:     { description: "Redemande l'état réel au guard.",                                run: refreshContext }
  };

  function listTools() {
    return Object.entries(tools).map(([name, spec]) => ({ name, description: spec.description }));
  }

  async function runAction(name, payload = {}) {
    const key  = String(name || "").trim().toLowerCase();
    const tool = tools[key];
    if (!tool?.run) return asError(`Tool inconnu : "${name}". Disponibles : ${Object.keys(tools).join(", ")}`);
    try { return await tool.run(payload); }
    catch (err) { return asError(err?.message || `Erreur pendant "${name}"`); }
  }

  async function ready() {
    const ctx = await getContext();
    return { ok: true, module: CFG.MODULE, context: ctx.ok ? ctx : null, tools: listTools() };
  }

  // ── EXPOSITION ─────────────────────────────────────────────────────────────
  const API = {
    ready, getContext, snapshot,
    listTools, runAction, tools,
    goTo,
    normSlug, normPhone,
    PATHS: CFG.PATHS, TABLES: CFG.TABLES, RPCS: CFG.RPCS, MODULE: CFG.MODULE
  };

  window.DIGIY_CLAW_POS = API;
  window.CLAW_POS        = API;

  console.info(
    "[CLAW_POS v1] chargé —",
    window.DIGIY_GUARD ? "guard présent ✓" : "guard absent ✗",
    "— tape CLAW_POS.snapshot() pour l'état complet"
  );
})();
