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

async function logActivity({
  event,
  agent,
  details = {},
  campaign_id = null,
  task_id = null,
}) {
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

  if (typeof value === "number") {
    return String(value);
  }

  return fallback;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => normalizeText(v)).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return [];
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

function getAssets(task) {
  const input = getTaskInput(task);
  const rawAssets =
    input.assets && typeof input.assets === "object" ? input.assets : {};

  const logos = normalizeStringArray(
    rawAssets.logos || input.logo_urls || input.logos
  );
  const images = normalizeStringArray(
    rawAssets.images || input.image_urls || input.images
  );
  const inspiration = normalizeStringArray(
    rawAssets.inspiration || input.inspiration_urls || input.inspiration
  );

  return {
    logos,
    images,
    inspiration,
    all: [...logos, ...images, ...inspiration],
  };
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

function buildAssetsSummaryText(assets) {
  const parts = [];

  if (assets.logos.length) {
    parts.push(`לוגואים: ${assets.logos.join(", ")}`);
  }

  if (assets.images.length) {
    parts.push(`תמונות שסופקו: ${assets.images.join(", ")}`);
  }

  if (assets.inspiration.length) {
    parts.push(`קישורי השראה: ${assets.inspiration.join(", ")}`);
  }

  return parts.join(" | ");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return "";
}

function pickArray(value) {
  return Array.isArray(value) ? value.map((v) => normalizeText(v)).filter(Boolean) : [];
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

function visualDirectorSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      creative_direction: { type: "string" },
      visual_style: { type: "string" },
      color_palette: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 6,
      },
      banner_brief: { type: "string" },
      landing_page_brief: { type: "string" },
      video_brief: { type: "string" },
      image_prompts: {
        type: "array",
        items: { type: "string" },
        minItems: 2,
        maxItems: 4,
      },
      banner_headlines: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 5,
      },
    },
    required: [
      "creative_direction",
      "visual_style",
      "color_palette",
      "banner_brief",
      "landing_page_brief",
      "video_brief",
      "image_prompts",
      "banner_headlines",
    ],
  };
}

function bannerRendererSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      master_direction: { type: "string" },
      visual_style: { type: "string" },
      color_palette: {
        type: "array",
        items: { type: "string" },
        minItems: 3,
        maxItems: 6,
      },
      global_design_notes: { type: "string" },
      banners: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            size: { type: "string" },
            headline: { type: "string" },
            subheadline: { type: "string" },
            cta: { type: "string" },
            layout: { type: "string" },
            visual_focus: { type: "string" },
            asset_usage: { type: "string" },
            image_prompt: { type: "string" },
            design_notes: { type: "string" },
          },
          required: [
            "name",
            "size",
            "headline",
            "subheadline",
            "cta",
            "layout",
            "visual_focus",
            "asset_usage",
            "image_prompt",
            "design_notes",
          ],
        },
      },
    },
    required: [
      "master_direction",
      "visual_style",
      "color_palette",
      "global_design_notes",
      "banners",
    ],
  };
}

