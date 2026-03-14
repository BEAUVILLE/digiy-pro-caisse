/**
 * DIGIY GUARD — POS preview-safe / slug-first / rail local
 *
 * Rôle :
 * - sans slug => aperçu propre, pas de redirection forcée
 * - avec slug + accès OK => mode live
 * - avec slug + pas d'accès => aperçu verrouillé, sans boucle
 *
 * API exposée :
 *   await window.DIGIY_GUARD.ready
 *   window.DIGIY_GUARD.state
 *   window.DIGIY_GUARD.refresh()
 *   window.DIGIY_GUARD.checkAccess()
 *   window.DIGIY_GUARD.rpc(fn, args)
 *   window.DIGIY_GUARD.openPin()
 *   window.DIGIY_GUARD.logout()
 */
(function () {
  "use strict";

  const SUPABASE_URL =
    String(window.DIGIY_SUPABASE_URL || "https://wesqmwjjtsefyjnluosj.supabase.co").trim();

  const SUPABASE_ANON_KEY =
    String(
      window.DIGIY_SUPABASE_ANON_KEY ||
      window.DIGIY_SUPABASE_ANON ||
      "sb_publishable_tGHItRgeWDmGjnd0CK1DVQ_BIep4Ug3"
    ).trim();

  const MODULE = "POS";
  const MODULE_ALIASES = new Set(["POS", "CAISSE"]);

  const SESSION_KEY = "DIGIY_GUARD_POS_PUBLIC";
  const ACCESS_KEY = "DIGIY_ACCESS";
  const POS_LAST_SLUG_KEY = "digiy_pos_last_slug";
  const POS_LAST_PHONE_KEY = "digiy_pos_last_phone";
  const SESSION_MAX_AGE_MS = 12 * 3600 * 1000; // 12h

  let _sb = null;
  let _readyResolve = null;
  const ready = new Promise((resolve) => { _readyResolve = resolve; });

  const state = {
    module: MODULE,
    slug: "",
    phone: "",
    owner_id: null,
    title: "",
    hasAccess: false,
    mode: "preview",   // preview | live | locked
    reason: "init",
    fromPin: false,
    checkedAt: null,
    ready: false
  };

  function digiyBasePath() {
    const parts = location.pathname.split("/").filter(Boolean);
    const isGh = /\.github\.io$/i.test(location.hostname);
    if (isGh && parts.length > 0) return "/" + parts[0] + "/";
    return "/";
  }

  function digiyLocal(path) {
    path = String(path || "").replace(/^\/+/, "");
    return digiyBasePath() + path;
  }

  function getPinHub() {
    return new URL(digiyLocal("pin.html"), location.origin).toString();
  }

  function getReturnUrl() {
    return location.origin + location.pathname + location.search;
  }

  function safeJsonParse(raw) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function cleanDigits(v) {
    return String(v || "").replace(/[^\d]/g, "");
  }

  function normalizeModuleCode(v) {
    const x = String(v || "").trim().toUpperCase();
    if (!x) return MODULE;
    if (MODULE_ALIASES.has(x)) return MODULE;
    return x;
  }

  function getUrl() {
    return new URL(location.href);
  }

  function getUrlSlug() {
    return String(getUrl().searchParams.get("slug") || "").trim().toLowerCase();
  }

  function getUrlPhone() {
    return cleanDigits(getUrl().searchParams.get("phone") || "");
  }

  function getSavedLastSlug() {
    return String(
      localStorage.getItem(POS_LAST_SLUG_KEY) ||
      sessionStorage.getItem(POS_LAST_SLUG_KEY) ||
      ""
    ).trim().toLowerCase();
  }

  function getSavedLastPhone() {
    return cleanDigits(
      localStorage.getItem(POS_LAST_PHONE_KEY) ||
      sessionStorage.getItem(POS_LAST_PHONE_KEY) ||
      ""
    );
  }

  function getCandidateSlug() {
    return getUrlSlug() || getSavedLastSlug() || "";
  }

  function getSb() {
    if (_sb) return _sb;

    if (window.supabase && typeof window.supabase.createClient === "function") {
      _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      });
    }

    return _sb;
  }

  function syncStateToDom() {
    document.documentElement.dataset.digiyGuardMode = state.mode;
    document.documentElement.dataset.digiyGuardReason = state.reason || "";

    if (document.body) {
      document.body.dataset.digiyGuardMode = state.mode;
      document.body.dataset.digiyGuardReason = state.reason || "";
    }
  }

  function emitGuardEvent(name) {
    try {
      window.dispatchEvent(new CustomEvent(name, {
        detail: { ...state }
      }));
    } catch (_) {}
  }

  function markState(patch) {
    Object.assign(state, patch || {});
    syncStateToDom();
    emitGuardEvent("digiy:guard-change");
  }

  function saveLastAccess(slug, phone) {
    const s = String(slug || "").trim().toLowerCase();
    const p = cleanDigits(phone || "");

    if (s) {
      localStorage.setItem(POS_LAST_SLUG_KEY, s);
      sessionStorage.setItem(POS_LAST_SLUG_KEY, s);
    }

    if (p) {
      localStorage.setItem(POS_LAST_PHONE_KEY, p);
      sessionStorage.setItem(POS_LAST_PHONE_KEY, p);
    }
  }

  function saveSession(data) {
    const sess = {
      slug: String(data.slug || "").trim().toLowerCase(),
      phone: cleanDigits(data.phone || ""),
      owner_id: data.owner_id || null,
      title: data.title || "",
      module: MODULE,
      ts: Date.now()
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    localStorage.setItem(
      ACCESS_KEY,
      JSON.stringify({
        slug: sess.slug,
        phone: sess.phone,
        owner_id: sess.owner_id,
        module: MODULE,
        ts: sess.ts
      })
    );

    saveLastAccess(sess.slug, sess.phone);

    return sess;
  }

  function loadSession() {
    const raw = localStorage.getItem(SESSION_KEY);
    const s = safeJsonParse(raw);
    if (!s) return null;

    const expired = (Date.now() - Number(s.ts || 0)) > SESSION_MAX_AGE_MS;
    if (!s.slug || !s.phone || expired) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }

    s.slug = String(s.slug || "").trim().toLowerCase();
    s.phone = cleanDigits(s.phone || "");

    if (!s.slug || !s.phone) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }

    return s;
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACCESS_KEY);
  }

  function clearRememberedAccess() {
    localStorage.removeItem(POS_LAST_SLUG_KEY);
    sessionStorage.removeItem(POS_LAST_SLUG_KEY);
    localStorage.removeItem(POS_LAST_PHONE_KEY);
    sessionStorage.removeItem(POS_LAST_PHONE_KEY);
  }

  function deriveTargetFromPage() {
    const p = location.pathname.toLowerCase();
    if (p.endsWith("/admin.html") || p.endsWith("admin.html")) return "admin";
    if (p.endsWith("/index.html") || p.endsWith("index.html")) return "hall";
    return "caisse";
  }

  function cleanUrlAfterPin(slug, phone) {
    const url = getUrl();
    url.searchParams.delete("from");
    url.searchParams.delete("module");
    url.searchParams.delete("target");
    if (slug) url.searchParams.set("slug", slug);
    if (phone) url.searchParams.set("phone", phone);
    history.replaceState({}, "", url.toString());
  }

  function goPin(slug, phone, target) {
    const u = new URL(getPinHub());
    u.searchParams.set("module", MODULE);
    u.searchParams.set("return", getReturnUrl());
    u.searchParams.set("target", String(target || deriveTargetFromPage()).trim().toLowerCase());

    if (slug) u.searchParams.set("slug", String(slug).trim().toLowerCase());
    if (phone) u.searchParams.set("phone", cleanDigits(phone));

    location.replace(u.toString());
  }

  async function rpc(fn, args) {
    const sb = getSb();
    if (!sb) throw new Error("sb_missing");

    const { data, error } = await sb.rpc(fn, args || {});
    if (error) throw error;
    return data;
  }

  async function fetchSubscriptionPublicBySlug(sb, slug) {
    const { data, error } = await sb
      .from("digiy_subscriptions_public")
      .select("slug,phone,module")
      .eq("slug", slug)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  async function verifyAccessByPhone(sb, phone) {
    try {
      const { data, error } = await sb.rpc("digiy_has_access", {
        p_phone: phone,
        p_module: MODULE
      });
      if (error) throw error;

      if (typeof data === "boolean") return data;
      if (data && typeof data.ok === "boolean") return data.ok;
      if (data && typeof data.has_access === "boolean") return data.has_access;
      if (data && typeof data.allowed === "boolean") return data.allowed;
      return !!data;
    } catch (_) {
      const { data, error } = await sb.rpc("digiy_has_access", {
        phone,
        module: MODULE
      });
      if (error) throw error;

      if (typeof data === "boolean") return data;
      if (data && typeof data.ok === "boolean") return data.ok;
      if (data && typeof data.has_access === "boolean") return data.has_access;
      if (data && typeof data.allowed === "boolean") return data.allowed;
      return !!data;
    }
  }

  async function fetchOwnerContext(sb, slug) {
    try {
      const { data, error } = await sb
        .from("digiy_subscriptions")
        .select("owner_id,title,slug,module")
        .eq("slug", slug)
        .limit(1)
        .maybeSingle();

      if (error) return { owner_id: null, title: "" };
      return {
        owner_id: data?.owner_id || null,
        title: data?.title || ""
      };
    } catch (_) {
      return { owner_id: null, title: "" };
    }
  }

  async function verifyWithSupabase(slug) {
    const sb = getSb();
    if (!sb) return { ok: false, reason: "sb_missing" };

    const s = String(slug || "").trim().toLowerCase();
    if (!s) return { ok: false, reason: "slug_missing" };

    let subRow = null;
    try {
      subRow = await fetchSubscriptionPublicBySlug(sb, s);
    } catch (_) {
      return { ok: false, reason: "slug_lookup_failed" };
    }

    if (!subRow?.phone) {
      return { ok: false, reason: "slug_not_found" };
    }

    const rowModule = normalizeModuleCode(subRow.module);
    if (subRow.module && rowModule !== MODULE) {
      return { ok: false, reason: "module_mismatch" };
    }

    const phone = cleanDigits(subRow.phone);
    if (!phone) {
      return { ok: false, reason: "phone_missing" };
    }

    let accessOk = false;
    try {
      accessOk = await verifyAccessByPhone(sb, phone);
    } catch (_) {
      return { ok: false, reason: "access_check_failed" };
    }

    if (!accessOk) {
      return { ok: false, reason: "no_access" };
    }

    const owner = await fetchOwnerContext(sb, s);

    return {
      ok: true,
      slug: s,
      phone,
      owner_id: owner.owner_id || null,
      title: owner.title || ""
    };
  }

  function setPreview(reason, extra) {
    markState({
      slug: String(extra?.slug || "").trim().toLowerCase(),
      phone: cleanDigits(extra?.phone || ""),
      owner_id: extra?.owner_id || null,
      title: extra?.title || "",
      hasAccess: false,
      mode: reason === "no_access" || reason === "module_mismatch" ? "locked" : "preview",
      reason: reason || "preview",
      checkedAt: new Date().toISOString()
    });
  }

  function setLive(verified, reason, fromPin) {
    saveSession(verified);

    markState({
      slug: verified.slug,
      phone: verified.phone,
      owner_id: verified.owner_id || null,
      title: verified.title || "",
      hasAccess: true,
      mode: "live",
      reason: reason || "live",
      fromPin: !!fromPin,
      checkedAt: new Date().toISOString()
    });
  }

  async function checkAccess(slugOverride) {
    const candidateSlug = String(slugOverride || state.slug || getCandidateSlug()).trim().toLowerCase();

    if (!candidateSlug) {
      setPreview("no_slug");
      return { ok: false, reason: "no_slug", ...state };
    }

    const verified = await verifyWithSupabase(candidateSlug);
    if (verified.ok) {
      setLive(verified, "verified", false);

      const currentUrl = getUrl();
      if (!currentUrl.searchParams.get("slug")) currentUrl.searchParams.set("slug", verified.slug);
      if (!currentUrl.searchParams.get("phone") && verified.phone) currentUrl.searchParams.set("phone", verified.phone);
      history.replaceState({}, "", currentUrl.toString());

      return { ok: true, reason: "verified", ...state };
    }

    setPreview(verified.reason || "verify_failed", {
      slug: candidateSlug,
      phone: getSavedLastPhone() || getUrlPhone() || ""
    });

    return { ok: false, reason: verified.reason || "verify_failed", ...state };
  }

  async function refresh() {
    return boot({ force: true });
  }

  async function boot(opts) {
    const force = !!(opts && opts.force);
    const url = getUrl();
    const from = String(url.searchParams.get("from") || "").trim().toLowerCase();
    const fromPin = from === "pin" || from === "pin_royal";
    const urlSlug = getUrlSlug();
    const urlPhone = getUrlPhone();
    const urlModule = normalizeModuleCode(url.searchParams.get("module") || MODULE);

    if (!getSb()) {
      setPreview("sb_missing", {
        slug: urlSlug || getSavedLastSlug(),
        phone: urlPhone || getSavedLastPhone()
      });
      return { ok: false, reason: "sb_missing", ...state };
    }

    // 1) Retour PIN
    if (fromPin && urlModule === MODULE) {
      const candidateSlug = urlSlug || getSavedLastSlug();
      if (!candidateSlug) {
        setPreview("from_pin_no_slug", { phone: urlPhone || getSavedLastPhone() });
        return { ok: false, reason: "from_pin_no_slug", ...state };
      }

      const verified = await verifyWithSupabase(candidateSlug);
      if (verified.ok) {
        setLive(verified, "from_pin_ok", true);
        cleanUrlAfterPin(verified.slug, verified.phone);
        return { ok: true, reason: "from_pin_ok", ...state };
      }

      setPreview(verified.reason || "from_pin_fail", {
        slug: candidateSlug,
        phone: urlPhone || getSavedLastPhone()
      });
      return { ok: false, reason: verified.reason || "from_pin_fail", ...state };
    }

    // 2) Session locale courte
    if (!force) {
      const cached = loadSession();
      if (cached) {
        const candidateSlug = urlSlug || getSavedLastSlug();
        if (candidateSlug && candidateSlug !== cached.slug) {
          clearSession();
        } else {
          saveLastAccess(cached.slug, cached.phone);

          markState({
            slug: cached.slug,
            phone: cached.phone,
            owner_id: cached.owner_id || null,
            title: cached.title || "",
            hasAccess: true,
            mode: "live",
            reason: "cached",
            fromPin: false,
            checkedAt: new Date().toISOString()
          });

          if (!urlSlug) {
            const clean = getUrl();
            clean.searchParams.set("slug", cached.slug);
            if (cached.phone) clean.searchParams.set("phone", cached.phone);
            history.replaceState({}, "", clean.toString());
          }

          return { ok: true, reason: "cached", ...state };
        }
      }
    }

    // 3) Slug direct ou slug mémorisé
    const candidateSlug = getCandidateSlug();
    if (candidateSlug) {
      const verified = await verifyWithSupabase(candidateSlug);

      if (verified.ok) {
        setLive(verified, "slug_ok", false);

        const clean = getUrl();
        if (!getUrlSlug()) clean.searchParams.set("slug", verified.slug);
        if (!getUrlPhone() && verified.phone) clean.searchParams.set("phone", verified.phone);
        history.replaceState({}, "", clean.toString());

        return { ok: true, reason: "slug_ok", ...state };
      }

      setPreview(verified.reason || "slug_fail", {
        slug: candidateSlug,
        phone: urlPhone || getSavedLastPhone()
      });

      return { ok: false, reason: verified.reason || "slug_fail", ...state };
    }

    // 4) Aucun slug => preview libre
    setPreview("no_slug");
    return { ok: false, reason: "no_slug", ...state };
  }

  function openPin(target, slugOverride, phoneOverride) {
    const slug = String(slugOverride || state.slug || getCandidateSlug() || "").trim().toLowerCase();
    const phone = cleanDigits(phoneOverride || state.phone || getSavedLastPhone() || "");
    goPin(slug, phone, target || deriveTargetFromPage());
  }

  function logout(redirectTo) {
    clearSession();

    if (redirectTo) {
      location.replace(redirectTo);
      return;
    }

    clearRememberedAccess();
    markState({
      slug: "",
      phone: "",
      owner_id: null,
      title: "",
      hasAccess: false,
      mode: "preview",
      reason: "logout",
      fromPin: false,
      checkedAt: new Date().toISOString()
    });
  }

  window.DIGIY_GUARD = {
    ready,
    state,
    boot,
    refresh,
    checkAccess,
    rpc,
    openPin,
    logout,
    getSb,
    getSession: () => safeJsonParse(localStorage.getItem(SESSION_KEY))
  };

  (async function init() {
    try {
      await boot({ force: false });
    } finally {
      state.ready = true;
      syncStateToDom();
      emitGuardEvent("digiy:guard-ready");
      if (_readyResolve) _readyResolve(state);
    }
  })();
})();
