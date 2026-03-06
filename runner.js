import http from "node:http";
import PocketBase from "pocketbase";

const PB_URL = process.env.POCKETBASE_URL;
const ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL;
const ADMIN_PASS = process.env.POCKETBASE_ADMIN_PASSWORD;
const PORT = Number(process.env.PORT || 3001);

if (!PB_URL || !ADMIN_EMAIL || !ADMIN_PASS) {
  console.error(
    "❌ Missing env vars: POCKETBASE_URL / POCKETBASE_ADMIN_EMAIL / POCKETBASE_ADMIN_PASSWORD"
  );
  process.exit(1);
}

const pb = new PocketBase(PB_URL);

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

function normalizeText(value, fallback = "") {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  return fallback;
}

function getTaskInput(task) {
  if (task && task.input_data && typeof task.input_data === "object") {
    return task.input_data;
  }
  return {};
}

function getMode(task) {
  const input = getTaskInput(task);
  return normalizeText(input.mode, "create").toLowerCase();
}

function getDeliverable(task) {
  const input = getTaskInput(task);
  return normalizeText(
    input.deliverable,
    normalizeText(task.type, "general")
  ).toLowerCase();
}

function getBriefTitle(task) {
  const input = getTaskInput(task);
  return normalizeText(
    input.brief_title,
    normalizeText(task.title, "קמפיין חדש")
  );
}

function getLanguage(task) {
  const input = getTaskInput(task);
  return normalizeText(input.language, "he").toLowerCase();
}

function getTone(task) {
  const input = getTaskInput(task);
  return normalizeText(input.tone, "marketing_editorial");
}

function getWordCount(task, fallback = 450) {
  const input = getTaskInput(task);
  const raw = input.word_count ?? input.target_word_count;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 50) return Math.round(num);
  return fallback;
}

function getRevisionNotes(task) {
  const input = getTaskInput(task);
  const notes = input.revision_notes;

  if (Array.isArray(notes)) {
    return notes.map((n) => normalizeText(n)).filter(Boolean);
  }

  if (typeof notes === "string") {
    return notes
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
  }

  return [];
}

function getPreviousOutput(task) {
  const input = getTaskInput(task);
  if (input.previous_output && typeof input.previous_output === "object") {
    return input.previous_output;
  }
  return {};
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function paragraphsToHtml(paragraphs) {
  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");
}

function buildArticleParagraphs(briefTitle, tone) {
  return [
    `כאשר בונים כתבה שיווקית סביב ${briefTitle}, חשוב להתחיל ממסר מרכזי חד וברור. במקום לנסות להעמיס על הקורא כמה שיותר פרטים כבר בפתיחה, עדיף להגדיר הבטחה אחת חזקה שתוביל את כל הטקסט. כך נוצר בסיס ברור יותר לתוכן, והקורא מבין כבר מההתחלה מה הערך שהוא עומד לקבל ולמה בכלל כדאי לו להמשיך לקרוא.`,
    `השלב הבא הוא לתרגם את הנושא לשפה טבעית, אמינה ומשכנעת. כתבה טובה איננה אוסף של משפטים כלליים, אלא תוכן שמחבר בין צורך אמיתי של הקהל לבין פתרון, רעיון או הזדמנות. כשכותבים נכון, הטקסט לא רק נשמע מקצועי יותר, אלא גם מייצר תחושת ביטחון, סדר ובהירות. אלה מרכיבים חשובים במיוחד כאשר רוצים לשכנע, להסביר או להניע לפעולה.`,
    `במקרה של ${briefTitle}, נכון להדגיש לא רק את מה שמציעים, אלא גם את המשמעות עבור הצד השני. הקורא בדרך כלל לא מחפש רק מידע טכני; הוא מחפש להבין מה התועלת, מה היתרון, ומה הופך את ההצעה לרלוונטית עבורו דווקא עכשיו. לכן, כתיבה טובה תשים דגש על תוצאה, על ערך, ועל הדרך שבה המסר פוגש צורך ממשי ולא רק תיאור כללי של שירות או רעיון.`,
    `מבנה הטקסט משפיע מאוד על היכולת של הקורא להישאר מרוכז. פתיחה שמושכת פנימה, גוף טקסט שמרחיב בהדרגה, וסיום עם קריאה לפעולה — כל אלה יוצרים רצף נכון. מעבר לכך, כאשר שומרים על פסקאות ברורות, ניסוחים ישירים וטון עקבי, התוכן מרגיש מקצועי יותר. במקרה הזה הטון שנבחר הוא ${tone}, ולכן הטקסט משלב בין גישה עניינית, מסר שיווקי ברור ותחושה נגישה לקורא.`,
    `עוד נקודה חשובה היא אמינות. תוכן שיווקי אפקטיבי לא צריך להישמע מוגזם כדי לעבוד. להפך — פעמים רבות דווקא ניסוח מדויק, שקול וברור עובד טוב יותר מטקסט מלא בהבטחות גדולות. סביב ${briefTitle}, עדיף לבנות טיעון שמציג יתרונות מוחשיים, מסביר את ההיגיון מאחורי ההצעה, ומחבר בין הסיפור הכללי לבין מה שהקורא באמת רוצה להשיג מבחינתו.`,
    `בסופו של דבר, כתבה טובה היא נכס שיווקי של ממש. היא יכולה לחזק מסר, לחדד מיצוב, לשפר את איכות הלידים ולבנות תחושת מקצועיות סביב המהלך כולו. כאשר התוכן סביב ${briefTitle} נכתב נכון, הוא לא רק ממלא מקום באתר או בדף נחיתה, אלא הופך לכלי שעוזר להניע תהליך: מעניין ראשוני, דרך הבנה עמוקה יותר, ועד פעולה ברורה כמו השארת פרטים, יצירת קשר או מעבר לשלב הבא.`,
  ];
}

function trimToApproxWords(text, targetWords = 450) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= targetWords + 25) return text;
  return words.slice(0, targetWords + 10).join(" ");
}

