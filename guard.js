/* guard.js — DIGIY UNIVERSAL SUBSCRIPTION GUARD */
(function(){
  "use strict";
  const SUPABASE_URL = "https://wesqmwjjtsefyjnluosj.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indlc3Ftd2pqdHNlZnlqbmx1b3NqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxNzg4ODIsImV4cCI6MjA4MDc1NDg4Mn0.dZfYOc2iL2_wRYL3zExZFsFSBK6AbMeOid2LrIjcTdA";
  const PAY_URL = "https://beauville.github.io/commencer-a-payer/";
  const path = location.pathname || "/";
  const parts = path.split("/").filter(Boolean);
  const BASE = (parts.length >= 1) ? ("/" + parts[0]) : "";
  function normalizePhone(p){ return String(p || "").replace(/[^\d+]/g, ""); }
  function nowMs(){ return Date.now(); }
  function cacheKey(phone, module){ return `digiy_access:${phone}:${module}`; }
  function cacheGet(phone, module){
    try{
      const raw = sessionStorage.getItem(cacheKey(phone,module));
      if(!raw) return null;
      const obj = JSON.parse(raw);
      if(obj?.ok && obj?.exp && obj.exp > nowMs()) return true;
      return null;
    }catch(_){ return null; }
  }
  function cacheSet(phone, module, seconds){
    try{
      sessionStorage.setItem(cacheKey(phone,module), JSON.stringify({
        ok: true,
        exp: nowMs() + (seconds * 1000)
      }));
    }catch(_){}
  }
  function say(msg){
    const el = document.getElementById("guard_status");
    if(el) el.textContent = msg;
    console.log("🔐 GUARD:", msg);
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.error("❌ Supabase JS non chargé");
    return;
  }
  const supabase = window.__sb || window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.__sb = supabase;
  async function getPhone(){
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const p = session?.user?.phone || session?.user?.user_metadata?.phone || session?.user?.user_metadata?.phone_number || session?.user?.identities?.[0]?.identity_data?.phone || "";
      const phone = normalizePhone(p);
      if (phone) return phone;
    } catch(e){ console.warn("⚠️ getSession error:", e); }
    const s = normalizePhone(sessionStorage.getItem("digiy_driver_phone"));
    if (s) return s;
    try{
      const a = JSON.parse(localStorage.getItem("digiy_driver_access_pin") || "null");
      const p = normalizePhone(a?.phone);
      if (p) return p;
    }catch(_){}
    return null;
  }
  async function isActive(phone, module){
    const cached = cacheGet(phone, module);
    if (cached) { console.log("✅ Cache hit:", module); return true; }
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase.from("digiy_subscriptions").select("id, plan, current_period_end").eq("phone", phone).eq("module", module).eq("status", "active").gt("current_period_end", nowIso).limit(1).maybeSingle();
    if (error) { console.error("❌ DB error:", error); throw error; }
    const ok = !!data?.id;
    if (ok) {
      console.log("✅ Abonnement trouvé:", { module, plan: data.plan, expire: new Date(data.current_period_end).toLocaleDateString('fr-FR') });
      cacheSet(phone, module, 60);
    } else {
      console.log("❌ Pas d'abonnement actif pour:", module);
    }
    return ok;
  }
  window.DIGIY = {
    BASE, PAY_URL, getPhone,
    async guardOrPay(module, loginPath){
      say("Vérification...");
      const phone = await getPhone();
      if(!phone){
        say("❌ Connexion requise");
        console.log("❌ Pas de phone → Redirection login");
        const target = loginPath ? (loginPath.startsWith("http") ? loginPath : (BASE + loginPath)) : (BASE + "/login.html");
        setTimeout(() => {
          location.replace(target + (target.includes("?") ? "&" : "?") + "redirect=" + encodeURIComponent(location.href));
        }, 1000);
        return false;
      }
      console.log("✅ Phone:", phone);
      say("Vérification abonnement...");
      window.DIGIY_ACCESS = { phone, module };
      try{
        const ok = await isActive(phone, module);
        if(!ok){
          say("❌ Abonnement requis");
          setTimeout(() => {
            location.replace(PAY_URL + "?phone=" + encodeURIComponent(phone) + "&module=" + encodeURIComponent(module) + "&from=" + encodeURIComponent(location.href));
          }, 1500);
          return false;
        }
        say("✅ Accès autorisé");
        console.log("✅ Accès OK pour:", module);
        document.documentElement.classList.add("access-ok");
        window.DIGIY_ACCESS.ok = true;
        setTimeout(() => {
          const el = document.getElementById("guard_status");
          if(el) el.style.display = "none";
        }, 2000);
        return true;
      }catch(e){
        console.error("❌ Guard error:", e);
        say("❌ Erreur vérification");
        setTimeout(() => {
          location.replace(PAY_URL + "?err=verify&from=" + encodeURIComponent(location.href));
        }, 1500);
        return false;
      }
    }
  };
})();
