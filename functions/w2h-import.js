// functions/w2h-import.js
// Sichere Server-Funktion: prüft Supabase-Login, nutzt GitHub-Token aus ENV.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// 🔢 NEU: konfigurierbares, weicheres Limit für place_ids.json
// Früher: hart auf 10 begrenzt. Jetzt 50 (bei Bedarf leicht anpassbar).
const MAX_PLACE_IDS = 50;

export async function handler(event, context) {
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS };
  }
  if (event.httpMethod !== "POST") {
    return resp(405, "Method Not Allowed");
  }

  // --- 1) Auth: Supabase-JWT prüfen (ohne externe Pakete) ---
  try {
    await assertSupabaseUser(event.headers.authorization);
  } catch (e) {
    return resp(401, `Unauthorized: ${e.message}`);
  }

  // --- 2) Payload lesen ---
  let body = {};
  try {
    body = JSON.parse(event.body || "{}") || {};
  } catch {}
  const { action, payload } = body;

  // --- 3) GitHub-Konfiguration aus ENV ---
  const token  = process.env.GITHUB_TOKEN;
  const repo   = process.env.GITHUB_REPO   || "Sailbuddy/w2h-places-import";
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!token) return resp(500, "Missing GITHUB_TOKEN");

  try {
    // A) Place ID in data/place_ids.json anhängen
    if (action === "appendPlaceId") {
      if (!payload?.placeId) return resp(400, "Missing placeId");
      const path = "data/place_ids.json";

      const file = await gh(`/repos/${repo}/contents/${path}?ref=${branch}`, token);
      const list = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));

      // Optionales Limit – jetzt weicher: MAX_PLACE_IDS statt fix 10
      if (Array.isArray(list) && list.length >= MAX_PLACE_IDS) {
        return resp(
          409,
          `Liste voll – bitte Import starten. (Limit: ${MAX_PLACE_IDS} Einträge)`
        );
      }

      // Duplikate vermeiden (falls schon drin)
      if (list.some(e => (e.placeId || e) === payload.placeId)) {
        return resp(200, { ok: true, count: list.length, note: "already-present" });
      }

      // Datensatz-Form flexibel: entweder nur ID oder Objekt mit preferredName
      const entry = payload.preferredName
        ? { placeId: payload.placeId, preferredName: payload.preferredName }
        : payload.placeId;

      const next = [...list, entry];
      await gh(`/repos/${repo}/contents/${path}`, token, "PUT", {
        message: `append placeId ${payload.placeId}`,
        content: Buffer.from(JSON.stringify(next, null, 2)).toString("base64"),
        sha: file.sha,
        branch
      });

      // Optional: auch ins Archiv schreiben (wenn vorhanden)
      try {
        const apath = "data/place_ids_archive.json";
        let arch = [];
        try {
          const afile = await gh(`/repos/${repo}/contents/${apath}?ref=${branch}`, token);
          arch = JSON.parse(Buffer.from(afile.content, "base64").toString("utf8"));
          await gh(`/repos/${repo}/contents/${apath}`, token, "PUT", {
            message: `archive placeId ${payload.placeId}`,
            content: Buffer.from(JSON.stringify([...arch, entry], null, 2)).toString("base64"),
            sha: afile.sha,
            branch
          });
        } catch {
          // Archiv existiert evtl. nicht – ignorieren
        }
      } catch {
        // soft-fail
      }

      return resp(200, { ok: true, count: next.length });
    }

    // B) GitHub Action manuell starten
    if (action === "dispatchImport") {
      // 👉 Default jetzt: FULL-Workflow, der mit place_ids.json arbeitet
      const workflow =
        process.env.GITHUB_WORKFLOW_FILE || "import_places_manual_full.yml";

      await gh(
        `/repos/${repo}/actions/workflows/${workflow}/dispatches`,
        token,
        "POST",
        { ref: branch }
      );

      return resp(200, { triggered: true, workflow, branch });
    }

    return resp(400, "Unknown action");
  } catch (e) {
    return resp(500, String(e));
  }
}

function resp(status, body) {
  return {
    statusCode: status,
    headers: CORS,
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}

// --- Supabase-User prüfen, ohne jose ---
// Wir fragen Supabase: /auth/v1/user  (braucht Bearer <access_token> + apikey=ANON_KEY)
async function assertSupabaseUser(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("No bearer token");
  }
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase env missing");
  }
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      "Authorization": authHeader,
      "apikey": SUPABASE_ANON_KEY
    }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`supabase user check failed: ${r.status} ${t}`);
  }
  // optional: user = await r.json();
}

// --- GitHub Helper ---
async function gh(path, token, method = "GET", body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${t}`);
  }
  if (res.status === 204) return {};
  return res.json();
}