function buildArticleCreateOutput(task) {
  const briefTitle = getBriefTitle(task);
  const tone = getTone(task);
  const language = getLanguage(task);
  const wordCount = getWordCount(task, 450);

  const title = `${briefTitle}: כך בונים מסר שיווקי ברור ומשכנע`;
  const subtitle =
    "תוכן שיווקי טוב מתחיל במסר חד, ערך ברור, והבנה מדויקת של מה הקורא צריך לראות כבר מהפתיחה.";

  const paragraphs = buildArticleParagraphs(briefTitle, tone);
  const articleText = trimToApproxWords(paragraphs.join("\n\n"), wordCount);

  const articleHtml = `
<section dir="rtl" lang="${escapeHtml(language)}">
  <h1>${escapeHtml(title)}</h1>
  <h2>${escapeHtml(subtitle)}</h2>
  ${paragraphsToHtml(paragraphs)}
</section>
  `.trim();

  return {
    ok: true,
    note: "copywriter article create placeholder",
    language,
    mode: "create",
    deliverable: "article",
    target_word_count: wordCount,
    estimated_word_count: articleText.split(/\s+/).filter(Boolean).length,
    title,
    subtitle,
    article_text: articleText,
    article_html: articleHtml,
    seo_titles: [
      `${briefTitle} – כתבה שיווקית בעברית`,
      `${briefTitle}: מסר שיווקי ברור יותר`,
      `${briefTitle} – תוכן שמייצר עניין והמרות`,
    ],
    cta: "השאירו פרטים לקבלת מידע נוסף והמשך התאמה אישית.",
  };
}

