import http from "node:http";
import PocketBase from "pocketbase";
import OpenAI from "openai";

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

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

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

function getAudience(task) {
  const input = getTaskInput(task);
  return normalizeText(input.audience, "קהל יעד רלוונטי");
}

function getAngle(task) {
  const input = getTaskInput(task);
  return normalizeText(input.angle, "ערך ברור, בהירות ואמינות");
}

function getCTA(task) {
  const input = getTaskInput(task);
  return normalizeText(input.cta, "השאירו פרטים לקבלת מידע נוסף והמשך התאמה אישית.");
}

function getWordCount(task, fallback = 450) {
  const input = getTaskInput(task);
  const raw = input.word_count ?? input.target_word_count;
  const num = Number(raw);
  if (Number.isFinite(num) && num >= 200) return Math.round(num);
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

function getKeyPoints(task) {
  const input = getTaskInput(task);
  const raw = input.key_points;

  if (Array.isArray(raw)) {
    return raw.map((v) => normalizeText(v)).filter(Boolean).slice(0, 6);
  }

  if (typeof raw === "string") {
    return raw
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  return [];
}

function getAdditionalContext(task) {
  const input = getTaskInput(task);
  return normalizeText(
    input.additional_context || input.brief_details || input.description,
    ""
  );
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

function countWords(text) {
  return String(text).split(/\s+/).filter(Boolean).length;
}

function normalizeArticleParagraphs(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) return [];

  const byDoubleBreak = raw
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (byDoubleBreak.length >= 3) return byDoubleBreak;

  const sentences = raw
    .split(/(?<=[.!?。]|[।]|[!?])\s+|(?<=\.)\s+|(?<=\u05F3)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= 3) return [raw];

  const chunks = [];
  const chunkSize = Math.max(2, Math.ceil(sentences.length / 5));

  for (let i = 0; i < sentences.length; i += chunkSize) {
    chunks.push(sentences.slice(i, i + chunkSize).join(" "));
  }

  return chunks;
}

function clampWordRange(text, minWords = 430, maxWords = 500) {
  let words = String(text).split(/\s+/).filter(Boolean);

  if (words.length > maxWords) {
    words = words.slice(0, maxWords);
    return words.join(" ");
  }

  if (words.length < minWords) {
    const filler =
      " בנוסף, חשוב לשמור על מהלך קריאה ברור, על ניסוח טבעי ועל מסר עקבי, כדי שהקורא יבין את הערך, ירגיש ביטחון וירצה להמשיך לשלב הבא.";
    let current = words.join(" ");
    while (countWords(current) < minWords) {
      current += filler;
    }
    words = current.split(/\s+/).filter(Boolean);
    if (words.length > maxWords) {
      words = words.slice(0, maxWords);
    }
    return words.join(" ");
  }

  return words.join(" ");
}

function buildSeoTitles(briefTitle) {
  return [
    `${briefTitle} – כתבה שיווקית בעברית`,
    `${briefTitle}: מסר ברור יותר לקהל היעד`,
    `${briefTitle} – תוכן שמייצר עניין והמרות`,
  ];
}

function buildArticleTitle(briefTitle) {
  return briefTitle;
}

function buildArticleSubtitle(audience, angle) {
  return `תוכן טוב מתחיל בהבנת הקהל, חידוד המסר, ובניית זווית ברורה סביב ${angle} עבור ${audience}.`;
}

function buildArticleParagraphs(task) {
  const briefTitle = getBriefTitle(task);
  const tone = getTone(task);
  const audience = getAudience(task);
  const angle = getAngle(task);
  const keyPoints = getKeyPoints(task);
  const additionalContext = getAdditionalContext(task);

  const keyPointText =
    keyPoints.length > 0
      ? ` נקודות שכדאי להבליט במיוחד הן: ${keyPoints.join(", ")}.`
      : "";

  const contextText = additionalContext
    ? ` בנוסף, חשוב להתייחס גם לפרטים הבאים: ${additionalContext}.`
    : "";

  return [
    `${briefTitle} הוא נושא שצריך להציג בצורה ברורה, משכנעת ורלוונטית לקורא כבר מהרגע הראשון. במקום לדבר באופן כללי מדי, נכון לגשת ישירות ללב העניין, להסביר למה הנושא הזה חשוב עכשיו, ומה הערך שהקורא עשוי להפיק מהמשך הקריאה. פתיחה נכונה בונה עניין, מסדרת את המסר ומובילה את הקורא להבין שיש כאן תוכן ששווה לעצור עבורו.`,

    `כדי שכתבה תעבוד באמת, היא צריכה להישמע טבעית, אמינה ומדויקת. הקורא לא מחפש טקסט שנשמע כמו פרסומת שקופה, אלא תוכן שמסביר את הדברים בגובה העיניים, אבל עדיין משדר מקצועיות וביטחון. במקרה של ${briefTitle}, חשוב לנסח את התוכן באופן שמחבר בין מידע ברור לבין תחושת ערך, כך שהמסר לא רק יובן — אלא גם ירגיש רלוונטי ואמין.`,

    `הזווית המרכזית כאן היא ${angle}, ולכן הכתבה צריכה להבליט לא רק את עצם הנושא, אלא גם את המשמעות המעשית שלו עבור ${audience}. הקורא רוצה להבין מה מבדל את ההצעה, למה היא מעניינת דווקא עכשיו, ואיך היא פוגשת צורך אמיתי. ${keyPointText}${contextText} כאשר מחברים את כל אלה בצורה נכונה, נוצר תוכן שלא רק נשמע טוב, אלא גם יוצר עניין אמיתי ומגביר מעורבות.`,

    `גם למבנה עצמו יש חשיבות גדולה. כתבה טובה נבנית בהדרגה: היא מתחילה בפתיחה שמושכת פנימה, ממשיכה לפסקאות שמרחיבות את ההבנה, ומסתיימת בצורה שמשאירה תחושה ברורה של כיוון, ערך או הזדמנות. כאשר המעבר בין החלקים זורם בצורה טבעית, הקורא נשאר עם הטקסט עד הסוף בלי להרגיש שמכבידים עליו או מנסים “למכור” לו בצורה אגרסיבית מדי.`,

    `הטון המבוקש כאן הוא ${tone}, ולכן השפה צריכה להיות נקייה, בטוחה ורהוטה. לא צריך להשתמש בסיסמאות מוגזמות כדי לשכנע. להפך — דווקא ניסוח מדויק, שקול וקריא עובד הרבה יותר טוב ברוב המקרים. כאשר התוכן כתוב היטב, הקורא מרגיש שיש מולו מסר מסודר, כזה שמבין את הצרכים שלו, מדבר בשפה שמתאימה לו, ונותן לו סיבה טובה להמשיך לחשוב על מה שקרא גם אחרי שסיים את הכתבה.`,

    `בסופו של דבר, כתבה טובה על ${briefTitle} צריכה לעשות יותר מאשר רק למסור מידע. היא צריכה לבנות עניין, לחזק אמון, לחדד את ההבטחה המרכזית ולהניע את הקורא לשלב הבא בצורה טבעית. כשהיא כתובה נכון, היא הופכת לנכס שיווקי אמיתי: כזה שתומך במסר, מחזק את המותג ויוצר תנועה ממשית — בין אם המטרה היא להשאיר פרטים, ליצור קשר, או פשוט להעמיק את המעורבות של הקורא עם הנושא.`,
  ];
}

function buildArticleCreateOutput(task) {
  const briefTitle = getBriefTitle(task);
  const language = getLanguage(task);
  const audience = getAudience(task);
  const angle = getAngle(task);
  const cta = getCTA(task);

  const title = buildArticleTitle(briefTitle);
  const subtitle = buildArticleSubtitle(audience, angle);

  const paragraphs = buildArticleParagraphs(task);
  const articleText = clampWordRange(paragraphs.join("\n\n"), 430, 500);
  const articleHtml = `
<section dir="rtl" lang="${escapeHtml(language)}">
  <h1>${escapeHtml(title)}</h1>
  <h2>${escapeHtml(subtitle)}</h2>
  ${paragraphsToHtml(paragraphs)}
</section>
  `.trim();

  return {
    ok: true,
    note: "copywriter article create fallback",
    language,
    mode: "create",
    deliverable: "article",
    target_word_count: getWordCount(task, 450),
    estimated_word_count: countWords(articleText),
    title,
    subtitle,
    article_text: articleText,
    article_html: articleHtml,
    seo_titles: buildSeoTitles(briefTitle),
    cta,
  };
}

function buildArticleRevisionParagraphs(task, previousOutput, notes) {
  const briefTitle = getBriefTitle(task);
  const audience = getAudience(task);
  const angle = getAngle(task);
  const prevText = normalizeText(previousOutput.article_text, "");
  const notesText = notes.length
    ? notes.map((n, i) => `${i + 1}. ${n}`).join(" ")
    : "לא נמסרו הערות מפורטות, ולכן בוצע חידוד כללי של המבנה והניסוח.";

  return [
    `${briefTitle} מוצג כאן בגרסה מעודכנת, לאחר מעבר מסודר על ההערות שנמסרו ועל המסר שהכתבה צריכה להעביר. במקום להתחיל הכול מחדש, המטרה היא לקחת בסיס קיים, להבין מה דרוש שיפור, ולבצע התאמות שמחזקות את התוצאה הסופית. כך נשמר ההיגיון של הטקסט, אבל הוא הופך ברור יותר, זורם יותר ומשכנע יותר.`,

    `הערות התיקון שקיבלנו היו: ${notesText} בהתאם לכך, הטקסט עודכן כך שישקף בצורה מדויקת יותר את הזווית של ${angle}, וידבר טוב יותר אל ${audience}. לעיתים ההבדל בין טקסט בינוני לטקסט טוב לא טמון בעוד מידע, אלא בדרך שבה מארגנים אותו, במילים שבוחרים, וביכולת לחבר בין רעיון טוב לבין ניסוח חד ואמין.`,

    `בתהליך השכתוב ניתן דגש גם על חוויית הקריאה. פסקאות שאולי נשמעו כלליות מדי קיבלו ניסוח ממוקד יותר, המעברים בין החלקים שופרו, והמסר המרכזי קיבל נוכחות חזקה יותר בתוך הכתבה. זה חשוב משום שהקורא לא בוחן רק “מה כתוב”, אלא גם איך זה מרגיש בזמן הקריאה — האם זה ברור, האם זה נעים, והאם זה משדר ביטחון ומקצועיות.`,

    `כדי לשמור על רצף נכון, הגרסה החדשה נשענת גם על הבסיס הקודם. תחילת הטקסט המקורי הייתה: ${prevText.slice(0, 220)}${prevText.length > 220 ? "..." : ""} מתוך הבסיס הזה בוצע עדכון שמטרתו לחדד את הכותרת, לשפר את מבנה הכתבה, ולהבליט בצורה מדויקת יותר את הערך שהקורא אמור להבין כבר מהפסקאות הראשונות.`,

    `מעבר לתיקונים הטכניים, בוצע כאן גם חיזוק של התחושה הכללית שהכתבה מייצרת. טקסט טוב לא צריך רק להיות “נכון”; הוא צריך להישמע נכון, להרגיש נכון, ולהתאים למטרה שלשמה הוא נכתב. לכן הושם דגש על טון בטוח יותר, ניסוחים רהוטים יותר וזרימה טובה יותר בין רעיון לרעיון, כדי שהקריאה תהיה רציפה, ברורה וטבעית.`,

    `בסיכומו של דבר, מדובר בגרסה מתוקנת של ${briefTitle} שנועדה להפוך תוכן קיים לחזק ומדויק יותר. אם יעלו הערות נוספות, אפשר להמשיך מכאן לעוד סבב שיפור ממוקד — בין אם ברמת הכותרת, הסגנון, אורך הכתבה או המסרים המרכזיים שצריך להדגיש. בצורה כזאת מתקבלת התקדמות אמיתית, ולא רק החלפה אקראית של משפטים.`,
  ];
}

function buildArticleRevisionOutput(task) {
  const briefTitle = getBriefTitle(task);
  const language = getLanguage(task);
  const previousOutput = getPreviousOutput(task);
  const notes = getRevisionNotes(task);
  const cta = getCTA(task);

  const title = `${normalizeText(previousOutput.title, briefTitle)} – גרסה מעודכנת`;
  const subtitle =
    "הטקסט עודכן לפי ההערות, עם חידוד המסר, שיפור הזרימה והבלטת הנקודות החשובות יותר.";

  const paragraphs = buildArticleRevisionParagraphs(task, previousOutput, notes);
  const articleText = clampWordRange(paragraphs.join("\n\n"), 430, 500);
  const articleHtml = `
<section dir="rtl" lang="${escapeHtml(language)}">
  <h1>${escapeHtml(title)}</h1>
  <h2>${escapeHtml(subtitle)}</h2>
  ${paragraphsToHtml(paragraphs)}
</section>
  `.trim();

  return {
    ok: true,
    note: "copywriter article revision fallback",
    language,
    mode: "revise",
    deliverable: "article",
    target_word_count: getWordCount(task, 450),
    estimated_word_count: countWords(articleText),
    revision_notes_applied: notes,
    title,
    subtitle,
    article_text: articleText,
    article_html: articleHtml,
    cta,
  };
}

function buildAdsCreateOutput(task) {
  const briefTitle = getBriefTitle(task);
  const audience = getAudience(task);
  const angle = getAngle(task);
  const cta = getCTA(task);
  const language = getLanguage(task);

  return {
    ok: true,
    note: "copywriter ads create fallback",
    language,
    mode: "create",
    deliverable: "ads",
    headlines: [
      `${briefTitle} שמדבר לקהל הנכון`,
      `${briefTitle} בזווית ברורה ומשכנעת`,
      `כך מציגים את ${briefTitle} בצורה חכמה יותר`,
      `${briefTitle} עם מסר חד יותר`,
      `${briefTitle} – כשבהירות פוגשת תוצאה`,
    ],
    primary_texts: [
      `כדי לקדם את ${briefTitle} בצורה אפקטיבית יותר, צריך מסר ברור, זווית חזקה והתאמה אמיתית ל־${audience}. זה בדיוק מה שבונה מודעה טובה יותר.`,
      `${briefTitle} יכול לקבל נוכחות שיווקית חזקה יותר כאשר מנסחים אותו סביב ${angle}, שומרים על שפה טבעית, ומובילים את הקורא בצורה ישירה לפעולה.`,
      `במקום ניסוח כללי, נכון לבנות סביב ${briefTitle} מסר מדויק, אמין וקל להבנה — כזה שמחזק עניין, בונה ביטחון ומניע לפעולה.`,
    ],
    angles: [
      angle,
      "בהירות ודיוק במסר",
      "בניית אמון והנעה לפעולה",
    ],
    cta_options: [
      cta,
      "לקבלת מידע נוסף",
      "בואו לראות איך זה עובד",
    ],
  };
}

function buildAdsRevisionOutput(task) {
  const briefTitle = getBriefTitle(task);
  const notes = getRevisionNotes(task);
  const previousOutput = getPreviousOutput(task);
  const cta = getCTA(task);

  const previousHeadlines = Array.isArray(previousOutput.headlines)
    ? previousOutput.headlines
    : [];
  const previousTexts = Array.isArray(previousOutput.primary_texts)
    ? previousOutput.primary_texts
    : [];

  return {
    ok: true,
    note: "copywriter ads revision fallback",
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
      `המודעות עבור ${briefTitle} עודכנו לפי ההערות שניתנו, עם דגש על מסר ברור יותר, ניסוח חד יותר והבלטת הערך המרכזי.`,
      `בוצע חידוד של ההבטחה, שיפור הזרימה והדגשה טובה יותר של התועלת לקורא, כדי להפוך את ${briefTitle} לאפקטיבי יותר ברמת המודעה.`,
      `לאחר סבב התיקונים, המסר סביב ${briefTitle} מרגיש ממוקד, בטוח וברור יותר, עם התאמה טובה יותר למטרה השיווקית.`,
    ],
    cta_options: [
      cta,
      "קבלו מידע נוסף",
      "בדקו התאמה עכשיו",
    ],
  };
}

function parseJsonSafely(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function articleSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      subtitle: { type: "string" },
      article_text: { type: "string" },
      seo_titles: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
      },
      cta: { type: "string" },
    },
    required: ["title", "subtitle", "article_text", "seo_titles", "cta"],
  };
}

function adsSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      headlines: {
        type: "array",
        items: { type: "string" },
        minItems: 5,
        maxItems: 5,
      },
      primary_texts: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
      },
      cta_options: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
      },
      angles: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 3,
      },
    },
    required: ["headlines", "primary_texts", "cta_options", "angles"],
  };
}

async function createStructuredResponse({ model, systemPrompt, userPrompt, schemaName, schema }) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const response = await openai.responses.create({
    model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema,
      },
    },
  });

  const parsed = parseJsonSafely(response.output_text);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("OpenAI returned invalid JSON");
  }

  return parsed;
}

async function generateArticleWithAI(task) {
  const briefTitle = getBriefTitle(task);
  const tone = getTone(task);
  const audience = getAudience(task);
  const angle = getAngle(task);
  const cta = getCTA(task);
  const wordCount = getWordCount(task, 450);
  const keyPoints = getKeyPoints(task);
  const notes = getRevisionNotes(task);
  const previousOutput = getPreviousOutput(task);
  const additionalContext = getAdditionalContext(task);
  const mode = getMode(task);

  const keyPointsText =
    keyPoints.length > 0 ? keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n") : "אין";

  const previousText = normalizeText(previousOutput.article_text, "");
  const previousTitle = normalizeText(previousOutput.title, "");
  const revisionNotesText =
    notes.length > 0 ? notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : "אין";

  const systemPrompt = [
    "אתה קופירייטר ועורך תוכן מקצועי שכותב בעברית טבעית, רהוטה ומשכנעת.",
    "המטרה שלך היא להחזיר JSON בלבד לפי הסכמה שניתנה.",
    "אין להחזיר markdown, אין להחזיר הסברים, אין קוד בלוקים.",
    "כתוב כתבה אמיתית, ולא טקסט שמסביר איך לכתוב כתבה.",
    "אסור להשתמש בניסוחים כמו: 'כאשר כותבים כתבה', 'השלב הבא', 'כתבה טובה צריכה', 'חשוב להתחיל', או כל ניסוח מטא על תהליך הכתיבה.",
    "הטקסט חייב לדבר ישירות על הנושא עצמו, כאילו זו כתבה שמיועדת לפרסום.",
    "כתוב בעברית תקינה, זורמת, טבעית ולא רובוטית.",
    "האורך צריך להיות בערך 450 מילים.",
    "הכתבה חייבת להיות מחולקת לפסקאות ברורות עם ירידות שורה כפולות בין פסקאות.",
    "אל תכתוב רשימות, כותרות משנה ממוספרות או הסבר על מבנה הטקסט.",
  ].join(" ");

  const userPrompt = [
    `סוג משימה: ${mode === "revise" ? "עריכת כתבה קיימת" : "יצירת כתבה חדשה"}`,
    `נושא הכתבה: ${briefTitle}`,
    `שפה: עברית`,
    `טון: ${tone}`,
    `קהל יעד: ${audience}`,
    `זווית מרכזית: ${angle}`,
    `אורך רצוי: ${wordCount} מילים`,
    `CTA רצוי: ${cta}`,
    `מידע נוסף וחופשי על הנושא:\n${additionalContext || "אין"}`,
    `נקודות מפתח להבלטה:\n${keyPointsText}`,
    mode === "revise" ? `כותרת קודמת: ${previousTitle || "אין"}` : "",
    mode === "revise" ? `תוכן קודם:\n${previousText || "אין"}` : "",
    mode === "revise" ? `הערות תיקון:\n${revisionNotesText}` : "",
    "החזר JSON בלבד עם השדות: title, subtitle, article_text, seo_titles, cta.",
    "title צריך להיות כותרת כתבה אמיתית וקצרה.",
    "subtitle צריך להיות תת-כותרת טבעית וקצרה.",
    "article_text חייב להיות כתבה מלאה בעברית על הנושא עצמו, לא על תהליך הכתיבה.",
    "article_text חייב לכלול פסקאות אמיתיות עם שורה ריקה בין כל פסקה.",
    "seo_titles צריך להכיל בדיוק 3 כותרות SEO קצרות וטובות.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const ai = await createStructuredResponse({
    model: "gpt-4.1-mini",
    systemPrompt,
    userPrompt,
    schemaName: "copywriter_article",
    schema: articleSchema(),
  });

  const articleText = clampWordRange(normalizeText(ai.article_text), 430, 500);
  const articleParagraphs = normalizeArticleParagraphs(articleText);

  const finalTitle = normalizeText(ai.title, buildArticleTitle(briefTitle));
  const finalSubtitle = normalizeText(
    ai.subtitle,
    buildArticleSubtitle(audience, angle)
  );
  const finalCta = normalizeText(ai.cta, cta);

  const finalSeoTitles =
    Array.isArray(ai.seo_titles) && ai.seo_titles.length === 3
      ? ai.seo_titles.map((v) => normalizeText(v)).filter(Boolean)
      : buildSeoTitles(briefTitle);

  const finalArticleText = articleParagraphs.join("\n\n");

  const articleHtml = `
<section dir="rtl" lang="he">
  <h1>${escapeHtml(finalTitle)}</h1>
  <h2>${escapeHtml(finalSubtitle)}</h2>
  ${paragraphsToHtml(articleParagraphs)}
</section>
  `.trim();

  return {
    ok: true,
    ai_generated: true,
    note: mode === "revise" ? "copywriter article revision ai" : "copywriter article create ai",
    language: "he",
    mode,
    deliverable: "article",
    target_word_count: wordCount,
    estimated_word_count: countWords(finalArticleText),
    title: finalTitle,
    subtitle: finalSubtitle,
    article_text: finalArticleText,
    article_html: articleHtml,
    seo_titles: finalSeoTitles,
    cta: finalCta,
  };
}