async function createStructuredResponse({
  model,
  systemPrompt,
  userPrompt,
  schemaName,
  schema,
}) {
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
    'אתה קופירייטר נדל"ן מקצועי שכותב בעברית טבעית, שיווקית, זורמת ואמינה.',
    'אתה כותב כתבה אמיתית שמיועדת לפרסום באתר חדשות/נדל"ן, בסגנון איכותי של כתבה שיווקית מקצועית.',
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
    'article_text = כתבה מלאה על הנושא עצמו, כאילו עולה עכשיו לאתר נדל"ן.',
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

async function generateVisualDirectionWithAI(task) {
  const briefTitle = getBriefTitle(task);
  const tone = getTone(task);
  const audience = getAudience(task);
  const angle = getAngle(task);
  const cta = getCTA(task);
  const additionalContext = getAdditionalContext(task);
  const keyPoints = getKeyPoints(task);
  const assets = getAssets(task);
  const plannerBrief = getTaskInput(task).planner_brief ?? null;

  const assetsText = buildAssetsSummaryText(assets) || "לא סופקו נכסים ויזואליים";
  const plannerBriefText = plannerBrief
    ? JSON.stringify(plannerBrief, null, 2)
    : "אין";

  const systemPrompt = [
    "אתה מנהל קריאייטיב וארט דיירקטור שיווקי בכיר.",
    "אתה בונה כיוון ויזואלי ברור, ישים ומסחרי לקמפיין נדל\"ן.",
    "אתה מחזיר JSON בלבד לפי הסכמה שניתנה.",
    "אין markdown, אין הסברים, אין טקסט מחוץ ל-JSON.",
    "התוצרים צריכים להיות פרקטיים ולהתאים ליצירת באנרים, תמונות, דף נחיתה וסרטון.",
    "אם סופקו לוגואים, תמונות או לינקי השראה — צריך להתייחס אליהם כאל חומרים מחייבים.",
    "כתוב בעברית טבעית וברורה.",
  ].join(" ");

  const userPrompt = [
    `בנה כיוון קריאייטיב מלא לקמפיין הזה.`,
    `נושא: ${briefTitle}`,
    `קהל יעד: ${audience}`,
    `טון: ${tone}`,
    `זווית מרכזית: ${angle}`,
    `CTA: ${cta}`,
    `מידע נוסף:\n${additionalContext || "אין"}`,
    `נקודות מפתח:\n${keyPoints.length ? keyPoints.join("\n") : "אין"}`,
    `Assets שסופקו:\n${assetsText}`,
    `Planner brief:\n${plannerBriefText}`,
    "החזר JSON בלבד עם השדות:",
    "creative_direction, visual_style, color_palette, banner_brief, landing_page_brief, video_brief, image_prompts, banner_headlines",
    "image_prompts צריכים להיות prompts מוכנים ליצירת תמונות שיווקיות.",
    "banner_brief צריך להיות תיאור ברור לבאנרים.",
    "landing_page_brief צריך להסביר איך דף הנחיתה צריך להיראות ולהרגיש.",
    "video_brief צריך להיות כיוון קצר וברור לסרטון שיווקי.",
  ].join("\n\n");

  const ai = await createStructuredResponse({
    model: "gpt-4.1-mini",
    systemPrompt,
    userPrompt,
    schemaName: "visual_director_brief",
    schema: visualDirectorSchema(),
  });

  return {
    ok: true,
    ai_generated: true,
    note: "visual_director ai",
    brief_title: briefTitle,
    planner_brief: plannerBrief,
    assets,
    creative_direction: normalizeText(ai.creative_direction),
    visual_style: normalizeText(ai.visual_style),
    color_palette: Array.isArray(ai.color_palette)
      ? ai.color_palette.map((v) => normalizeText(v)).filter(Boolean)
      : [],
    banner_brief: normalizeText(ai.banner_brief),
    landing_page_brief: normalizeText(ai.landing_page_brief),
    video_brief: normalizeText(ai.video_brief),
    image_prompts: Array.isArray(ai.image_prompts)
      ? ai.image_prompts.map((v) => normalizeText(v)).filter(Boolean)
      : [],
    banner_headlines: Array.isArray(ai.banner_headlines)
      ? ai.banner_headlines.map((v) => normalizeText(v)).filter(Boolean)
      : [],
  };
}

async function listSiblingTasksForSourceTask(sourceTaskId) {
  try {
    return await pb.collection("tasks").getFullList({
      filter: `input_data.source_task_id = "${sourceTaskId}"`,
      sort: "-created",
    });
  } catch {
    const allTasks = await pb.collection("tasks").getFullList({
      sort: "-created",
    });

    return allTasks.filter(
      (item) => item?.input_data?.source_task_id === sourceTaskId
    );
  }
}

function buildBannerRendererFallback(task, related = {}) {
  const briefTitle = getBriefTitle(task);
  const cta = getCTA(task);
  const assets = getAssets(task);
  const visual = related.visualOutput || {};
  const ads = related.adOutput || {};

  const bannerHeadlines = pickArray(visual.banner_headlines);
  const adHeadlines = pickArray(ads.headlines);
  const primaryTexts = pickArray(ads.primary_texts);

  const baseHeadline =
    firstNonEmpty(
      bannerHeadlines[0],
      adHeadlines[0],
      briefTitle
    ) || briefTitle;

  const secondHeadline =
    firstNonEmpty(
      bannerHeadlines[1],
      adHeadlines[1],
      "הזדמנות שכדאי להכיר"
    ) || "הזדמנות שכדאי להכיר";

  const thirdHeadline =
    firstNonEmpty(
      bannerHeadlines[2],
      adHeadlines[2],
      "זה בדיוק הזמן להיכנס"
    ) || "זה בדיוק הזמן להיכנס";

  const sharedSubheadline =
    firstNonEmpty(
      primaryTexts[0],
      visual.banner_brief,
      getAdditionalContext(task),
      "שילוב של מסר ברור, ויזואל חזק וקריאה ברורה לפעולה."
    );

  const assetUsageText = assets.all.length
    ? `יש להשתמש בנכסים שסופקו לפי התאמה: ${assets.all.join(", ")}`
    : "אם אין נכסים מוכנים, יש לעבוד עם ויזואל נדל\"ני יוקרתי, נקי ומכירתי.";

  const visualStyle = firstNonEmpty(
    visual.visual_style,
    "מודרני, אלגנטי, יוקרתי, מסחרי ונקי"
  );

  const masterDirection = firstNonEmpty(
    visual.creative_direction,
    "באנרים שיווקיים חזקים עם היררכיה ברורה, כותרת בולטת, תמונה חזקה וקריאה לפעולה."
  );

  const colorPalette = pickArray(visual.color_palette).length
    ? pickArray(visual.color_palette)
    : ["#0F172A", "#FFFFFF", "#D4AF37", "#10B981"];

  const imagePromptBase = firstNonEmpty(
    pickArray(visual.image_prompts)[0],
    `צור תמונת נדל"ן שיווקית עבור ${briefTitle} בסגנון פרימיום, מודרני, נקי, עם תאורה טבעית ותחושת יוקרה`
  );

  return {
    ok: true,
    note: "banner_renderer fallback",
    brief_title: briefTitle,
    planner_brief: getTaskInput(task).planner_brief ?? null,
    assets,
    related_sources: {
      visual_task_found: Boolean(related.visualTask),
      ad_task_found: Boolean(related.adTask),
    },
    master_direction: masterDirection,
    visual_style: visualStyle,
    color_palette: colorPalette,
    global_design_notes:
      "לשמור על היררכיה ברורה: כותרת ראשית חזקה, אזור ויזואלי נקי, מספר/יתרון מרכזי, וכפתור או CTA ברור. לא להעמיס יותר מדי טקסט.",
    banners: [
      {
        name: "square_main",
        size: "1080x1080",
        headline: baseHeadline,
        subheadline: sharedSubheadline,
        cta,
        layout:
          "כותרת עליונה גדולה, ויזואל מרכזי, שורת תועלת קצרה, CTA בתחתית, מקום ללוגו בפינה.",
        visual_focus:
          "ויזואל מרכזי נקי וחזק עם תחושת פרימיום ונדל\"ן איכותי.",
        asset_usage: assetUsageText,
        image_prompt: `${imagePromptBase}. הפורמט צריך להתאים לבאנר ריבועי 1080x1080 עם אזור נקי לטקסט.`,
        design_notes:
          "להבליט את הכותרת, לשמור על ניגודיות גבוהה, ולאפשר קריאות מהירה גם במובייל.",
      },
      {
        name: "story_vertical",
        size: "1080x1920",
        headline: secondHeadline,
        subheadline: sharedSubheadline,
        cta,
        layout:
          "מבנה אנכי: כותרת עליונה, ויזואל גבוה במרכז, CTA באזור תחתון ברור, עם מקום ללוגו ולדיסקליימר קצר.",
        visual_focus:
          "תמונה אנכית, נקייה, עם תחושת גובה, יוקרה ותנועה טבעית לעין.",
        asset_usage: assetUsageText,
        image_prompt: `${imagePromptBase}. הפורמט צריך להתאים לסטורי אנכי 1080x1920 עם אזור טקסט עליון ותחתון.`,
        design_notes:
          "לשמור על safe areas לסטורי, לא להצמיד טקסט לקצוות, ולתת מקום לנשימה.",
      },
      {
        name: "landscape_display",
        size: "1200x628",
        headline: thirdHeadline,
        subheadline: sharedSubheadline,
        cta,
        layout:
          "כותרת בצד אחד, ויזואל בצד השני, תועלת קצרה מתחת לכותרת, וכפתור בולט או אזור CTA.",
        visual_focus:
          "קומפוזיציה רחבה, נקייה ומסחרית שמתאימה למדיה חברתית ולדיספליי.",
        asset_usage: assetUsageText,
        image_prompt: `${imagePromptBase}. הפורמט צריך להתאים לבאנר רוחבי 1200x628 עם שטח נקי לטקסט.`,
        design_notes:
          "להשתמש בהיררכיה חדה, מעט טקסט, ותמונה שנותנת מיד תחושת השקעה/פרימיום.",
      },
    ],
  };
}

async function generateBannerSetWithAI(task, related = {}) {
  const briefTitle = getBriefTitle(task);
  const assets = getAssets(task);
  const visual = related.visualOutput || {};
  const ads = related.adOutput || {};
  const additionalContext = getAdditionalContext(task);
  const cta = getCTA(task);

  const visualPayload = JSON.stringify(visual || {}, null, 2);
  const adsPayload = JSON.stringify(ads || {}, null, 2);
  const assetsText = buildAssetsSummaryText(assets) || "לא סופקו נכסים";
  const plannerBriefText = JSON.stringify(getTaskInput(task).planner_brief ?? {}, null, 2);

  const systemPrompt = [
    "אתה Senior Banner Designer + Creative Strategist.",
    "המטרה שלך היא להכין חבילת באנרים פרקטית ומוכנה לביצוע עבור קמפיין נדל\"ן.",
    "אתה מחזיר JSON בלבד לפי הסכמה שניתנה.",
    "אין markdown, אין טקסט מחוץ ל-JSON.",
    "הבאנרים חייבים להיות ישימים בפועל, קצרים, חדים, מסחריים ומסודרים.",
    "התייחס ל-output של visual_director כבסיס מחייב לעיצוב.",
    "אם יש output של מודעות, השתמש בו כדי לחזק כותרות ותועלות.",
    "כתוב בעברית ברורה.",
  ].join(" ");

  const userPrompt = [
    `צור חבילת באנרים מלאה עבור הקמפיין: ${briefTitle}`,
    `CTA: ${cta}`,
    `מידע נוסף:\n${additionalContext || "אין"}`,
    `Assets:\n${assetsText}`,
    `Planner brief:\n${plannerBriefText}`,
    `Visual director output:\n${visualPayload}`,
    `Ad copy output:\n${adsPayload}`,
    "החזר JSON בלבד עם השדות:",
    "master_direction, visual_style, color_palette, global_design_notes, banners",
    "banners חייב להכיל בדיוק 3 באנרים:",
    "1. square_main בגודל 1080x1080",
    "2. story_vertical בגודל 1080x1920",
    "3. landscape_display בגודל 1200x628",
    "לכל באנר חייבים להיות השדות:",
    "name, size, headline, subheadline, cta, layout, visual_focus, asset_usage, image_prompt, design_notes",
    "headline צריך להיות קצר וחזק.",
    "subheadline צריך להיות קצר, מסחרי וברור.",
    "image_prompt צריך להיות מוכן ליצירת ויזואל תואם.",
  ].join("\n\n");

  const ai = await createStructuredResponse({
    model: "gpt-4.1-mini",
    systemPrompt,
    userPrompt,
    schemaName: "banner_renderer_package",
    schema: bannerRendererSchema(),
  });

  return {
    ok: true,
    ai_generated: true,
    note: "banner_renderer ai",
    brief_title: briefTitle,
    planner_brief: getTaskInput(task).planner_brief ?? null,
    assets,
    related_sources: {
      visual_task_found: Boolean(related.visualTask),
      ad_task_found: Boolean(related.adTask),
    },
    master_direction: normalizeText(ai.master_direction),
    visual_style: normalizeText(ai.visual_style),
    color_palette: pickArray(ai.color_palette),
    global_design_notes: normalizeText(ai.global_design_notes),
    banners: Array.isArray(ai.banners)
      ? ai.banners.map((banner) => ({
          name: normalizeText(banner.name),
          size: normalizeText(banner.size),
          headline: normalizeText(banner.headline),
          subheadline: normalizeText(banner.subheadline),
          cta: normalizeText(banner.cta, cta),
          layout: normalizeText(banner.layout),
          visual_focus: normalizeText(banner.visual_focus),
          asset_usage: normalizeText(banner.asset_usage),
          image_prompt: normalizeText(banner.image_prompt),
          design_notes: normalizeText(banner.design_notes),
        }))
      : [],
  };
}

async function runBannerRenderer(task) {
  const input = getTaskInput(task);
  const sourceTaskId = normalizeText(input.source_task_id, "");
  let siblings = [];

  if (sourceTaskId) {
    siblings = await listSiblingTasksForSourceTask(sourceTaskId);
  }

  const visualTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase() === "visual_prompts" &&
      normalizeText(item.status).toLowerCase() === "done"
  );

  const adTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase() === "ad_copy" &&
      normalizeText(item.status).toLowerCase() === "done"
  );

  const related = {
    visualTask,
    adTask,
    visualOutput:
      visualTask && visualTask.output_data && typeof visualTask.output_data === "object"
        ? visualTask.output_data
        : {},
    adOutput:
      adTask && adTask.output_data && typeof adTask.output_data === "object"
        ? adTask.output_data
        : {},
  };

  try {
    return await generateBannerSetWithAI(task, related);
  } catch (e) {
    console.error("⚠️ AI banner_renderer failed, using fallback:", e?.message || e);
    return buildBannerRendererFallback(task, related);
  }
}

