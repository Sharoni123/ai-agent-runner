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
  return normalizeText(
    input.cta,
    "השאירו פרטים לקבלת מידע נוסף והמשך התאמה אישית."
  );
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
    return raw.map((v) => normalizeText(v)).filter(Boolean).slice(0, 8);
  }

  if (typeof raw === "string") {
    return raw
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 8);
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
    .split(/(?<=[.!?])\s+/)
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
  }

  return words.join(" ");
}

function buildSeoTitles(briefTitle) {
  return [
    `${briefTitle} – הזדמנות נדל"ן שכדאי להכיר`,
    `${briefTitle}: כל מה שחשוב לדעת`,
    `${briefTitle} – מחיר, מיקום ופוטנציאל`,
  ];
}

function buildArticleTitle(briefTitle) {
  return briefTitle;
}

function buildArticleSubtitle(audience, angle) {
  return `בחינה ממוקדת של ההזדמנות, היתרונות והמסר המרכזי סביב ${angle}, בהתאמה ל-${audience}.`;
}

function buildContextSentence(additionalContext) {
  if (!additionalContext) return "";
  return ` מהנתונים שנמסרו עולה כי ${additionalContext}.`;
}

function buildKeyPointsSentence(keyPoints) {
  if (!keyPoints.length) return "";
  return ` בין הנקודות שחשוב לשלב בתמונה הכוללת נמצאות גם ${keyPoints.join(", ")}.`;
}

