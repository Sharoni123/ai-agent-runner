import PocketBase from "pocketbase";

const PB_URL = process.env.POCKETBASE_URL;
const ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL;
const ADMIN_PASS = process.env.POCKETBASE_ADMIN_PASSWORD;

if (!PB_URL || !ADMIN_EMAIL || !ADMIN_PASS) {
  console.error(
    "❌ Missing env vars: POCKETBASE_URL / POCKETBASE_ADMIN_EMAIL / POCKETBASE_ADMIN_PASSWORD"
  );
  process.exit(1);
}

const pb = new PocketBase(PB_URL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function auth() {
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
    console.error("⚠️ activity_log create failed:", e?.message || e);
  }
}

/**
 * === Agent handlers ===
 * אלו רצים רק כשקוראים ל-runTaskById() ידנית.
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

/**
 * runTaskById — קריאה ידנית בלבד (מה-frontend דרך כפתור "Run Agent").
 * מעביר: backlog → in_progress → done
 * לא נקרא אוטומטית בשום מקום.
 */
export async function runTaskById(taskId) {
  const task = await pb.collection("tasks").getOne(taskId);

  const agentName = task.assigned_agent;
  if (!agentName) throw new Error('Task missing "assigned_agent"');

  const handler = agents[agentName];
  if (!handler) throw new Error(`No handler for assigned_agent="${agentName}"`);

  // backlog → in_progress
  await pb.collection("tasks").update(task.id, { status: "in_progress" });

  await logActivity({
    event: "task_started",
    agent: agentName,
    campaign_id: task.campaign_id,
    task_id: task.id,
    details: { title: task.title, type: task.type, priority: task.priority },
  });

  try {
    const output = await handler(task);

    // in_progress → done
    await pb.collection("tasks").update(task.id, {
      status: "done",
      output_data: output,
    });

    await logActivity({
      event: "task_done",
      agent: agentName,
      campaign_id: task.campaign_id,
      task_id: task.id,
      details: { type: task.type },
    });

    return output;
  } catch (err) {
    await pb.collection("tasks").update(task.id, {
      status: "failed",
      output_data: { error: String(err?.message || err) },
    });

    await logActivity({
      event: "task_failed",
      agent: agentName,
      campaign_id: task.campaign_id,
      task_id: task.id,
      details: { error: String(err?.message || err), type: task.type },
    });

    throw err;
  }
}

async function main() {
  console.log("🚀 Starting agent runner (manual mode — no auto-processing)...");
  await auth();

  // heartbeat בלבד — שומר על החיבור, לא נוגע ב-tasks
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

  // ✅ הלולאה האוטומטית הוסרה לחלוטין.
  // Tasks לא זזים לבד — רק דרך drag & drop או כפתור "Run Agent" ב-frontend.
  console.log("⏳ Runner is alive. Waiting for manual triggers only.");

  // שומר על הprocess חי
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("❌ Runner fatal error:", err?.message || err);
  process.exit(1);
});
