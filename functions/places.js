// functions/places.js
// Netlify Function: Sucht eine Place ID und schreibt sie robust in w2h-places-import (mit 409-Retry)

exports.handler = async function (event, context) {
  const input = event.queryStringParameters?.input || "GH7V+C9 Portorož, Slovenia";
  const preferredName = event.queryStringParameters?.name || null;

  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const GH_TOKEN = process.env.GH_TOKEN;

  // Ziel-Repo für die Place-ID-Listen
  const GH_OWNER = "Sailbuddy";
  const GH_REPO = "w2h-places-import";
  const PATH_MAIN = "data/place_ids.json";
  const PATH_ARCHIVE = "data/place_ids_archive.json";

  if (!GOOGLE_API_KEY) {
    return json(500, { ok: false, error: "GOOGLE_API_KEY missing" });
  }
  if (!GH_TOKEN) {
    return json(500, { ok: false, error: "GH_TOKEN (GitHub PAT) missing" });
  }

  try {
    // 1) Find Place → Place ID
    const findUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(
      input
    )}&inputtype=textquery&fields=place_id,name&key=${GOOGLE_API_KEY}`;

    const findRes = await fetch(findUrl);
    const findData = await findRes.json();

    if (findData.status !== "OK" || !findData.candidates?.length) {
      return json(400, { ok: false, step: "findplace", status: findData.status, result: findData });
    }

    const candidate = findData.candidates[0];
    const placeId = candidate.place_id;
    const name = preferredName || candidate.name || null;

    // 2) Upload-Helfer
    const ghHeaders = {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    };

    const getContent = async (path) => {
      const u = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`;
      const r = await fetch(u, { headers: ghHeaders });
      if (r.status === 404) {
        // Datei existiert noch nicht
        return { sha: null, json: [] };
      }
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`GET ${path} failed: ${r.status} ${t}`);
      }
      const d = await r.json();
      const content = Buffer.from(d.content || "", d.encoding || "base64").toString("utf8");
      let parsed;
      try { parsed = JSON.parse(content); } catch { parsed = []; }
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
      if (r.status === 409) return { conflict: true, text: await r.text() };
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`PUT ${path} failed: ${r.status} ${t}`);
      }
      return { conflict: false, data: await r.json() };
    };

    const safeUpdate = async (path, updater, commitMsg) => {
      // 1. Ist-Zustand lesen
      let { sha, json: current } = await getContent(path);
      // 2. Neue Version erzeugen
      let next = updater(current);
      // 3. Erster Schreibversuch
      let res = await putContent(path, next, commitMsg, sha);
      if (res.conflict) {
        // 4. Bei 409: aktuellen SHA neu holen und wiederholen
        const fresh = await getContent(path);
        next = updater(fresh.json); // falls sich Inhalt verändert hat → erneut ableiten
        res = await putContent(path, next, commitMsg, fresh.sha);
      }
      return res;
    };

    // 3) Update data/place_ids.json (append + Dedupe)
    const mainUpdater = (arr) => {
      const normalized = Array.isArray(arr) ? arr : [];
      const exists = normalized.some((x) =>
        typeof x === "string" ? x === placeId : x?.placeId === placeId
      );
      if (!exists) {
        // prefer Objekt-Struktur, aber wenn Liste bisher Strings enthält, füge String ein
        if (normalized.every((x) => typeof x === "string")) {
          normalized.push(placeId);
        } else {
          normalized.push({ placeId, preferredName: name });
        }
      }
      return normalized;
    };

    const archiveUpdater = (arr) => {
      const normalized = Array.isArray(arr) ? arr : [];
      // ins Archiv immer anhängen (auch Duplikate)
      if (normalized.every((x) => typeof x === "string")) {
        normalized.push(placeId);
      } else {
        normalized.push({ placeId, preferredName: name, addedAt: new Date().toISOString() });
      }
      return normalized;
    };

    const mainRes = await safeUpdate(PATH_MAIN, mainUpdater, `append ${placeId} to place_ids.json`);
    const archRes = await safeUpdate(PATH_ARCHIVE, archiveUpdater, `append ${placeId} to place_ids_archive.json`);

    return json(200, {
      ok: true,
      input,
      resolved: { placeId, name },
      uploads: {
        place_ids_json: mainRes?.data?.content?.path || PATH_MAIN,
        archive_json: archRes?.data?.content?.path || PATH_ARCHIVE,
      },
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};

// kleine Helfer
function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(obj) };
}