function buildArticleRevisionOutput(task) {
  const briefTitle = getBriefTitle(task);
  const language = getLanguage(task);
  const wordCount = getWordCount(task, 450);
  const notes = getRevisionNotes(task);
  const previousOutput = getPreviousOutput(task);

  const prevTitle = normalizeText(
    previousOutput.title,
    `${briefTitle}: גרסה מעודכנת`
  );

  const prevText = normalizeText(
    previousOutput.article_text,
    `זוהי גרסת תיקון עבור ${briefTitle}.`
  );

  const notesText = notes.length
    ? notes.map((n, i) => `${i + 1}. ${n}`).join(" ")
    : "לא נמסרו הערות תיקון מפורטות, ולכן בוצע חידוד כללי של הטקסט.";

  const revisedTitle = `${prevTitle} – גרסה מעודכנת`;
  const revisedSubtitle =
    "הטקסט עודכן לפי ההערות, עם חידוד המסר, שיפור הזרימה והבלטת הנקודות החשובות יותר.";

  const revisedParagraphs = [
    `להלן גרסה מעודכנת של התוכן סביב ${briefTitle}, לאחר מעבר על ההערות והבנת הכיוונים שנדרשו לתיקון. המטרה בתהליך הזה היא לא רק לשנות משפטים בודדים, אלא לשפר את החדות של המסר, לחזק את הערך שמוצג לקורא, ולוודא שהטקסט כולו עובד בצורה ברורה, עקבית ומשכנעת יותר מהגרסה הקודמת.`,
    `ההערות שהתקבלו קיבלו מענה ישיר במסגרת השכתוב. בין היתר הודגשו הנקודות הבאות: ${notesText} כך התוכן לא רק נשאר נאמן לנושא המרכזי, אלא גם הופך להיות מדויק יותר לצורך השיווקי, לקהל היעד ולמטרה שלשמה הוא נכתב מלכתחילה. זהו הבדל חשוב, כי לעיתים תיקון טוב הוא לא הוספת עוד מידע, אלא ניסוח נכון יותר של המידע שכבר קיים.`,
    `כדי לשמור על תוצאה איכותית, הגרסה החדשה ממשיכה להישען על המבנה המרכזי של הטקסט הקודם, אבל משפרת אותו במקום הנכון. יש חיזוק לפתיחה, הסברים בהירים יותר בגוף התוכן, ומעבר חלק יותר בין פסקאות. בנוסף, הניסוח כעת יותר ממוקד, פחות כללי, ועם יותר דגש על תועלת והנעה לפעולה — כך שהתוכן מרגיש מקצועי, בטוח וברור יותר.`,
    `הגרסה הקודמת שימשה בסיס חשוב, אך כעת היא עברה עיבוד שמכוון לתוצאה חזקה יותר. מבחינה שיווקית, טקסט מתוקן צריך לעשות יותר מאשר רק “להיות נכון”; הוא צריך גם לייצר תחושת התאמה, אמינות וזרימה. לכן השכתוב שם לב לא רק למה נאמר, אלא גם לאיך זה נשמע, איך זה נבנה, ואיך הקורא צפוי לחוות את המסר לכל אורך הקריאה.`,
    `לנוחות, נשמר גם בסיס התוכן המקורי שעובד מחדש: ${prevText.slice(0, 260)}${prevText.length > 260 ? "..." : ""} מתוך הבסיס הזה בוצעה גרסה מחודדת יותר, שנועדה לשרת טוב יותר את המטרה השיווקית של ${briefTitle}. במידת הצורך אפשר לבצע סבב תיקונים נוסף, להתמקד בכותרת בלבד, להרחיב פסקאות מסוימות או לשנות את הטון הכללי בהתאם להערות חדשות.`,
    `בסיכום, מדובר בגרסת Revision שנועדה לשפר את התוצאה הקיימת ולא להתחיל מאפס. זה מאפשר לשמור על ההקשר, להימנע מאיבוד אלמנטים טובים שכבר נכתבו, ולבצע התקדמות ממוקדת יותר. אם יתקבלו תיקונים נוספים, יהיה אפשר להמשיך מאותה נקודה בדיוק ולבצע עדכון נוסף בצורה מסודרת, עקבית ומהירה יותר.`,
  ];

  const revisedText = trimToApproxWords(revisedParagraphs.join("\n\n"), wordCount);

  const revisedHtml = `
<section dir="rtl" lang="${escapeHtml(language)}">
  <h1>${escapeHtml(revisedTitle)}</h1>
  <h2>${escapeHtml(revisedSubtitle)}</h2>
  ${paragraphsToHtml(revisedParagraphs)}
</section>
  `.trim();

  return {
    ok: true,
    note: "copywriter article revision placeholder",
    language,
    mode: "revise",
    deliverable: "article",
    target_word_count: wordCount,
    estimated_word_count: revisedText.split(/\s+/).filter(Boolean).length,
    revision_notes_applied: notes,
    title: revisedTitle,
    subtitle: revisedSubtitle,
    article_text: revisedText,
    article_html: revisedHtml,
    cta: "השאירו פרטים לקבלת מידע נוסף או סבב תיקונים נוסף לפי הצורך.",
  };
}

