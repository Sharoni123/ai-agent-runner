import PocketBase from "pocketbase";

const PB_URL = process.env.POCKETBASE_URL;
const ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL;
const ADMIN_PASS = process.env.POCKETBASE_ADMIN_PASSWORD;

const POLL_MS = Number(process.env.POLL_MS || 3000);

if (!PB_URL || !ADMIN_EMAIL || !ADMIN_PASS) {
  console.error(
    "❌ Missing env vars: POCKETBASE_URL / POCKETBASE_ADMIN_EMAIL / POCKETBASE_ADMIN_PASSWORD"
  );
  process.exit(1);
}

const pb = new PocketBase(PB_URL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function auth() {
  // PocketBase superuser login (תואם למה שיש אצלך)
  await pb.collection("_superusers").authWithPassword(ADMIN_EMAIL, ADMIN_PASS);
  console.log("✅ Connected to PocketBase as superuser");
}

async function logActivity({ event, agent, details = {}, campaign_id = null, task_id = null }) {
  try {
    await pb.collection("activity_log").create({
      event,
      agent,
      details,
      campaign_id,
      task_id,
    });
  } catch (e) {
    // לא מפיל ריצה בגלל לוג
    console.error("⚠️ activity_log create failed:", e?.message || e);
  }
}

async function fetchNextTask() {
  // משימות שממתינות = backlog (לפי מה שהגדרת עכשיו)
  const res = await pb.collection("tasks").getList(1, 50, {
    filter: `status="backlog"`,
    sort: "+created", // הכי ישנות קודם
  });

  if (!res.items.length) return null;

  // priority: urgent > high > normal > low
  const weight = { urgent: 0, high: 1, normal: 2, low: 3 };

  const sorted = [...res.items].sort((a, b) => {
    const wa = weight[a.priority] ?? 9;
    const wb = weight[b.priority] ?? 9;
    if (wa !== wb) return wa - wb;
    return new Date(a.created) - new Date(b.created);
  });

  return sorted[0];
}

async function claimTask(task) {
  // “נעילה” פשוטה: משנים סטטוס ל-in_progress.
  // אם שני runners ינסו לתפוס, אחד עלול “לנצח” — לכן try/catch.
  try {
    const updated = await pb.collection("tasks").update(task.id, {
      status: "in_progress",
    });
    return updated;
  } catch {
    return null;
  }
}

/**
 * === Agent handlers ===
 * כרגע: רק שלד שמחזיר output בסיסי כדי שהpipeline יעבוד.
 * (את הנראות/עיצוב של דפי נחיתה וכו' נבנה אחר כך, כמו שביקשת)
 */
const agents = {
  planner: async (task) => {
    return {
      ok: true,
      note: "planner placeholder",
      next: ["ad_copy", "banner_set", "landing_page", "article", "video", "qa_review"],
    };
  },

  copywriter: async (task) => {
    return { ok: true, note: "copywriter placeholder", hebrew_copy: "טקסט לדוגמה" };
  },

  visual_director: async (task) => {
    return { ok: true, note: "visual_director placeholder", prompts: ["prompt 1", "prompt 2"] };
  },

  image_generator: async (task) => {
    return { ok: true, note: "image_generator placeholder", images: [] };
  },

  banner_renderer: async (task) => {
    return { ok: true, note: "banner_renderer placeholder", banners: [] };
  },

  landing_page_builder: async (task) => {
    // LP מינימלי עם טופס (בלי להיכנס עדיין לעיצוב/שונות)
    return {
      ok: true,
      landing_page: {
        html: `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial;padding:24px">
  <h1>דף נחיתה (Placeholder)</h1>
  <p>זה שלד ראשוני כדי לוודא שהריצה עובדת.</p>
  <form>
    <input placeholder="שם" style="display:block;margin:8px 0;padding:10px;width:260px"/>
    <input placeholder="טלפון" style="display:block;margin:8px 0;padding:10px;width:260px"/>
    <button type="button" style="padding:10px 16px">שלח</button>
  </form>
</body></html>`,
      },
    };
  },

  video_producer: async (task) => {
    return { ok: true, note: "video_producer placeholder", script: "תסריט קצר לדוגמה" };
  },

  qa: async (task) => {
    return { ok: true, note: "qa placeholder", approved: true, notes: [] };
  },
};

async function runTask(task) {
  const agentName = task.assigned_agent;
  if (!agentName) throw new Error('Task missing "assigned_agent"');

  const handler = agents[agentName];
  if (!handler) throw new Error(`No handler for assigned_agent="${agentName}"`);

  return await handler(task);
}

async function processOnce() {
  const next = await fetchNextTask();
  if (!next) return false;

  const task = await claimTask(next);
  if (!task) return true; // מישהו אחר תפס/שגיאה בעדכון, ממשיכים

  await logActivity({
    event: "task_started",
    agent: task.assigned_agent,
    campaign_id: task.campaign_id,
    task_id: task.id,
    details: { title: task.title, type: task.type, priority: task.priority },
  });

  try {
    const output = await runTask(task);

    await pb.collection("tasks").update(task.id, {
      status: "done",
      output_data: output,
    });

    await logActivity({
      event: "task_done",
      agent: task.assigned_agent,
      campaign_id: task.campaign_id,
      task_id: task.id,
      details: { type: task.type },
    });
  } catch (err) {
    await pb.collection("tasks").update(task.id, {
      status: "failed",
      output_data: { error: String(err?.message || err) },
    });

    await logActivity({
      event: "task_failed",
      agent: task.assigned_agent || "planner",
      campaign_id: task.campaign_id,
      task_id: task.id,
      details: { error: String(err?.message || err), type: task.type },
    });
  }

  return true;
}

async function main() {
  console.log("🚀 Starting agent runner...");
  await auth();

  // heartbeat + refresh token
  setInterval(async () => {
    try {
      await pb.collection("_superusers").authRefresh();
      console.log("💓 heartbeat", new Date().toISOString());
    } catch (e) {
      console.error("⚠️ authRefresh failed:", e?.message || e);
      try {
        await auth();
        console.log("🔁 Reconnected");
      } catch (e2) {
        console.error("❌ Reconnect failed:", e2?.message || e2);
      }
    }
  }, 15000);

  while (true) {
    try {
      const didWork = await processOnce();
      if (!didWork) await sleep(POLL_MS);
    } catch (e) {
      console.error("Loop error:", e?.message || e);
      await sleep(2000);
    }
  }
}

main().catch((err) => {
  console.error("❌ Runner fatal error:", err?.message || err);
  process.exit(1);
});