function buildArticleParagraphs(task) {
  const briefTitle = getBriefTitle(task);
  const audience = getAudience(task);
  const angle = getAngle(task);
  const keyPoints = getKeyPoints(task);
  const additionalContext = getAdditionalContext(task);
  const cta = getCTA(task);

  const contextSentence = buildContextSentence(additionalContext);
  const keyPointsSentence = buildKeyPointsSentence(keyPoints);

  return [
    `${briefTitle} מציב על השולחן הצעה שקשה להתעלם ממנה, במיוחד בתקופה שבה משקיעים מחפשים עסקה שמחברת בין מחיר כניסה נגיש, מיקום נכון ופוטנציאל ברור להשבחה. במקום להסתפק במסר כללי על נדל"ן, כאן מדובר בהזדמנות שמכוונת בדיוק למה שמעניין היום קהל שמחפש ערך אמיתי: להבין איפה נמצא היתרון, למה דווקא עכשיו, ואיך עסקה אחת יכולה לייצר שילוב בין סיכוי כלכלי גבוה לבין תחושת ביטחון גדולה יותר בהחלטה.${contextSentence}`,

    `אחד היתרונות המשמעותיים בעסקה מהסוג הזה הוא היכולת להיכנס לשוק עם תנאי פתיחה אטרקטיביים יחסית, מבלי להידרש בהכרח להון עצום כבר בשלב הראשון. עבור ${audience}, זהו בדיוק המקום שבו ההבדל בין עסקה “מעניינת” לעסקה “חזקה” מתחיל להתבהר. כאשר המחיר מדויק, המיקום נכון והסיפור הכולל יושב על היגיון מסחרי ברור, הרבה יותר קל לראות איך ההזדמנות הזו לא נשענת רק על חלום, אלא על יסודות שמאפשרים לה להיראות רלוונטית גם בטווח הקרוב וגם בטווח הארוך.`,

    `הזווית המרכזית כאן היא ${angle}, ולכן חשוב לבחון לא רק את המחיר או את הכותרת הראשית, אלא את מכלול המרכיבים שהופכים את ההצעה למשמעותית באמת. מיקום טוב, נגישות, ביקוש פוטנציאלי, סביבת פיתוח ותנאים מסחריים נוחים הם לא פרטים שוליים, אלא הלב של העסקה כולה.${keyPointsSentence} כשמחברים את כל המרכיבים האלה יחד, מתקבלת תמונה רחבה יותר: לא רק נכס או יחידה על הנייר, אלא מהלך שיכול להתאים למי שמבקש לזהות מראש את המקומות שבהם פוטנציאל כלכלי פוגש מחיר נכון.`,

    `מעבר לנתונים עצמם, יש כאן גם היגיון שיווקי ונדל"ני ברור. שוק שמציע הזדמנויות אמיתיות הוא בדרך כלל שוק שבו קיימת תנועה, קיימת ציפייה להמשך התפתחות, וקיימת סיבה טובה לכך שקהל רחב מגלה עניין. זו בדיוק הנקודה שבה משקיעים מנוסים שואלים לא רק “כמה זה עולה”, אלא גם “מה הסיפור שמאחורי זה”, “מה עשוי לקרות בהמשך”, ו”איפה נמצאת נקודת היתרון ביחס לאלטרנטיבות אחרות”. כאשר יש תשובות טובות לשאלות הללו, העסקה מתחילה להיראות הרבה יותר מגובשת, רצינית ובעלת פוטנציאל ממשי.`,

    `לצד זה, חשוב לזכור שגם בנדל"ן, כמו בכל תחום השקעה, ההבדל המשמעותי נמצא לא פעם ביכולת לזהות מוקדם הזדמנות שמציעה יתרון תמחורי או יתרון מיקומי לפני שהשוק הרחב מתמחר אותה במלואה. זו בדיוק הסיבה שבגללה עסקאות מסוימות מייצרות עניין מיוחד: הן מצליחות לחבר בין כניסה נוחה יותר לבין אופק שיכול להיות חזק יותר בעתיד. עבור מי שמבקש לבנות תיק חכם, לגוון השקעות או לבחון מהלך חדש, מדובר בזווית שמצדיקה בדיקה רצינית ולא רק הסתכלות שטחית.`,

    `בשורה התחתונה, ${briefTitle} הוא מהלך שמבקש לדבר בשפה שכל משקיע רוצה לשמוע: מחיר ברור, היגיון ברור ופוטנציאל ברור יותר. כאשר העסקה נשענת על נתונים נכונים, על מיקום שיודע לייצר עניין ועל מסר שיווקי שמחובר למציאות, היא מצליחה לבלוט בשוק עמוס אפשרויות. מי שמחפש את ההזדמנות הבאה שלו לא צריך להסתפק בכותרת טובה בלבד — אלא לבדוק לעומק, לשאול את השאלות הנכונות ולבחון אם זו בדיוק הנקודה שבה כדאי להיכנס. ${cta}`,
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
  const finalParagraphs = normalizeArticleParagraphs(articleText);

  const articleHtml = `
<section dir="rtl" lang="${escapeHtml(language)}">
  <h1>${escapeHtml(title)}</h1>
  <h2>${escapeHtml(subtitle)}</h2>
  ${paragraphsToHtml(finalParagraphs)}
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
    article_text: finalParagraphs.join("\n\n"),
    article_html: articleHtml,
    seo_titles: buildSeoTitles(briefTitle),
    cta,
  };
}

function buildArticleRevisionParagraphs(task, previousOutput, notes) {
  const briefTitle = getBriefTitle(task);
  const additionalContext = getAdditionalContext(task);
  const notesText = notes.length
    ? notes.join("; ")
    : "בוצע חידוד כללי של המסר, הזרימה והניסוח.";
  const prevText = normalizeText(previousOutput.article_text, "");

  return [
    `${briefTitle} מוצג כאן בגרסה מחודשת ומדויקת יותר, לאחר מעבר על ההערות שנמסרו ועל הכיוון שהתוכן צריך להעביר. המטרה בעדכון כזה אינה לשנות סתם מילים, אלא לחזק את מה שחשוב באמת: הכותרת, הזווית, הזרימה והיכולת של הכתבה להציג את ההזדמנות בצורה משכנעת, טבעית וברורה יותר.`,

    `במסגרת העדכון הוטמעו ההערות המרכזיות שעלו: ${notesText} המשמעות היא שהתוכן לא רק “תוקן”, אלא עבר שיפור שמחזק את הקריאות, מדייק את המסרים ומשפר את הדרך שבה הקורא פוגש את הערך של ההצעה כבר מהפסקאות הראשונות. ${additionalContext ? `בנוסף, נשמר חיבור ישיר גם למידע המשלים שנמסר: ${additionalContext}.` : ""}`,

    `כאשר בוחנים כתבה שיווקית טובה, מה שחשוב הוא לא רק אילו נתונים מוצגים, אלא גם איך הם מוגשים. לכן נעשה כאן מאמץ להחליק את המעברים בין הרעיונות, להסיר ניסוחים חלשים או כלליים מדי, ולחדד את המקומות שבהם הכתבה צריכה להרגיש בטוחה יותר, מקצועית יותר ורלוונטית יותר למי שקורא אותה בפועל.`,

    `הגרסה הקודמת כללה בין היתר את הפתיחה הבאה: ${prevText.slice(0, 220)}${prevText.length > 220 ? "..." : ""} מתוך הבסיס הזה בוצע שכתוב שמבקש לשמור על מה שהיה נכון, אבל לשפר את המקומות שהיו זקוקים לדיוק, להעמקה או לנוכחות חזקה יותר של המסר המרכזי.`,

    `בפועל, כתבה שיווקית חזקה צריכה לגרום לקורא להבין במהירות מה מייחד את ההזדמנות, מה מצדיק את הבדיקה שלה, ואיזה ערך היא עשויה לייצר. זו הסיבה שהנוסח החדש מקפיד יותר על איזון בין תוכן ענייני לבין שפה שיווקית בטוחה, מבלי לגלוש להגזמות או לניסוחים מלאכותיים מדי.`,

    `בסופו של דבר, ${briefTitle} בגרסה הזו נועד להרגיש שלם, מהודק ומשכנע יותר. אם יהיה צורך, אפשר להמשיך מכאן לעוד סבב חידוד ממוקד — בין אם ברמת הטון, הכותרת, אורך הכתבה או ההדגשים המרכזיים — אבל כבר עכשיו מדובר בנוסח שמכוון טוב יותר למטרה שלו ומשקף את ההזדמנות בצורה בשלה יותר.`,
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
    "נוסח מחודש עם חידוד המסר, שיפור הזרימה והבלטה ברורה יותר של היתרונות המרכזיים.";

  const paragraphs = buildArticleRevisionParagraphs(task, previousOutput, notes);
  const articleText = clampWordRange(paragraphs.join("\n\n"), 430, 500);
  const finalParagraphs = normalizeArticleParagraphs(articleText);

  const articleHtml = `
<section dir="rtl" lang="${escapeHtml(language)}">
  <h1>${escapeHtml(title)}</h1>
  <h2>${escapeHtml(subtitle)}</h2>
  ${paragraphsToHtml(finalParagraphs)}
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
    article_text: finalParagraphs.join("\n\n"),
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
    "אתה קופירייטר נדל\"ן מקצועי שכותב בעברית טבעית, שיווקית, זורמת ואמינה.",
    "אתה כותב כתבה אמיתית שמיועדת לפרסום באתר חדשות/נדל\"ן, בסגנון איכותי של כתבה שיווקית מקצועית.",
    "אסור לכתוב מטא-טקסט או הסברים על תהליך הכתיבה.",
    "אסור להשתמש בביטויים כמו: 'כאשר כותבים כתבה', 'חשוב להדגיש', 'כתבה טובה צריכה', 'השלב הבא', 'הקורא צריך להבין', 'טקסט שיווקי טוב', 'כדי שכתבה תעבוד'.",
    "הטקסט חייב לדבר ישירות על הנושא עצמו.",
    "החזר JSON בלבד לפי הסכמה שניתנה.",
    "אין markdown, אין הסברים, אין טקסט מחוץ ל-JSON.",
    "article_text חייב להיות מחולק לפסקאות עם שורה ריקה בין כל פסקה.",
    "כתוב בטון בטוח, מקצועי, חד, זורם, אמין ולא רובוטי.",
    "כתוב כתבה מלאה באורך 420-480 מילים.",
  ].join(" ");

  const userPrompt = [
    `כתוב כתבה שיווקית מקצועית בעברית לפרסום באתר.`,
    `נושא הכתבה: ${briefTitle}`,
    `אורך מבוקש: 420-480 מילים`,
    `קהל יעד: ${audience}`,
    `טון: ${tone}`,
    `זווית מרכזית: ${angle}`,
    `CTA רצוי: ${cta}`,
    `מידע נוסף על הנושא:\n${additionalContext || "אין"}`,
    `נקודות חשובות לשילוב:\n${keyPointsText}`,
    mode === "revise" ? `כותרת קודמת:\n${previousTitle || "אין"}` : "",
    mode === "revise" ? `תוכן קודם:\n${previousText || "אין"}` : "",
    mode === "revise" ? `הערות תיקון:\n${revisionNotesText}` : "",
    "החזר JSON בלבד עם השדות: title, subtitle, article_text, seo_titles, cta.",
    "title = כותרת כתבה אמיתית, חדה ומקצועית.",
    "subtitle = תת-כותרת אמיתית, קצרה וטבעית.",
    "article_text = כתבה מלאה על הנושא עצמו, כאילו עולה עכשיו לאתר נדל\"ן.",
    "אסור שהטקסט יסביר איך כותבים כתבה.",
    "seo_titles = בדיוק 3 כותרות SEO.",
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

  const bannedPatterns = [
    "כאשר כותבים כתבה",
    "כתבה טובה",
    "השלב הבא",
    "חשוב להתחיל",
    "הקורא צריך להבין",
    "טקסט שיווקי טוב",
    "כדי שכתבה תעבוד",
    "הכתבה צריכה",
  ];

  const aiArticleText = normalizeText(ai.article_text);

  if (bannedPatterns.some((pattern) => aiArticleText.includes(pattern))) {
    throw new Error("AI returned meta-writing text instead of a real article");
  }

  const articleText = clampWordRange(aiArticleText, 430, 500);
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
  planner: async () => {
    return {
      ok: true,
      note: "planner placeholder",
      next: ["ad_copy", "banner_set", "landing_page", "article", "video", "qa_review"],
    };
  },

  copywriter: async (task) => {
    return await runCopywriter(task);
  },

  visual_director: async () => {
    return {
      ok: true,
      note: "visual_director placeholder",
      prompts: ["prompt 1", "prompt 2"],
    };
  },

  image_generator: async () => {
    return {
      ok: true,
      note: "image_generator placeholder",
      images: [],
    };
  },

  banner_renderer: async () => {
    return {
      ok: true,
      note: "banner_renderer placeholder",
      banners: [],
    };
  },

  landing_page_builder: async () => {
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

  video_producer: async () => {
    return {
      ok: true,
      note: "video_producer placeholder",
      script: "תסריט קצר לדוגמה",
    };
  },

  qa: async () => {
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