function buildAdsCreateOutput(task) {
  const briefTitle = getBriefTitle(task);
  const language = getLanguage(task);

  return {
    ok: true,
    note: "copywriter ads create placeholder",
    language,
    mode: "create",
    deliverable: "ads",
    headlines: [
      `${briefTitle} שמדבר לקהל הנכון`,
      `כך מציגים את ${briefTitle} בצורה ברורה`,
      `${briefTitle} עם מסר חד ומדויק`,
      `מחפשים ניסוח טוב יותר ל־${briefTitle}?`,
      `${briefTitle} עם זווית שיווקית חזקה יותר`,
    ],
    primary_texts: [
      `אם רוצים להבליט את ${briefTitle} בצורה משכנעת יותר, צריך לנסח מסר חד, ברור ורלוונטי לקהל היעד. זה בדיוק הבסיס לקמפיין טוב יותר.`,
      `${briefTitle} יכול להפוך למסגרת שיווקית חזקה הרבה יותר כשבונים סביבו תוכן נכון, הבטחה ברורה והנעה לפעולה שמרגישה טבעית.`,
      `במקום טקסט כללי, כדאי לנסח עבור ${briefTitle} מסר ממוקד שמציג ערך ברור, מחזק אמינות ומוביל לפעולה.`,
    ],
    angles: [
      "בהירות ודיוק במסר",
      "חיזוק הערך המרכזי",
      "בניית אמון והנעה לפעולה",
    ],
    cta_options: [
      "השאירו פרטים",
      "לקבלת מידע נוסף",
      "בואו לראות איך זה עובד",
    ],
  };
}

function buildAdsRevisionOutput(task) {
  const briefTitle = getBriefTitle(task);
  const notes = getRevisionNotes(task);
  const previousOutput = getPreviousOutput(task);

  const previousHeadlines = Array.isArray(previousOutput.headlines)
    ? previousOutput.headlines
    : [];
  const previousTexts = Array.isArray(previousOutput.primary_texts)
    ? previousOutput.primary_texts
    : [];

  return {
    ok: true,
    note: "copywriter ads revision placeholder",
    mode: "revise",
    deliverable: "ads",
    revision_notes_applied: notes,
    previous_headlines_count: previousHeadlines.length,
    previous_texts_count: previousTexts.length,
    headlines: [
      `${briefTitle} בניסוח מחודד יותר`,
      `גרסה מעודכנת ל־${briefTitle}`,
      `${briefTitle} עם מסר ברור ומשופר`,
      `ניסוח חדש ומדויק יותר ל־${briefTitle}`,
    ],
    primary_texts: [
      `הטקסטים עבור ${briefTitle} עודכנו לפי ההערות שניתנו, עם דגש על מסר ברור יותר, חיזוק הערך המרכזי ושיפור הזרימה הכללית.`,
      `בוצע חידוד של הניסוח, שיפור ההבטחה המרכזית והדגשה טובה יותר של התועלת עבור הקורא, כדי להפוך את ${briefTitle} לאפקטיבי יותר ברמת המודעה.`,
      `לאחר סבב התיקונים, המסר סביב ${briefTitle} מרגיש ממוקד, בטוח וברור יותר, עם התאמה טובה יותר למטרה השיווקית.`,
    ],
    cta_options: [
      "השאירו פרטים עכשיו",
      "קבלו מידע נוסף",
      "בדקו התאמה עכשיו",
    ],
  };
}

async function runCopywriter(task) {
  const deliverable = getDeliverable(task);
  const type = normalizeText(task.type, "").toLowerCase();
  const mode = getMode(task);

  if (deliverable === "article" || type === "article") {
    if (mode === "revise") {
      return buildArticleRevisionOutput(task);
    }
    return buildArticleCreateOutput(task);
  }

  if (deliverable === "ads" || deliverable === "ad_copy" || type === "ad_copy") {
    if (mode === "revise") {
      return buildAdsRevisionOutput(task);
    }
    return buildAdsCreateOutput(task);
  }

  return {
    ok: true,
    note: "copywriter generic placeholder",
    mode,
    deliverable,
    summary: `Generated generic copy output for ${getBriefTitle(task)}.`,
    hebrew_copy: `זהו טקסט placeholder עבור ${getBriefTitle(task)}. השלב הבא יהיה לחבר את ה-agent למודל אמיתי כדי לייצר תוכן מלא ואיכותי.`,
  };
}