function buildNormalizedBrief(task) {
  const input = getTaskInput(task);
  const assets = getAssets(task);

  return {
    title: getBriefTitle(task),
    context: getAdditionalContext(task),
    language: getLanguage(task),
    tone: getTone(task),
    audience: getAudience(task),
    angle: getAngle(task),
    cta: getCTA(task),
    word_count: getWordCount(task, 450),
    key_points: getKeyPoints(task),
    offer: normalizeText(input.offer, ""),
    location: normalizeText(input.location, ""),
    campaign_type: normalizeText(
      input.campaign_type,
      normalizeText(task.type, "campaign_plan")
    ),
    assets,
  };
}

function getAgentForTaskType(taskType) {
  switch (taskType) {
    case "article":
    case "ad_copy":
      return "copywriter";
    case "visual_prompts":
      return "visual_director";
    case "background_images":
      return "image_generator";
    case "banner_set":
      return "banner_renderer";
    case "landing_page":
      return "landing_page_builder";
    case "video":
      return "video_producer";
    case "qa_review":
      return "qa";
    default:
      return "planner";
  }
}

function getDeliverableForTaskType(taskType) {
  if (taskType === "article") return "article";
  if (taskType === "ad_copy") return "ads";
  return taskType;
}

function buildPlannerChildren(task, normalizedBrief) {
  const baseTitle = normalizedBrief.title;
  const baseInput = {
    source_task_id: task.id,
    source_type: task.type ?? "campaign_plan",
    planner_task_id: task.id,
    brief_title: baseTitle,
    additional_context: normalizedBrief.context,
    language: normalizedBrief.language,
    tone: normalizedBrief.tone,
    audience: normalizedBrief.audience,
    angle: normalizedBrief.angle,
    cta: normalizedBrief.cta,
    word_count: normalizedBrief.word_count,
    key_points: normalizedBrief.key_points,
    planner_brief: normalizedBrief,
    assets: normalizedBrief.assets,
  };

  return [
    {
      title: `Write ad copy for: ${baseTitle}`,
      type: "ad_copy",
      assigned_agent: "copywriter",
      priority: "high",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "ads",
      },
    },
    {
      title: `Write article for: ${baseTitle}`,
      type: "article",
      assigned_agent: "copywriter",
      priority: "normal",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "article",
      },
    },
    {
      title: `Create visual prompts for: ${baseTitle}`,
      type: "visual_prompts",
      assigned_agent: "visual_director",
      priority: "normal",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "visual_prompts",
      },
    },
    {
      title: `Generate images for: ${baseTitle}`,
      type: "background_images",
      assigned_agent: "image_generator",
      priority: "normal",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "background_images",
      },
    },
    {
      title: `Prepare banner set for: ${baseTitle}`,
      type: "banner_set",
      assigned_agent: "banner_renderer",
      priority: "normal",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "banner_set",
      },
    },
    {
      title: `Build landing page for: ${baseTitle}`,
      type: "landing_page",
      assigned_agent: "landing_page_builder",
      priority: "normal",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "landing_page",
      },
    },
    {
      title: `Produce video for: ${baseTitle}`,
      type: "video",
      assigned_agent: "video_producer",
      priority: "normal",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "video",
      },
    },
    {
      title: `QA review for: ${baseTitle}`,
      type: "qa_review",
      assigned_agent: "qa",
      priority: "normal",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "qa_review",
      },
    },
  ];
}