async function generateAdsWithAI(task) {
  const briefTitle = getBriefTitle(task);
  const tone = getTone(task);
  const audience = getAudience(task);
  const angle = getAngle(task);
  const cta = getCTA(task);
  const notes = getRevisionNotes(task);
  const previousOutput = getPreviousOutput(task);
  const additionalContext = getAdditionalContext(task);
  const mode = getMode(task);

  const previousHeadlines = Array.isArray(previousOutput.headlines)
    ? previousOutput.headlines.join("\n")
    : "אין";
  const previousTexts = Array.isArray(previousOutput.primary_texts)
    ? previousOutput.primary_texts.join("\n\n")
    : "אין";
  const revisionNotesText =
    notes.length > 0 ? notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : "אין";

  const systemPrompt = [
    "אתה קופירייטר שיווקי מקצועי שכותב בעברית טבעית, ברורה ומשכנעת.",
    "המטרה שלך היא להחזיר JSON בלבד לפי הסכמה שניתנה.",
    "אין להחזיר markdown, אין הסברים, אין טקסט מחוץ ל-JSON.",
    "כתוב ניסוחים קצרים, חדים, רלוונטיים ומותאמים לקהל היעד.",
  ].join(" ");

  const userPrompt = [
    `סוג משימה: ${mode === "revise" ? "עריכת מודעות קיימות" : "יצירת מודעות חדשות"}`,
    `נושא: ${briefTitle}`,
    `טון: ${tone}`,
    `קהל יעד: ${audience}`,
    `זווית מרכזית: ${angle}`,
    `CTA רצוי: ${cta}`,
    `מידע נוסף:\n${additionalContext || "אין"}`,
    mode === "revise" ? `כותרות קודמות:\n${previousHeadlines}` : "",
    mode === "revise" ? `טקסטים קודמים:\n${previousTexts}` : "",
    mode === "revise" ? `הערות תיקון:\n${revisionNotesText}` : "",
    "החזר JSON בלבד עם השדות: headlines, primary_texts, cta_options, angles.",
    "headlines חייב להכיל בדיוק 5 כותרות.",
    "primary_texts חייב להכיל בדיוק 3 טקסטים.",
    "cta_options חייב להכיל בדיוק 3 אפשרויות.",
    "angles חייב להכיל בדיוק 3 זוויות.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const ai = await createStructuredResponse({
    model: "gpt-4.1-mini",
    systemPrompt,
    userPrompt,
    schemaName: "copywriter_ads",
    schema: adsSchema(),
  });

  return {
    ok: true,
    ai_generated: true,
    note: mode === "revise" ? "copywriter ads revision ai" : "copywriter ads create ai",
    language: "he",
    mode,
    deliverable: "ads",
    headlines: ai.headlines.map((v) => normalizeText(v)).filter(Boolean),
    primary_texts: ai.primary_texts.map((v) => normalizeText(v)).filter(Boolean),
    cta_options: ai.cta_options.map((v) => normalizeText(v)).filter(Boolean),
    angles: ai.angles.map((v) => normalizeText(v)).filter(Boolean),
  };
}

async function runCopywriter(task) {
  const deliverable = getDeliverable(task);
  const type = normalizeText(task.type, "").toLowerCase();
  const mode = getMode(task);

  try {
    if (deliverable === "article" || type === "article") {
      return await generateArticleWithAI(task);
    }

    if (deliverable === "ads" || deliverable === "ad_copy" || type === "ad_copy") {
      return await generateAdsWithAI(task);
    }
  } catch (e) {
    console.error("⚠️ AI copywriter failed, using fallback:", e?.message || e);
  }

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
    note: "copywriter generic output",
    mode,
    deliverable,
    summary: `Generated copy output for ${getBriefTitle(task)}.`,
    hebrew_copy: `נוצר טקסט בסיס עבור ${getBriefTitle(task)}. אפשר להרחיב אותו, לחדד את הטון, או לשלוח סבב תיקונים נוסף לפי צורך.`,
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
      ai_enabled: Boolean(openai),
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

  if (openai) {
    console.log("🤖 OpenAI is enabled for copywriter");
  } else {
    console.log("⚠️ OpenAI is not configured. Using fallback copywriter.");
  }

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