const agents = {
  planner: async (task) => {
    return {
      ok: true,
      note: "planner placeholder",
      next: ["ad_copy", "banner_set", "landing_page", "article", "video", "qa_review"],
    };
  },

  copywriter: async (task) => {
    return await runCopywriter(task);
  },

  visual_director: async (task) => {
    return {
      ok: true,
      note: "visual_director placeholder",
      prompts: ["prompt 1", "prompt 2"],
    };
  },

  image_generator: async (task) => {
    return {
      ok: true,
      note: "image_generator placeholder",
      images: [],
    };
  },

  banner_renderer: async (task) => {
    return {
      ok: true,
      note: "banner_renderer placeholder",
      banners: [],
    };
  },

  landing_page_builder: async (task) => {
    return {
      ok: true,
      landing_page: {
        html: `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Landing Page Placeholder</title>
</head>
<body style="font-family:Arial;padding:24px">
  <h1>דף נחיתה (Placeholder)</h1>
  <p>זה שלד ראשוני כדי לוודא שהריצה עובדת.</p>
  <form>
    <input placeholder="שם" style="display:block;margin:8px 0;padding:10px;width:260px"/>
    <input placeholder="טלפון" style="display:block;margin:8px 0;padding:10px;width:260px"/>
    <button type="button" style="padding:10px 16px">שלח</button>
  </form>
</body>
</html>`,
      },
    };
  },

  video_producer: async (task) => {
    return {
      ok: true,
      note: "video_producer placeholder",
      script: "תסריט קצר לדוגמה",
    };
  },

  qa: async (task) => {
    return {
      ok: true,
      note: "qa placeholder",
      approved: true,
      notes: [],
    };
  },
};

export async function runTaskById(taskId) {
  const task = await pb.collection("tasks").getOne(taskId);

  const agentName = task.assigned_agent;
  if (!agentName) throw new Error('Task missing "assigned_agent"');

  const handler = agents[agentName];
  if (!handler) throw new Error(`No handler for assigned_agent="${agentName}"`);

  await pb.collection("tasks").update(task.id, { status: "in_progress" });

  await logActivity({
    event: "task_started",
    agent: agentName,
    campaign_id: task.campaign_id,
    task_id: task.id,
    details: {
      title: task.title,
      type: task.type,
      priority: task.priority,
    },
  });

  try {
    const output = await handler(task);

    await pb.collection("tasks").update(task.id, {
      status: "done",
      output_data: output,
    });

    await logActivity({
      event: "task_done",
      agent: agentName,
      campaign_id: task.campaign_id,
      task_id: task.id,
      details: {
        title: task.title,
        type: task.type,
        priority: task.priority,
      },
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
      details: {
        error: String(err?.message || err),
        type: task.type,
        title: task.title,
      },
    });

    throw err;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "agent-runner",
      uptime_sec: Math.round(process.uptime()),
      now: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/run-task") {
    try {
      const body = await readJsonBody(req);
      const taskId = normalizeText(body.taskId);

      if (!taskId) {
        sendJson(res, 400, {
          ok: false,
          error: 'Missing "taskId"',
        });
        return;
      }

      const output = await runTaskById(taskId);

      sendJson(res, 200, {
        ok: true,
        taskId,
        output,
      });
      return;
    } catch (e) {
      console.error("❌ /run-task failed:", e?.message || e);
      sendJson(res, 500, {
        ok: false,
        error: String(e?.message || e),
      });
      return;
    }
  }

  sendJson(res, 404, {
    ok: false,
    error: "Not found",
  });
}

async function main() {
  console.log("🚀 Starting agent runner (manual mode — no auto-processing)...");
  await auth();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((e) => {
      console.error("❌ Unhandled request error:", e?.message || e);
      sendJson(res, 500, { ok: false, error: "Internal server error" });
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 HTTP server listening on port ${PORT}`);
  });

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

  console.log("⏳ Runner is alive. Waiting for manual triggers only.");
}

main().catch((err) => {
  console.error("❌ Runner fatal error:", err?.message || err);
  process.exit(1);
});
