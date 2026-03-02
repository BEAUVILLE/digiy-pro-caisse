/**
 * DIGIY GUARD PRO — v2026-03-02
 * Définit window.DIGIY_GUARD pour DIGIY CAISSE PRO
 * Module : POS | PIN HUB : digiy-qr-pro
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://wesqmwjjtsefyjnluosj.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indlc3Ftd2pqdHNlZnlqbmx1b3NqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxNzg4ODIsImV4cCI6MjA4MDc1NDg4Mn0.dZfYOc2iL2_wRYL3zExZFsFSBK6AbMeOid2LrIjcTdA";

  const MODULE      = "POS";
  const SESSION_KEY = "DIGIY_GUARD_POS";
  const PIN_HUB     = "https://beauville.github.io/digiy-qr-pro/pin.html";
  const RETURN_URL  = location.origin + location.pathname;

  let _sb = null;
  let _session = null;

  // ─── Supabase lazy init ─────────────────────────────
  function getSb() {
    if (_sb) return _sb;
    if (window.supabase && typeof window.supabase.createClient === "function") {
      _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
    }
    return _sb;
  }

  // ─── Session helpers ────────────────────────────────
  function saveSession(data) {
    const sess = {
      slug:       data.slug     || "",
      phone:      data.phone    || "",
      owner_id:   data.owner_id || null,
      title:      data.title    || "",
      module:     MODULE,
      ts:         Date.now()
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    localStorage.setItem("DIGIY_ACCESS", JSON.stringify({
      slug: sess.slug, phone: sess.phone, owner_id: sess.owner_id, module: MODULE, ts: sess.ts
    }));
    _session = sess;
    return sess;
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      // Session expire après 12h
      if (!s || !s.owner_id || (Date.now() - (s.ts || 0)) > 12 * 3600 * 1000) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      return s;
    } catch (_) { return null; }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem("DIGIY_ACCESS");
    _session = null;
  }

  // ─── Redirect vers PIN HUB ──────────────────────────
  function goPin(slug) {
    const u = new URL(PIN_HUB);
    u.searchParams.set("module", MODULE);
    u.searchParams.set("return", RETURN_URL);
    if (slug) u.searchParams.set("slug", slug);
    location.replace(u.toString());
  }

  // ─── Vérification Supabase ──────────────────────────
  async function verifyWithSupabase(slug) {
    const sb = getSb();
    if (!sb) return null;

    // 1) slug → phone
    const { data: rows, error: e1 } = await sb
      .from("digiy_subscriptions_public")
      .select("phone")
      .eq("slug", slug)
      .eq("module", MODULE)
      .limit(1);

    if (e1 || !rows?.[0]?.phone) return null;
    const phone = String(rows[0].phone);

    // 2) has_access
    const { data: ok, error: e2 } = await sb.rpc("digiy_has_access", {
      p_phone: phone,
      p_module: MODULE
    });

    if (e2 || !ok) return null;

    // 3) owner_id via digiy_owners
    const { data: owner } = await sb
      .from("digiy_owners")
      .select("owner_id, title")
      .eq("slug", slug)
      .maybeSingle();

    return {
      slug,
      phone,
      owner_id: owner?.owner_id || null,
      title:    owner?.title    || ""
    };
  }

  // ─── BOOT ────────────────────────────────────────────
  async function boot() {
    const url = new URL(location.href);

    // 1) Paramètres URL après retour depuis PIN HUB
    const fromPin = url.searchParams.get("from") === "pin_royal";
    const urlSlug = (url.searchParams.get("slug") || "").trim();
    const urlModule = (url.searchParams.get("module") || "").toUpperCase();

    if (fromPin && urlSlug && (urlModule === MODULE || !urlModule)) {
      // Vérifier avec Supabase
      const verified = await verifyWithSupabase(urlSlug);
      if (verified) {
        _session = saveSession(verified);
        // Nettoyer l'URL (retirer from=pin_royal)
        url.searchParams.delete("from");
        url.searchParams.delete("module");
        url.searchParams.set("slug", urlSlug);
        history.replaceState({}, "", url.toString());
        return { ok: true };
      }
      // Vérif échouée → retour PIN
      goPin(urlSlug);
      return { ok: false };
    }

    // 2) Session localStorage encore valide ?
    const cached = loadSession();
    if (cached) {
      // Si slug en URL, vérifier qu'il correspond
      if (urlSlug && urlSlug !== cached.slug) {
        clearSession();
      } else {
        _session = cached;
        return { ok: true };
      }
    }

    // 3) Slug en URL → vérifier Supabase directement
    if (urlSlug) {
      const verified = await verifyWithSupabase(urlSlug);
      if (verified) {
        _session = saveSession(verified);
        return { ok: true };
      }
      goPin(urlSlug);
      return { ok: false };
    }

    // 4) Rien → PIN HUB sans slug
    goPin("");
    return { ok: false };
  }

  // ─── LOGOUT ─────────────────────────────────────────
  function logout(redirectTo) {
    clearSession();
    location.replace(redirectTo || PIN_HUB);
  }

  // ─── API publique ────────────────────────────────────
  window.DIGIY_GUARD = {
    boot,
    logout,
    getSb,
    getSession: () => _session
  };

})();
