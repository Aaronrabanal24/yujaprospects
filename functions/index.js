import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { parse } from "csv-parse/sync";
import { z } from "zod";

initializeApp({ credential: applicationDefault() });
const auth = getAuth();
const db = getFirestore();

const ProspectSchema = z.object({
  tenantId: z.string().min(1),
  institutionName: z.string().min(2),
  domain: z.string().trim().toLowerCase(),
  product: z.enum(["verity","panorama","lumina"]),
  region: z.string().default(""),
  timezone: z.string().default(""),
  lms: z.string().default(""),
  score: z.number().int().min(0).max(100).default(0),
  stage: z.enum(["P1","nurture","research","hold"]).default("research"),
  wedges: z.array(z.string()).default([]),
  whyNow: z.string().default(""),
  currentTools: z.array(z.string()).default([]),
  ownerUid: z.string().optional(),
  ownerName: z.string().optional(),
  status: z.enum(["new","working","replied","qualified","disqualified"]).default("new").optional(),
  priority: z.enum(["A","B","C"]).default("B").optional(),
  lastContactedAt: z.string().or(z.number()).optional(),
  nextStep: z.string().default("").optional(),
  nextStepDueAt: z.string().or(z.number()).optional(),
  contacts: z.array(z.object({
    name: z.string(),
    title: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    role: z.string().optional()
  })).optional(),
  signals: z.array(z.object({
    type: z.string(),
    title: z.string(),
    date: z.string().optional(),
    source: z.string().optional()
  })).optional()
});

const normalizeId = (domain, product) =>
  `${domain.replace(/\s+/g,'').toLowerCase()}_${product}`;

async function pickOwner(tenantId, region) {
  const q = await db.collection("roles").get();
  const pool = q.docs.map(d => ({ uid: d.id, ...d.data() }))
    .filter(r => (r.tenants && (r.tenants[tenantId] === "sdr" || r.tenants[tenantId] === "admin")) &&
                 (!r.regions || r.regions.includes(region) || r.regions.includes("ALL")));
  if (!pool.length) return null;
  const rrId = `${tenantId}__${region || "ANY"}`;
  const rrRef = db.collection("routing").doc(rrId);
  const snap = await rrRef.get();
  let idx = 0;
  if (snap.exists) idx = ((snap.data().lastIndex || 0) + 1) % pool.length;
  await rrRef.set({ lastIndex: idx, count: FieldValue.increment(1), tenantId, region: region || "ANY" }, { merge: true });
  return pool[idx];
}

// Import JSON/CSV into tenant path
export const importProspects = onCall({ cors: true, region: "us-central1" }, async (request) => {
  const caller = request.auth?.uid;
  if (!caller) throw new Error("Auth required");
  const body = request.data;
  if (!body) throw new Error("No data provided");

  let items = [];
  if (typeof body === "string") {
    const records = parse(body, { columns: true, skip_empty_lines: true, trim: true });
    items = records;
  } else if (Array.isArray(body)) {
    items = body;
  } else if (typeof body === "object") {
    items = [body];
  }

  const batch = db.batch();
  let count = 0;

  for (const raw of items) {
    const parsed = ProspectSchema.parse({ ...raw, product: (raw.product||"").toLowerCase() });
    const id = normalizeId(parsed.domain, parsed.product);
    const base = db.collection("tenants").doc(parsed.tenantId).collection("prospects").doc(id);

    // Assign owner if blank
    let ownerUid = parsed.ownerUid || null;
    let ownerName = parsed.ownerName || null;
    if (!ownerUid) {
      const chosen = await pickOwner(parsed.tenantId, parsed.region);
      if (chosen) {
        ownerUid = chosen.uid;
        ownerName = chosen.displayName || chosen.email || chosen.uid;
      }
    }

    batch.set(base, {
      tenantId: parsed.tenantId,
      institutionName: parsed.institutionName,
      domain: parsed.domain,
      product: parsed.product,
      region: parsed.region,
      timezone: parsed.timezone,
      lms: parsed.lms,
      score: parsed.score,
      stage: parsed.stage,
      wedges: parsed.wedges,
      whyNow: parsed.whyNow,
      currentTools: parsed.currentTools,
      ownerUid, ownerName,
      status: parsed.status || "new",
      priority: parsed.priority || "B",
      lastContactedAt: parsed.lastContactedAt ? new Date(parsed.lastContactedAt) : null,
      nextStep: parsed.nextStep || "",
      nextStepDueAt: parsed.nextStepDueAt ? new Date(parsed.nextStepDueAt) : null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    if (parsed.contacts?.length) {
      for (const c of parsed.contacts) {
        batch.set(base.collection("contacts").doc(), { ...c, createdAt: FieldValue.serverTimestamp() });
      }
    }
    if (parsed.signals?.length) {
      for (const s of parsed.signals) {
        batch.set(base.collection("signals").doc(), { ...s, date: s.date ? new Date(s.date) : null, createdAt: FieldValue.serverTimestamp() });
      }
    }

    batch.set(db.collection("audit").doc(), { type:"import", tenantId: parsed.tenantId, prospectId: id, by: caller, at: FieldValue.serverTimestamp() });
    count++;
  }

  await batch.commit();
  return { ok: true, count };
});

// Admin: set or update a user's tenant roles + regions
export const setUserRoleByEmail = onCall({ cors: true, region: "us-central1" }, async (request) => {
  const caller = request.auth?.uid;
  if (!caller) throw new Error("Auth required");
  const callerDoc = await db.collection("roles").doc(caller).get();
  if ((callerDoc.data()?.tenants || {})['global'] !== 'admin') throw new Error("Global admin only");

  const { email, tenants, regions, displayName } = request.data || {};
  if (!email || !tenants || typeof tenants !== "object") throw new Error("email and tenants map required");

  const user = await auth.getUserByEmail(email);
  const ref = db.collection("roles").doc(user.uid);
  await ref.set({ tenants, regions: regions || [], email, displayName: displayName || user.displayName || email }, { merge: true });
  return { ok: true, uid: user.uid };
});

// Nightly scoring across tenants (optional — requires billing for schedules)
export const recalculateScores = onSchedule("0 3 * * *", async () => {
  const snap = await db.collectionGroup("prospects").get(); // across /tenants/*/prospects
  const batch = db.batch();
  const now = new Date();

  snap.forEach(doc => {
    const p = doc.data();
    let score = Number(p.score || 0);
    const last = p.lastContactedAt ? new Date(p.lastContactedAt.seconds ? p.lastContactedAt.seconds * 1000 : p.lastContactedAt) : null;
    if (last) {
      const days = Math.floor((now - last) / (1000*60*60*24));
      if (days >= 3) score = Math.max(0, score - 2);
    }

    let stage = p.stage || "research";
    if (score >= 80) stage = "P1";
    else if (score >= 60) stage = "nurture";
    else stage = "research";

    batch.update(doc.ref, { score, stage, updatedAt: new Date() });
  });

  await batch.commit();
});
