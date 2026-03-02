/**
 * DIGIY GUARD PRO â€” v2026-03-02 (POS / slug-first)
 * Objectif: ne PLUS boucler vers PIN si l'abonnement est actif.
 * Source de vÃ©ritÃ©: digiy_subscriptions_public (slug->phone) + digiy_has_access(phone,module).
 * owner_id: tentÃ© via digiy_subscriptions (si RLS l'autorise). Sinon fallback minimal.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://wesqmwjjtsefyjnluosj.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indlc3Ftd2pqdHNlZnlqbmx1b3NqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxNzg4ODIsImV4cCI6MjA4MDc1NDg4Mn0.dZfYOc2iL2_wRYL3zExZFsFSBK6AbMeOid2LrIjcTdA";

  const MODULE = "POS";
  const SESSION_KEY = "DIGIY_GUARD_POS";
  const PIN_HUB = "https://beauville.github.io/digiy-qr-pro/pin.html";

  // retourne exactement sur la page courante
  const RETURN_URL = location.origin + location.pathname + location.search;

  let _sb = null;
  let _session = null;

  function getSb() {
    if (_sb) return _sb;
    if (window.supabase && typeof window.supabase.createClient === "function") {
      _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
    }
    return _sb;
  }

  function saveSession(data) {
    const sess = {
      slug: data.slug || "",
      phone: data.phone || "",
      owner_id: data.owner_id || null,
      title: data.title || "",
      module: MODULE,
      ts: Date.now(),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    localStorage.setItem(
      "DIGIY_ACCESS",
      JSON.stringify({ slug: sess.slug, phone: sess.phone, owner_id: sess.owner_id, module: MODULE, ts: sess.ts })
    );
    _session = sess;
    return sess;
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      const maxAge = 12 * 3600 * 1000; // 12h
      if (!s || !s.slug || !s.phone || (Date.now() - (s.ts || 0)) > maxAge) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      return s;
    } catch (_) {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem("DIGIY_ACCESS");
    _session = null;
  }

  function goPin(slug) {
    const u = new URL(PIN_HUB);
    u.searchParams.set("module", MODULE);
    u.searchParams.set("return", RETURN_URL);
    if (slug) u.searchParams.set("slug", slug);
    location.replace(u.toString());
  }

  async function verifyWithSupabase(slug) {
    const sb = getSb();
    if (!sb) return { ok: false, reason: "sb_missing" };

    const s = String(slug || "").trim();
    if (!s) return { ok: false, reason: "slug_missing" };

    // 1) slug -> phone (vue publique)
    const { data: subRow, error: e1 } = await sb
      .from("digiy_subscriptions_public")
      .select("phone")
      .eq("slug", s)
      .eq("module", MODULE)
      .maybeSingle();

    if (e1 || !subRow?.phone) return { ok: false, reason: "slug_not_found" };
    const phone = String(subRow.phone);

    // 2) accÃ¨s
    const { data: accessOk, error: e2 } = await sb.rpc("digiy_has_access", { p_phone: phone, p_module: MODULE });
    if (e2 || !accessOk) return { ok: false, reason: "no_access" };

    // 3) owner_id (tentative via digiy_subscriptions)
    //    âš ï¸ Si RLS refuse, on continue quand mÃªme (owner_id null) : le POS peut afficher "mode limitÃ©"
    let owner_id = null;
    let title = "";

    try {
      const { data: srow, error: e3 } = await sb
        .from("digiy_subscriptions")
        .select("owner_id,title")
        .eq("slug", s)
        .eq("module", MODULE)
        .maybeSingle();

      if (!e3 && srow) {
        owner_id = srow.owner_id || null;
        title = srow.title || "";
      }
    } catch (_) {}

    return { ok: true, slug: s, phone, owner_id, title };
  }

  async function boot() {
    const url = new URL(location.href);

    const fromPin = url.searchParams.get("from") === "pin_royal";
    const urlSlug = (url.searchParams.get("slug") || "").trim();
    const urlModule = (url.searchParams.get("module") || "").toUpperCase();

    // 1) retour pin
    if (fromPin && urlSlug && (urlModule === MODULE || !urlModule)) {
      const verified = await verifyWithSupabase(urlSlug);
      if (verified.ok) {
        saveSession(verified);

        url.searchParams.delete("from");
        url.searchParams.delete("module");
        url.searchParams.set("slug", verified.slug);
        history.replaceState({}, "", url.toString());

        return { ok: true, reason: "from_pin_ok", owner_id: verified.owner_id || null };
      }
      goPin(urlSlug);
      return { ok: false, reason: verified.reason || "from_pin_fail" };
    }

    // 2) cache
    const cached = loadSession();
    if (cached) {
      if (urlSlug && urlSlug !== cached.slug) {
        clearSession();
      } else {
        _session = cached;
        return { ok: true, reason: "cached" };
      }
    }

    // 3) slug direct
    if (urlSlug) {
      const verified = await verifyWithSupabase(urlSlug);
      if (verified.ok) {
        saveSession(verified);
        return { ok: true, reason: "slug_ok", owner_id: verified.owner_id || null };
      }
      goPin(urlSlug);
      return { ok: false, reason: verified.reason || "slug_fail" };
    }

    // 4) rien
    goPin("");
    return { ok: false, reason: "no_slug" };
  }

  function logout(redirectTo) {
    clearSession();
    location.replace(redirectTo || PIN_HUB);
  }

  window.DIGIY_GUARD = {
    boot,
    logout,
    getSb,
    getSession: () => _session,
  };
})();