async function listExistingChildTasks(sourceTaskId) {
  try {
    return await pb.collection("tasks").getFullList({
      filter: `input_data.source_task_id = "${sourceTaskId}"`,
      sort: "-created",
    });
  } catch {
    const allTasks = await pb.collection("tasks").getFullList({
      sort: "-created",
    });

    return allTasks.filter(
      (item) => item?.input_data?.source_task_id === sourceTaskId
    );
  }
}

async function runPlanner(task) {
  const normalizedBrief = buildNormalizedBrief(task);
  const plannedChildren = buildPlannerChildren(task, normalizedBrief);
  const existingChildren = await listExistingChildTasks(task.id);

  const existingTypes = new Set(
    existingChildren
      .map((child) => normalizeText(child.type).toLowerCase())
      .filter(Boolean)
  );

  const createdChildren = [];

  for (const child of plannedChildren) {
    const childType = normalizeText(child.type).toLowerCase();
    if (existingTypes.has(childType)) {
      continue;
    }

    const created = await pb.collection("tasks").create(child);
    createdChildren.push({
      id: created.id,
      title: created.title,
      type: created.type,
      assigned_agent: created.assigned_agent,
      status: created.status,
    });

    await logActivity({
      event: "planner_child_created",
      agent: "planner",
      campaign_id: task.campaign_id,
      task_id: task.id,
      details: {
        child_task_id: created.id,
        child_type: created.type,
        child_title: created.title,
      },
    });
  }

  return {
    ok: true,
    note: "planner created campaign workflow",
    deliverable: "campaign_plan",
    normalized_brief: normalizedBrief,
    assets_summary: {
      logos: normalizedBrief.assets.logos.length,
      images: normalizedBrief.assets.images.length,
      inspiration: normalizedBrief.assets.inspiration.length,
      total: normalizedBrief.assets.all.length,
    },
    existing_children_count: existingChildren.length,
    created_children_count: createdChildren.length,
    created_children: createdChildren,
    next: plannedChildren.map((child) => ({
      type: child.type,
      assigned_agent: child.assigned_agent,
      title: child.title,
    })),
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
    return await runPlanner(task);
  },

  copywriter: async (task) => {
    return await runCopywriter(task);
  },

  visual_director: async (task) => {
    try {
      return await generateVisualDirectionWithAI(task);
    } catch (e) {
      console.error("⚠️ AI visual_director failed, using fallback:", e?.message || e);
      return {
        ok: true,
        note: "visual_director fallback",
        brief_title: getBriefTitle(task),
        planner_brief: getTaskInput(task).planner_brief ?? null,
        assets: getAssets(task),
        creative_direction:
          "קו יוקרתי, נקי ומכירתי שמחבר בין אמינות, הזדמנות, פרימיום ונגישות.",
        visual_style:
          'מודרני, אלגנטי, נדל"ני, עם היררכיה ברורה בין כותרת, מספרים, תמונה וקריאה לפעולה.',
        color_palette: ["#0F172A", "#FFFFFF", "#D4AF37", "#10B981"],
        banner_brief:
          'באנרים צריכים לשלב כותרת חדה, מספר מרכזי בולט, תמונת נדל"ן חזקה ותחושת פרימיום.',
        landing_page_brief:
          "דף נחיתה צריך להיראות יוקרתי, מהיר, ברור, עם אזור Hero חזק, יתרונות, טופס והשימוש בנכסים שסופקו.",
        video_brief:
          "סרטון קצר עם פתיחה חזקה, הדגשת מחיר/מיקום/יתרון מרכזי וסיום עם קריאה ברורה לפעולה.",
        image_prompts: [
          `צור תמונת נדל"ן שיווקית עבור ${getBriefTitle(task)} בסגנון יוקרתי, מודרני, נקי, עם תאורה טבעית, קומפוזיציה חזקה ואווירת פרימיום`,
          `צור ויזואל שיווקי עבור ${getBriefTitle(task)} שמתאים לבאנר נדל"ן, עם דגש על יוקרה, אמינות, השקעה חכמה ונראות מסחרית גבוהה`,
        ],
        banner_headlines: [
          `${getBriefTitle(task)}`,
          "הזדמנות שכדאי להכיר",
          "זה בדיוק הזמן להיכנס",
        ],
      };
    }
  },

  image_generator: async (task) => {
    return {
      ok: true,
      note: "image_generator placeholder",
      brief_title: getBriefTitle(task),
      planner_brief: getTaskInput(task).planner_brief ?? null,
      assets: getAssets(task),
      images: [],
    };
  },

  banner_renderer: async (task) => {
    return await runBannerRenderer(task);
  },

  landing_page_builder: async (task) => {
    return {
      ok: true,
      note: "landing_page_builder placeholder",
      brief_title: getBriefTitle(task),
      planner_brief: getTaskInput(task).planner_brief ?? null,
      assets: getAssets(task),
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
      brief_title: getBriefTitle(task),
      planner_brief: getTaskInput(task).planner_brief ?? null,
      assets: getAssets(task),
      script: "תסריט קצר לדוגמה",
    };
  },

  qa: async (task) => {
    return {
      ok: true,
      note: "qa placeholder",
      brief_title: getBriefTitle(task),
      planner_brief: getTaskInput(task).planner_brief ?? null,
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
