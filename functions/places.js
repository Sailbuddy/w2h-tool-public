// functions/places.js
// Hybrid-Suche: erst "legacy" FindPlace (wie früher), dann robuste Fallbacks,
// anschließend Upload in w2h-places-import (mit 409-Retry).

exports.handler = async function (event) {
  const input = (event.queryStringParameters?.input || "").trim();
  const preferredName = event.queryStringParameters?.name || null;
  const lang = (event.queryStringParameters?.lang || "").trim();     // optional: de|en|it|hr|fr
  const country = (event.queryStringParameters?.country || "").trim(); // optional: at|si|hr|it|de...
  const near = (event.queryStringParameters?.near || "").trim();       // optional: "lat,lng"

  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const GH_TOKEN = process.env.GH_TOKEN;
  const GH_OWNER = "Sailbuddy";
  const GH_REPO = "w2h-places-import";
  const PATH_MAIN = "data/place_ids.json";
  const PATH_ARCHIVE = "data/place_ids_archive.json";

  if (!input) return json(400, { ok: false, error: "input missing" });
  if (!GOOGLE_API_KEY) return json(500, { ok: false, error: "GOOGLE_API_KEY missing" });
  if (!GH_TOKEN) return json(500, { ok: false, error: "GH_TOKEN missing" });

  try {
    let candidate = null;
    const tried = [];

    // ---------- A) Legacy FindPlace (GENAU wie deine alte Version) ----------
    tried.push("findplace:legacy");
    {
      const u = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(input)}&inputtype=textquery&key=${GOOGLE_API_KEY}`;
      const r = await fetch(u);
      const d = await r.json();
      if (d.status === "OK" && d.candidates?.length) candidate = d.candidates[0];
    }

    // ---------- B) FindPlace mit Bias + optional lang/country ----------
    if (!candidate) {
      tried.push("findplace:biased");
      const url = new URL("https://maps.googleapis.com/maps/api/place/findplacefromtext/json");
      url.searchParams.set("input", input);
      url.searchParams.set("inputtype", "textquery");
      // KEINE fields → wir lassen Google frei matchen (wie im Legacy-Call)
      url.searchParams.set("locationbias", "ipbias");
      if (lang) url.searchParams.set("language", lang);
      if (country) url.searchParams.set("region", country);
      url.searchParams.set("key", GOOGLE_API_KEY);

      const r = await fetch(url);
      const d = await r.json();
      if (d.status === "OK" && d.candidates?.length) candidate = d.candidates[0];
    }

    // ---------- C) Text Search Fallback ----------
    if (!candidate) {
      tried.push("textsearch");
      const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
      url.searchParams.set("query", input);
      if (lang) url.searchParams.set("language", lang);
      if (country) url.searchParams.set("region", country);
      url.searchParams.set("key", GOOGLE_API_KEY);

      const r = await fetch(url);
      const d = await r.json();
      if (d.status === "OK" && d.results?.length) candidate = d.results[0];
    }

    // ---------- D) Nearby (wenn near=lat,lng übergeben) ----------
    if (!candidate && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(near)) {
      tried.push("nearby");
      const [lat, lng] = near.split(",").map(s => s.trim());
      const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
      url.searchParams.set("location", `${lat},${lng}`);
      url.searchParams.set("radius", "3000");
      url.searchParams.set("keyword", input);
      if (lang) url.searchParams.set("language", lang);
      url.searchParams.set("key", GOOGLE_API_KEY);

      const r = await fetch(url);
      const d = await r.json();
      if (d.status === "OK" && d.results?.length) candidate = d.results[0];
    }

    if (!candidate?.place_id) {
      return json(404, { ok: false, tried, hint: "Optional country=at|si|hr & lang=de|…; ggf. near=lat,lng verwenden." });
    }

    const placeId = candidate.place_id;
    const name = preferredName || candidate.name || null;

    // ---------- Upload nach GitHub mit 409-Retry ----------
    const ghHeaders = { Authorization: `token ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" };

    const getContent = async (path) => {
      const u = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`;
      const r = await fetch(u, { headers: ghHeaders });
      if (r.status === 404) return { sha: null, json: [] };
      if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
      const d = await r.json();
      const content = Buffer.from(d.content || "", d.encoding || "base64").toString("utf8");
      let parsed; try { parsed = JSON.parse(content); } catch { parsed = []; }
      return { sha: d.sha, json: parsed };
    };

    const putContent = async (path, contentJson, message, sha = null) => {
      const u = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`;
      const body = {
        message,
        content: Buffer.from(JSON.stringify(contentJson, null, 2)).toString("base64"),
        committer: { name: "w2h-bot", email: "bot@wind2horizon.com" },
        author: { name: "w2h-bot", email: "bot@wind2horizon.com" },
      };
      if (sha) body.sha = sha;
      const r = await fetch(u, { method: "PUT", headers: { ...ghHeaders, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 409) return { conflict: true };
      if (!r.ok) throw new Error(`PUT ${path}: ${r.status} ${await r.text()}`);
      return { conflict: false, data: await r.json() };
    };

    const safeUpdate = async (path, updater, msg) => {
      let { sha, json: cur } = await getContent(path);
      let next = updater(cur);
      let res = await putContent(path, next, msg, sha);
      if (res.conflict) {
        const fresh = await getContent(path);
        next = updater(fresh.json);
        res = await putContent(path, next, msg, fresh.sha);
      }
      return res;
    };

    const mainUpdater = (arr) => {
      const a = Array.isArray(arr) ? arr : [];
      const exists = a.some(x => (typeof x === "string" ? x === placeId : x?.placeId === placeId));
      if (!exists) {
        if (a.every(x => typeof x === "string")) a.push(placeId);
        else a.push({ placeId, preferredName: name });
      }
      return a;
    };
    const archiveUpdater = (arr) => {
      const a = Array.isArray(arr) ? arr : [];
      if (a.every(x => typeof x === "string")) a.push(placeId);
      else a.push({ placeId, preferredName: name, addedAt: new Date().toISOString() });
      return a;
    };

    const stamp = new Date().toISOString();
    const mainRes = await safeUpdate(PATH_MAIN, mainUpdater, `W2H Live Fetch Upload ${stamp} – ${name || input}`);
    const archRes = await safeUpdate(PATH_ARCHIVE, archiveUpdater, `append ${placeId} to place_ids_archive.json`);

    return json(200, {
      ok: true,
      input,
      params: { lang: lang || null, country: country || null, near: near || null },
      tried,
      resolved: { placeId, name: name || null, address: candidate.formatted_address || null },
      uploads: { place_ids_json: PATH_MAIN, archive_json: PATH_ARCHIVE },
      commit: { main: mainRes?.data?.commit?.sha || null, archive: archRes?.data?.commit?.sha || null }
    });

  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(obj) };
}
