/* guard-pro.js — CAISSE PRO (alias POS) */
(async function(){
  "use strict";

  const SUPABASE_URL = "https://wesqmwjjtsefyjnluosj.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indlc3Ftd2pqdHNlZnlqbmx1b3NqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxNzg4ODIsImV4cCI6MjA4MDc1NDg4Mn0.dZfYOc2iL2_wRYL3zExZFsFSBK6AbMeOid2LrIjcTdA";

  const PIN_HUB = "https://beauville.github.io/qr_pro/pin.html";
  const PAY_URL = "https://beauville.github.io/commencer-a-payer/"; // si tu veux fallback paiement

  // ✅ IMPORTANT : CAISSE PRO = POS (source de vérité)
  const MODULE = "POS";

  const url = new URL(location.href);
  const slug = (url.searchParams.get("slug") || "").trim();

  const ret = encodeURIComponent(location.origin + location.pathname + (slug ? ("?slug="+encodeURIComponent(slug)) : ""));

  function goPin(){
    const u = `${PIN_HUB}?module=${encodeURIComponent(MODULE)}&return=${ret}` + (slug ? `&slug=${encodeURIComponent(slug)}` : "");
    location.replace(u);
  }

  function goPay(){
    // fallback paiement propre (si tu veux)
    const u = new URL(PAY_URL);
    u.searchParams.set("module", "POS"); // ✅ jamais CAISSE
    if(slug) u.searchParams.set("slug", slug);
    u.searchParams.set("return", location.origin + location.pathname);
    location.replace(u.toString());
  }

  // 0) slug absent => PIN HUB en mode rescue
  if(!slug){
    goPin();
    return;
  }

  // 1) Supabase lib check
  if(!window.supabase || typeof window.supabase.createClient !== "function"){
    console.error("Supabase JS missing");
    goPin();
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth:{ persistSession:false, autoRefreshToken:false, detectSessionInUrl:false }
  });

  // 2) slug -> phone (view publique) SUR POS
  const { data: rows, error: e1 } = await sb
    .from("digiy_subscriptions_public")
    .select("phone,slug,module")
    .eq("slug", slug)
    .eq("module", MODULE)
    .limit(1);

  if(e1 || !rows || !rows[0] || !rows[0].phone){
    console.warn("slug->phone not found for POS", e1, rows);
    goPin();
    return;
  }

  const phone = String(rows[0].phone);

  // 3) check access SUR POS
  const { data: ok, error: e2 } = await sb.rpc("digiy_has_access", {
    p_phone: phone,
    p_module: MODULE
  });

  if(e2 || !ok){
    console.warn("no access POS", e2, ok);

    // ✅ priorité PIN HUB (plutôt que paiement direct)
    goPin();

    // (optionnel) ou paiement si tu veux forcer:
    // goPay();
    return;
  }

  // ✅ 4) accès OK => on bloque toute redirection paiement
  localStorage.setItem("DIGIY_ACCESS", JSON.stringify({ slug, phone, module: MODULE, ts: Date.now() }));
  // fini. pas de redirect.

})();
