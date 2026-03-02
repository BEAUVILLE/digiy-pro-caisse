(async function(){
  "use strict";

  const SUPABASE_URL = "https://wesqmwjjtsefyjnluosj.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indlc3Ftd2pqdHNlZnlqbmx1b3NqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxNzg4ODIsImV4cCI6MjA4MDc1NDg4Mn0.dZfYOc2iL2_wRYL3zExZFsFSBK6AbMeOid2LrIjcTdA";

  const PIN_HUB = "https://beauville.github.io/digiy-qr-pro/pin.html";
  const MODULE  = "POS"; // ✅ CAISSE PRO = POS

  const url = new URL(location.href);
  const slug = (url.searchParams.get("slug") || "").trim();

  function goPin(){
    const ret = encodeURIComponent(location.origin + location.pathname + (slug ? ("?slug="+encodeURIComponent(slug)) : ""));
    const u = `${PIN_HUB}?module=${encodeURIComponent(MODULE)}&return=${ret}` + (slug ? `&slug=${encodeURIComponent(slug)}` : "");
    location.replace(u);
  }

  if(!slug){ goPin(); return; }

  if(!window.supabase || typeof window.supabase.createClient !== "function"){
    goPin(); return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth:{ persistSession:false, autoRefreshToken:false, detectSessionInUrl:false }
  });

  // slug -> phone (POS)
  const { data: rows, error: e1 } = await sb
    .from("digiy_subscriptions_public")
    .select("phone")
    .eq("slug", slug)
    .eq("module", MODULE)
    .limit(1);

  if(e1 || !rows?.[0]?.phone){ goPin(); return; }
  const phone = String(rows[0].phone);

  // access (POS)
  const { data: ok, error: e2 } = await sb.rpc("digiy_has_access", {
    p_phone: phone,
    p_module: MODULE
  });

  if(e2 || !ok){ goPin(); return; }

  // ✅ OK -> on laisse passer, FIN (pas de redirection paiement)
  localStorage.setItem("DIGIY_ACCESS", JSON.stringify({ slug, phone, module: MODULE, ts: Date.now() }));
})();
