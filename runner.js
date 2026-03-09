import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import PocketBase from "pocketbase";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

const PB_URL = process.env.POCKETBASE_URL;
const ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL;
const ADMIN_PASS = process.env.POCKETBASE_ADMIN_PASSWORD;
const PORT = Number(process.env.PORT || 3001);
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.resolve(process.cwd(), "public");
const GENERATED_IMAGES_DIR = path.join(PUBLIC_DIR, "generated-images");
const BANNERS_DIR = path.join(PUBLIC_DIR, "banners");
const PAGES_DIR = path.join(PUBLIC_DIR, "pages");
const PUBLIC_ASSET_BASE_URL = (
  process.env.PUBLIC_ASSET_BASE_URL ||
  process.env.RUNNER_PUBLIC_BASE_URL ||
  ""
).trim().replace(/\/+$/, "");

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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
const gemini = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// All image generation uses gemini-3.1-flash-image-preview ("Nano Banana 2")
// This is the confirmed working model on the v1beta API.
// Override any of these via Railway env vars if needed.
const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";

const IMAGEN_MODEL =
  process.env.IMAGEN_MODEL || GEMINI_IMAGE_MODEL;

const GEMINI_BANNER_MODEL =
  process.env.GEMINI_BANNER_MODEL || GEMINI_IMAGE_MODEL;

let sharpModulePromise = null;
function getSharp() {
  if (!sharpModulePromise) {
    sharpModulePromise = import("sharp")
      .then((mod) => mod.default || mod)
      .catch((err) => {
        throw new Error(
          `sharp is required for banner_composer. Install it in the runner service. Original error: ${
            err?.message || err
          }`
        );
      });
  }
  return sharpModulePromise;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

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

function getDisclaimer(task) {
  const input = getTaskInput(task);
  return normalizeText(
    input.disclaimer,
    "המידע אינו מהווה ייעוץ או התחייבות. התמונה להמחשה בלבד."
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

function escapeXml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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
  return Array.isArray(value)
    ? value.map((v) => normalizeText(v)).filter(Boolean)
    : [];
}

function mapBannerSizeToImageSize(size) {
  const normalized = normalizeText(size).toLowerCase();
  if (normalized === "1080x1080") return "1024x1024";
  if (normalized === "1080x1920") return "1024x1536";
  if (normalized === "1200x628") return "1536x1024";
  return "1024x1024";
}

function mapBannerSizeToGeminiImageConfig(size) {
  const normalized = normalizeText(size).toLowerCase().replace(/\s+/g, "");
  if (normalized === "1080x1080" || normalized === "1000x1000") {
    return {
      aspect_ratio: "1:1",
      image_size: "1k",
      output_width: 1080,
      output_height: 1080,
    };
  }
  if (normalized === "1080x1920") {
    return {
      aspect_ratio: "9:16",
      image_size: "1k",
      output_width: 1080,
      output_height: 1920,
    };
  }
  if (
    normalized === "1980x1020" ||
    normalized === "1200x628" ||
    normalized === "1200x630"
  ) {
    return {
      aspect_ratio: "16:9",
      image_size: "1k",
      output_width: 1200,
      output_height: 628,
    };
  }
  return {
    aspect_ratio: "1:1",
    image_size: "1k",
    output_width: 1080,
    output_height: 1080,
  };
}

function extractGeminiInlineImages(response) {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const parts = candidates.flatMap((candidate) => {
    const contentParts = candidate?.content?.parts;
    return Array.isArray(contentParts) ? contentParts : [];
  });
  return parts
    .map((part) => {
      const inline = part?.inlineData || part?.inline_data;
      if (!inline?.data) return null;
      return {
        mime_type: normalizeText(
          inline.mimeType || inline.mime_type,
          "image/png"
        ),
        data: normalizeText(inline.data),
      };
    })
    .filter(Boolean);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      throw new Error(
        `Gemini HTTP ${res.status}: ${json?.error?.message || text || "Unknown error"}`
      );
    }
    return json;
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateGeminiImage(plan) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing");
  }
  const url =
    `${GEMINI_API_BASE}/${encodeURIComponent(GEMINI_IMAGE_MODEL)}:generateContent` +
    `?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const body = {
    contents: [
      {
        parts: [{ text: plan.prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: plan.aspect_ratio,
      },
    },
  };
  const response = await fetchJsonWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    180000
  );
  const images = extractGeminiInlineImages(response);
  const firstImage = images[0];
  if (!firstImage?.data) {
    throw new Error(
      `Gemini image generation returned no inline image for ${plan.banner_name}`
    );
  }
  return firstImage;
}

function parseBannerDimensions(size) {
  const normalized = normalizeText(size, "1080x1080");
  const match = normalized.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) {
    return { width: 1080, height: 1080 };
  }
  return {
    width: Number(match[1]) || 1080,
    height: Number(match[2]) || 1080,
  };
}

function slugify(value) {
  return normalizeText(value, "asset")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "asset";
}

function relativePathToPublicUrl(relativePath) {
  const clean = String(relativePath).replaceAll("\\", "/").replace(/^\/+/, "");
  if (PUBLIC_ASSET_BASE_URL) {
    return `${PUBLIC_ASSET_BASE_URL}/files/${clean}`;
  }
  return `/files/${clean}`;
}

async function saveBufferToPublic(subdir, filename, buffer) {
  const dir = path.join(PUBLIC_DIR, subdir);
  await ensureDir(dir);
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, buffer);
  const relativePath = path.join(subdir, filename).replaceAll("\\", "/");
  return {
    file_path: filePath,
    relative_path: relativePath,
    public_url: relativePathToPublicUrl(relativePath),
  };
}

async function saveBase64PngToPublic(subdir, filename, base64) {
  const buffer = Buffer.from(base64, "base64");
  return await saveBufferToPublic(subdir, filename, buffer);
}

async function saveGeneratedImageToPublic({
  subdir,
  filenameBase,
  base64,
  mimeType = "image/png",
  targetWidth,
  targetHeight,
}) {
  const sharp = await getSharp();
  const inputBuffer = Buffer.from(base64, "base64");
  let ext = "png";
  if (mimeType === "image/jpeg") ext = "jpg";
  else if (mimeType === "image/webp") ext = "webp";
  const finalFilename = `${filenameBase}.${ext}`;
  let outputBuffer = inputBuffer;
  if (targetWidth && targetHeight) {
    outputBuffer = await sharp(inputBuffer)
      .resize(targetWidth, targetHeight, {
        fit: "cover",
        position: "centre",
      })
      .toFormat(ext === "jpg" ? "jpeg" : ext)
      .toBuffer();
  }
  return await saveBufferToPublic(subdir, finalFilename, outputBuffer);
}

async function readLocalFileSafe(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function readUrlAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch asset: ${url} (${res.status})`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function readAssetBuffer(urlOrPath) {
  const value = normalizeText(urlOrPath);
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return await readUrlAsBuffer(value);
  }
  if (value.startsWith("/files/")) {
    const relative = value.replace(/^\/files\//, "");
    return await readLocalFileSafe(path.join(PUBLIC_DIR, relative));
  }
  if (value.startsWith("/")) {
    return await readLocalFileSafe(
      path.join(PUBLIC_DIR, value.replace(/^\/+/, ""))
    );
  }
  if (path.isAbsolute(value)) {
    return await readLocalFileSafe(value);
  }
  return await readLocalFileSafe(path.join(PUBLIC_DIR, value));
}

function wrapText(text, maxCharsPerLine) {
  const safe = normalizeText(text);
  if (!safe) return [];
  const words = safe.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function getBannerLayoutMetrics(width, height) {
  const isVertical = height > width * 1.2;
  const isLandscape = width > height * 1.2;
  if (isVertical) {
    return {
      paddingX: Math.round(width * 0.08),
      topY: Math.round(height * 0.12),
      headlineSize: Math.round(width * 0.085),
      subheadlineSize: Math.round(width * 0.044),
      ctaSize: Math.round(width * 0.045),
      disclaimerSize: Math.round(width * 0.025),
      buttonWidth: Math.round(width * 0.62),
      buttonHeight: Math.round(height * 0.07),
      maxHeadlineChars: 18,
      maxSubChars: 28,
    };
  }
  if (isLandscape) {
    return {
      paddingX: Math.round(width * 0.06),
      topY: Math.round(height * 0.18),
      headlineSize: Math.round(height * 0.12),
      subheadlineSize: Math.round(height * 0.06),
      ctaSize: Math.round(height * 0.055),
      disclaimerSize: Math.round(height * 0.03),
      buttonWidth: Math.round(width * 0.28),
      buttonHeight: Math.round(height * 0.14),
      maxHeadlineChars: 24,
      maxSubChars: 38,
    };
  }
  return {
    paddingX: Math.round(width * 0.07),
    topY: Math.round(height * 0.16),
    headlineSize: Math.round(width * 0.07),
    subheadlineSize: Math.round(width * 0.038),
    ctaSize: Math.round(width * 0.04),
    disclaimerSize: Math.round(width * 0.022),
    buttonWidth: Math.round(width * 0.46),
    buttonHeight: Math.round(height * 0.09),
    maxHeadlineChars: 20,
    maxSubChars: 34,
  };
}

// ─── KEPT AS FALLBACK — used by composeBannerPng (sharp fallback path) ───────
function buildBannerOverlaySvg({
  width,
  height,
  headline,
  subheadline,
  cta,
  disclaimer,
  logoInsetWidth = 0,
}) {
  const m = getBannerLayoutMetrics(width, height);
  const headlineLines = wrapText(headline, m.maxHeadlineChars).slice(0, 3);
  const subheadlineLines = wrapText(subheadline, m.maxSubChars).slice(0, 3);
  const overlayX = m.paddingX;
  const overlayW = width - m.paddingX * 2;
  const overlayY = Math.round(height * 0.08);
  const overlayH = Math.round(height * 0.84);
  const headlineStartY = m.topY;
  const headlineLineGap = Math.round(m.headlineSize * 1.22);
  const subStartY =
    headlineStartY +
    headlineLines.length * headlineLineGap +
    Math.round(height * 0.03);
  const subLineGap = Math.round(m.subheadlineSize * 1.5);
  const buttonY = height - Math.round(height * 0.19);
  const buttonX = overlayX;
  const disclaimerY = height - Math.round(height * 0.05);
  const headlineText = headlineLines
    .map((line, index) => {
      const y = headlineStartY + index * headlineLineGap;
      return `<text x="${
        width - overlayX
      }" y="${y}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${
        m.headlineSize
      }" font-weight="700" fill="#FFFFFF">${escapeXml(line)}</text>`;
    })
    .join("");
  const subText = subheadlineLines
    .map((line, index) => {
      const y = subStartY + index * subLineGap;
      return `<text x="${
        width - overlayX
      }" y="${y}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${
        m.subheadlineSize
      }" font-weight="500" fill="#EAF2FF">${escapeXml(line)}</text>`;
    })
    .join("");
  const logoRect =
    logoInsetWidth > 0
      ? `<rect x="${overlayX}" y="${Math.round(
          height * 0.045
        )}" rx="14" ry="14" width="${logoInsetWidth}" height="${Math.round(
          height * 0.08
        )}" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.18)" />`
      : "";
  return `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="darkFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(0,0,0,0.18)"/>
      <stop offset="40%" stop-color="rgba(0,0,0,0.34)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.64)"/>
    </linearGradient>
    <linearGradient id="cardGlow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="rgba(7,31,67,0.30)"/>
      <stop offset="100%" stop-color="rgba(0,180,216,0.12)"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#darkFade)"/>
  <rect x="${overlayX}" y="${overlayY}" rx="28" ry="28" width="${overlayW}" height="${overlayH}" fill="url(#cardGlow)" stroke="rgba(255,255,255,0.14)"/>
  ${logoRect}
  ${headlineText}
  ${subText}
  <rect x="${buttonX}" y="${buttonY}" rx="${Math.round(
    m.buttonHeight / 2
  )}" ry="${Math.round(m.buttonHeight / 2)}" width="${
    m.buttonWidth
  }" height="${m.buttonHeight}" fill="#20C997"/>
  <text x="${buttonX + m.buttonWidth / 2}" y="${
    buttonY + m.buttonHeight / 2 + m.ctaSize * 0.35
  }" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${
    m.ctaSize
  }" font-weight="700" fill="#07131C">${escapeXml(cta)}</text>
  <text x="${width - overlayX}" y="${disclaimerY}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${m.disclaimerSize}" font-weight="400" fill="rgba(255,255,255,0.82)">${escapeXml(disclaimer)}</text>
</svg>
  `.trim();
}

async function buildArticleWithAI(task) {
  return await generateArticleWithAI(task);
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
    `אחד היתרונות המשמעותיים בעסקה מהסוג הזה הוא היכולת להיכנס לשוק עם תנאי פתיחה אטרקטיביים יחסית, מבלי להידרש בהכרח להון עצום כבר בשלב הראשון. עבור ${audience}, זהו בדיוק המקום שבו ההבדל בין עסקה "מעניינת" לעסקה "חזקה" מתחיל להתבהר. כאשר המחיר מדויק, המיקום נכון והסיפור הכולל יושב על היגיון מסחרי ברור, הרבה יותר קל לראות איך ההזדמנות הזו לא נשענת רק על חלום, אלא על יסודות שמאפשרים לה להיראות רלוונטית גם בטווח הקרוב וגם בטווח הארוך.`,
    `הזווית המרכזית כאן היא ${angle}, ולכן חשוב לבחון לא רק את המחיר או את הכותרת הראשית, אלא את מכלול המרכיבים שהופכים את ההצעה למשמעותית באמת. מיקום טוב, נגישות, ביקוש פוטנציאלי, סביבת פיתוח ותנאים מסחריים נוחים הם לא פרטים שוליים, אלא הלב של העסקה כולה.${keyPointsSentence} כשמחברים את כל המרכיבים האלה יחד, מתקבלת תמונה רחבה יותר: לא רק נכס או יחידה על הנייר, אלא מהלך שיכול להתאים למי שמבקש לזהות מראש את המקומות שבהם פוטנציאל כלכלי פוגש מחיר נכון.`,
    `מעבר לנתונים עצמם, יש כאן גם היגיון שיווקי ונדל"ני ברור. שוק שמציע הזדמנויות אמיתיות הוא בדרך כלל שוק שבו קיימת תנועה, קיימת ציפייה להמשך התפתחות, וקיימת סיבה טובה לכך שקהל רחב מגלה עניין. זו בדיוק הנקודה שבה משקיעים מנוסים שואלים לא רק "כמה זה עולה", אלא גם "מה הסיפור שמאחורי זה", "מה עשוי לקרות בהמשך", ו"איפה נמצאת נקודת היתרון ביחס לאלטרנטיבות אחרות". כאשר יש תשובות טובות לשאלות הללו, העסקה מתחילה להיראות הרבה יותר מגובשת, רצינית ובעלת פוטנציאל ממשי.`,
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
    `במסגרת העדכון הוטמעו ההערות המרכזיות שעלו: ${notesText} המשמעות היא שהתוכן לא רק "תוקן", אלא עבר שיפור שמחזק את הקריאות, מדייק את המסרים ומשפר את הדרך שבה הקורא פוגש את הערך של ההצעה כבר מהפסקאות הראשונות. ${
      additionalContext
        ? `בנוסף, נשמר חיבור ישיר גם למידע המשלים שנמסר: ${additionalContext}.`
        : ""
    }`,
    `כאשר בוחנים כתבה שיווקית טובה, מה שחשוב הוא לא רק אילו נתונים מוצגים, אלא גם איך הם מוגשים. לכן נעשה כאן מאמץ להחליק את המעברים בין הרעיונות, להסיר ניסוחים חלשים או כלליים מדי, ולחדד את המקומות שבהם הכתבה צריכה להרגיש בטוחה יותר, מקצועית יותר ורלוונטית יותר למי שקורא אותה בפועל.`,
    `הגרסה הקודמת כללה בין היתר את הפתיחה הבאה: ${prevText.slice(0, 220)}${
      prevText.length > 220 ? "..." : ""
    } מתוך הבסיס הזה בוצע שכתוב שמבקש לשמור על מה שהיה נכון, אבל לשפר את המקומות שהיו זקוקים לדיוק, להעמקה או לנוכחות חזקה יותר של המסר המרכזי.`,
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
    angles: [angle, "בהירות ודיוק במסר", "בניית אמון והנעה לפעולה"],
    cta_options: [cta, "לקבלת מידע נוסף", "בואו לראות איך זה עובד"],
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
    cta_options: [cta, "קבלו מידע נוסף", "בדקו התאמה עכשיו"],
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
      final_banners: {
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
            disclaimer: { type: "string" },
            logo_url: { type: "string" },
            background_image_ref: { type: "string" },
            layout: { type: "string" },
            visual_focus: { type: "string" },
          },
          required: [
            "name",
            "size",
            "headline",
            "subheadline",
            "cta",
            "disclaimer",
            "logo_url",
            "background_image_ref",
            "layout",
            "visual_focus",
          ],
        },
      },
    },
    required: [
      "master_direction",
      "visual_style",
      "color_palette",
      "global_design_notes",
      "final_banners",
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
    keyPoints.length > 0
      ? keyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")
      : "אין";
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
    note:
      mode === "revise"
        ? "copywriter article revision ai"
        : "copywriter article create ai",
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
    `סוג משימה: ${
      mode === "revise" ? "עריכת מודעות קיימות" : "יצירת מודעות חדשות"
    }`,
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
    note:
      mode === "revise"
        ? "copywriter ads revision ai"
        : "copywriter ads create ai",
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
    'אתה בונה כיוון ויזואלי ברור, ישים ומסחרי לקמפיין נדל"ן.',
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

function buildImageGeneratorFallback(task, related = {}) {
  const briefTitle = getBriefTitle(task);
  const assets = getAssets(task);
  const bannerOutput = related.bannerOutput || {};
  const visualOutput = related.visualOutput || {};
  const banners = Array.isArray(bannerOutput.banners)
    ? bannerOutput.banners
    : Array.isArray(bannerOutput.final_banners)
    ? bannerOutput.final_banners
    : [];
  const visualPrompts = pickArray(visualOutput.image_prompts);
  const derived =
    banners.length > 0
      ? banners.map((banner, index) => ({
          banner_name: normalizeText(banner.name, `banner_${index + 1}`),
          requested_size: normalizeText(banner.size, "1080x1080"),
          image_size: mapBannerSizeToImageSize(
            normalizeText(banner.size, "1080x1080")
          ),
          prompt: normalizeText(
            banner.image_prompt,
            `${briefTitle} בסגנון שיווקי, נקי, יוקרתי ומסחרי`
          ),
          mime_type: "image/png",
          generation_status: "not_generated",
          has_image_data: false,
          image_public_url: "",
          image_file_path: "",
        }))
      : visualPrompts.map((prompt, index) => ({
          banner_name: `visual_${index + 1}`,
          requested_size: "1080x1080",
          image_size: "1024x1024",
          prompt,
          mime_type: "image/png",
          generation_status: "not_generated",
          has_image_data: false,
          image_public_url: "",
          image_file_path: "",
        }));
  return {
    ok: true,
    note: "image_generator fallback",
    brief_title: briefTitle,
    planner_brief: getTaskInput(task).planner_brief ?? null,
    assets,
    related_sources: {
      banner_task_found: Boolean(related.bannerTask),
      visual_task_found: Boolean(related.visualTask),
    },
    generated_images: derived,
  };
}

async function generateImagesWithAI(task, related = {}) {
  if (!gemini) {
    throw new Error("GEMINI_API_KEY is missing");
  }
  const briefTitle = getBriefTitle(task);
  const assets = getAssets(task);
  const bannerOutput = related.bannerOutput || {};
  const visualOutput = related.visualOutput || {};
  const bannerPlans = Array.isArray(bannerOutput.banners)
    ? bannerOutput.banners
    : Array.isArray(bannerOutput.final_banners)
    ? bannerOutput.final_banners
    : [];
  const visualPrompts = pickArray(visualOutput.image_prompts);
  // Three distinct visual vibes — applied by index so each image has a different look
  const IMAGE_VIBES = [
    {
      label: "Golden Hour Aerial",
      lighting: "Lighting: warm golden hour, sun just below the horizon, deep amber and orange sky with long shadows.",
      composition: "Composition: wide aerial bird's-eye view from above, showing the full building complex, surrounding streets, greenery and sea horizon.",
      mood: "Mood: grand, aspirational, epic scale — the project dominates the skyline.",
      color: "Color grading: warm amber tones, rich contrast, sun-kissed highlights.",
    },
    {
      label: "Twilight Street Level",
      lighting: "Lighting: blue-hour twilight, sky is deep indigo-blue, building windows glowing warm yellow, exterior lighting on.",
      composition: "Composition: eye-level pedestrian perspective from a wide boulevard, building facade filling the frame, lush palm trees framing the sides.",
      mood: "Mood: intimate, inviting, modern urban luxury — like arriving home.",
      color: "Color grading: cool blue shadows contrasted with warm interior window lights, cinematic.",
    },
    {
      label: "Bright Morning Lifestyle",
      lighting: "Lighting: bright morning sunlight, crystal-clear blue sky, sharp clean shadows, fresh daylight atmosphere.",
      composition: "Composition: slight low-angle upward shot showing the tower's full height against blue sky, pool or garden terrace visible in foreground.",
      mood: "Mood: fresh, optimistic, premium quality of life — a place to live well.",
      color: "Color grading: clean bright whites, vivid sky blue, lush green landscaping, sharp and airy.",
    },
  ];

  const buildImagePrompt = (basePrompt, index) => {
    const vibe = IMAGE_VIBES[index % IMAGE_VIBES.length];
    return [
      basePrompt,
      `Style: premium real estate advertising photography — ${vibe.label} look.`,
      "Ultra-high-resolution, photorealistic or architectural CGI render.",
      vibe.lighting,
      vibe.composition,
      vibe.mood,
      vibe.color,
      "Technical: sharp focus, no motion blur, rich contrast.",
      "IMPORTANT: absolutely no text, no letters, no numbers, no watermarks, no logos, no UI elements in the image.",
      "The image will be used as a background for a real estate advertisement.",
    ].join(" ");
  };

  // Stable vibe index by banner name — independent of array order
  const VIBE_INDEX_BY_NAME = { square_main: 0, story_vertical: 1, landscape_display: 2 };
  const getVibeIndex = (bannerName, fallbackIndex) => {
    const key = normalizeText(bannerName).toLowerCase();
    return VIBE_INDEX_BY_NAME[key] ?? fallbackIndex;
  };

  let plans =
    bannerPlans.length > 0
      ? bannerPlans.map((banner, index) => {
          const requestedSize = normalizeText(banner.size, "1080x1080");
          const imageConfig = mapBannerSizeToGeminiImageConfig(requestedSize);
          const name = normalizeText(banner.name, `banner_${index + 1}`);
          return {
            banner_name: name,
            requested_size: requestedSize,
            image_size: imageConfig.image_size,
            aspect_ratio: imageConfig.aspect_ratio,
            output_width: imageConfig.output_width,
            output_height: imageConfig.output_height,
            prompt: buildImagePrompt(
              normalizeText(
                banner.image_prompt,
                `photorealistic render of luxury residential real estate towers near the Israeli coast`
              ),
              getVibeIndex(name, index)
            ),
          };
        })
      : visualPrompts.map((prompt, index) => {
          const imageConfig = mapBannerSizeToGeminiImageConfig("1080x1080");
          return {
            banner_name: `visual_${index + 1}`,
            requested_size: "1080x1080",
            image_size: imageConfig.image_size,
            aspect_ratio: imageConfig.aspect_ratio,
            output_width: imageConfig.output_width,
            output_height: imageConfig.output_height,
            prompt: buildImagePrompt(
              normalizeText(
                prompt,
                `photorealistic render of luxury residential real estate towers near the Israeli coast`
              ),
              index
            ),
          };
        });

  if (!plans.length) {
    throw new Error("No image prompts found for image_generator");
  }

  const generated_images = [];
  for (const plan of plans) {
    console.log(`🖼️ Generating background image for ${plan.banner_name} via Imagen 3 (${plan.aspect_ratio})`);

    let imageBase64 = null;
    let imageMimeType = "image/png";

    // generateContent with IMAGE modality — confirmed working on v1beta
    const bgResponse = await gemini.models.generateContent({
      model: GEMINI_IMAGE_MODEL,
      contents: [{ role: "user", parts: [{ text: plan.prompt }] }],
      config: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: plan.aspect_ratio,
        },
      },
    });
    const bgImages = extractGeminiInlineImages(bgResponse);
    if (!bgImages[0]?.data) {
      throw new Error(`Gemini returned no image for background ${plan.banner_name}`);
    }
    imageBase64 = bgImages[0].data;
    imageMimeType = bgImages[0].mime_type || "image/png";
    console.log(`✅ Background generated for ${plan.banner_name}`);

    const fileBase = `${slugify(briefTitle)}-${slugify(plan.banner_name)}-${randomUUID()}`;
    const saved = await saveGeneratedImageToPublic({
      subdir: "generated-images",
      filenameBase: fileBase,
      base64: imageBase64,
      mimeType: imageMimeType,
      targetWidth: plan.output_width,
      targetHeight: plan.output_height,
    });
    generated_images.push({
      banner_name: plan.banner_name,
      requested_size: plan.requested_size,
      image_size: plan.image_size,
      aspect_ratio: plan.aspect_ratio,
      output_width: plan.output_width,
      output_height: plan.output_height,
      prompt: plan.prompt,
      mime_type: imageMimeType,
      generation_status: "generated",
      has_image_data: true,
      image_public_url: saved.public_url,
      image_file_path: saved.file_path,
      image_relative_path: saved.relative_path,
      generator: "imagen3",
      generator_model: IMAGEN_MODEL,
    });
  }

  return {
    ok: true,
    ai_generated: true,
    note: "image_generator ai via gemini — 3 unique images with distinct vibes",
    brief_title: briefTitle,
    planner_brief: getTaskInput(task).planner_brief ?? null,
    assets,
    related_sources: {
      banner_task_found: Boolean(related.bannerTask),
      visual_task_found: Boolean(related.visualTask),
    },
    generated_images,
  };
}

async function runImageGenerator(task) {
  const input = getTaskInput(task);
  const sourceTaskId = normalizeText(input.source_task_id, "");
  let siblings = [];
  if (sourceTaskId) {
    siblings = await listSiblingTasksForSourceTask(sourceTaskId);
  }
  const bannerTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase() === "banner_set" &&
      normalizeText(item.status).toLowerCase() === "done"
  );
  const visualTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase() === "visual_prompts" &&
      normalizeText(item.status).toLowerCase() === "done"
  );
  const related = {
    bannerTask,
    visualTask,
    bannerOutput:
      bannerTask &&
      bannerTask.output_data &&
      typeof bannerTask.output_data === "object"
        ? bannerTask.output_data
        : {},
    visualOutput:
      visualTask &&
      visualTask.output_data &&
      typeof visualTask.output_data === "object"
        ? visualTask.output_data
        : {},
  };
  try {
    return await generateImagesWithAI(task, related);
  } catch (e) {
    console.error(
      "⚠️ AI image_generator failed, using fallback:",
      e?.message || e
    );
    return buildImageGeneratorFallback(task, related);
  }
}

function buildBannerRendererFallback(task, related = {}) {
  const briefTitle = getBriefTitle(task);
  const cta = getCTA(task);
  const disclaimer = getDisclaimer(task);
  const assets = getAssets(task);
  const visual = related.visualOutput || {};
  const ads = related.adOutput || {};
  const imageOutput = related.imageOutput || {};
  const bannerHeadlines = pickArray(visual.banner_headlines);
  const adHeadlines = pickArray(ads.headlines);
  const primaryTexts = pickArray(ads.primary_texts);
  const generatedImages = Array.isArray(imageOutput.generated_images)
    ? imageOutput.generated_images
    : [];
  const baseHeadline =
    firstNonEmpty(bannerHeadlines[0], adHeadlines[0], briefTitle) || briefTitle;
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
  function findImageRefByName(name) {
    const found = generatedImages.find(
      (img) =>
        normalizeText(img.banner_name).toLowerCase() ===
        normalizeText(name).toLowerCase()
    );
    return found ? normalizeText(found.banner_name) : "";
  }
  return {
    ok: true,
    note: "banner_renderer fallback",
    brief_title: briefTitle,
    planner_brief: getTaskInput(task).planner_brief ?? null,
    assets,
    related_sources: {
      visual_task_found: Boolean(related.visualTask),
      ad_task_found: Boolean(related.adTask),
      image_task_found: Boolean(related.imageTask),
    },
    master_direction: masterDirection,
    visual_style: visualStyle,
    color_palette: colorPalette,
    global_design_notes:
      "לשמור על היררכיה ברורה: כותרת ראשית חזקה, אזור ויזואלי נקי, מספר/יתרון מרכזי, CTA ברור, לוגו במיקום קבוע ודיסקליימר קטן אך קריא.",
    final_banners: [
      {
        name: "square_main",
        size: "1080x1080",
        headline: baseHeadline,
        subheadline: sharedSubheadline,
        cta,
        disclaimer,
        logo_url: assets.logos[0] || "",
        background_image_ref: findImageRefByName("square_main"),
        layout:
          "כותרת עליונה גדולה, ויזואל מרכזי, שורת תועלת קצרה, CTA בתחתית, לוגו בפינה ודיסקליימר קטן.",
        visual_focus: "ויזואל מרכזי נקי וחזק עם תחושת פרימיום ונדל״ן איכותי.",
      },
      {
        name: "story_vertical",
        size: "1080x1920",
        headline: secondHeadline,
        subheadline: sharedSubheadline,
        cta,
        disclaimer,
        logo_url: assets.logos[0] || "",
        background_image_ref: findImageRefByName("story_vertical"),
        layout:
          "מבנה אנכי: כותרת עליונה, ויזואל גבוה במרכז, CTA באזור תחתון ברור, לוגו למעלה/למטה ודיסקליימר קטן ב-safe area.",
        visual_focus: "תמונה אנכית נקייה עם תחושת גובה, יוקרה ותנועה טבעית לעין.",
      },
      {
        name: "landscape_display",
        size: "1200x628",
        headline: thirdHeadline,
        subheadline: sharedSubheadline,
        cta,
        disclaimer,
        logo_url: assets.logos[0] || "",
        background_image_ref: findImageRefByName("landscape_display"),
        layout:
          "כותרת בצד אחד, ויזואל בצד השני, תועלת קצרה מתחת לכותרת, CTA ברור, לוגו ודיסקליימר בתחתית.",
        visual_focus:
          "קומפוזיציה רחבה, נקייה ומסחרית שמתאימה למדיה חברתית ולדיספליי.",
      },
    ],
  };
}

async function generateBannerSetWithAI(task, related = {}) {
  const briefTitle = getBriefTitle(task);
  const assets = getAssets(task);
  const visual = related.visualOutput || {};
  const ads = related.adOutput || {};
  const imageOutput = related.imageOutput || {};
  const additionalContext = getAdditionalContext(task);
  const cta = getCTA(task);
  const disclaimer = getDisclaimer(task);
  const visualPayload = JSON.stringify(visual || {}, null, 2);
  const adsPayload = JSON.stringify(ads || {}, null, 2);
  const imagePayload = JSON.stringify(imageOutput || {}, null, 2);
  const assetsText = buildAssetsSummaryText(assets) || "לא סופקו נכסים";
  const plannerBriefText = JSON.stringify(
    getTaskInput(task).planner_brief ?? {},
    null,
    2
  );
  const systemPrompt = [
    "אתה Senior Banner Designer + Creative Strategist.",
    'המטרה שלך היא להכין חבילת באנרים סופית ומוכנה ל-render עבור קמפיין נדל"ן.',
    "אתה מחזיר JSON בלבד לפי הסכמה שניתנה.",
    "אין markdown, אין טקסט מחוץ ל-JSON.",
    "השתמש בתמונות שכבר נוצרו כרפרנסים דרך background_image_ref אם סופקו.",
    "התייחס ל-output של visual_director כבסיס עיצובי מחייב.",
    "אם יש output של מודעות, השתמש בו לחיזוק כותרות ותועלות.",
    "כתוב בעברית ברורה.",
  ].join(" ");
  const userPrompt = [
    `צור חבילת באנרים סופית עבור הקמפיין: ${briefTitle}`,
    `CTA: ${cta}`,
    `Disclaimer: ${disclaimer}`,
    `מידע נוסף:\n${additionalContext || "אין"}`,
    `Assets:\n${assetsText}`,
    `Planner brief:\n${plannerBriefText}`,
    `Visual director output:\n${visualPayload}`,
    `Ad copy output:\n${adsPayload}`,
    `Image generator output:\n${imagePayload}`,
    "החזר JSON בלבד עם השדות:",
    "master_direction, visual_style, color_palette, global_design_notes, final_banners",
    "final_banners חייב להכיל בדיוק 3 באנרים:",
    "1. square_main בגודל 1080x1080",
    "2. story_vertical בגודל 1080x1920",
    "3. landscape_display בגודל 1200x628",
    "לכל באנר חייבים להיות השדות:",
    "name, size, headline, subheadline, cta, disclaimer, logo_url, background_image_ref, layout, visual_focus",
    "headline צריך להיות קצר וחזק.",
    "subheadline צריך להיות קצר, מסחרי וברור.",
    "background_image_ref צריך להיות אחד מה-banner_name שכבר נוצרו אם קיימים.",
  ].join("\n\n");
  const ai = await createStructuredResponse({
    model: "gpt-4.1-mini",
    systemPrompt,
    userPrompt,
    schemaName: "banner_renderer_package_final",
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
      image_task_found: Boolean(related.imageTask),
    },
    master_direction: normalizeText(ai.master_direction),
    visual_style: normalizeText(ai.visual_style),
    color_palette: pickArray(ai.color_palette),
    global_design_notes: normalizeText(ai.global_design_notes),
    final_banners: Array.isArray(ai.final_banners)
      ? ai.final_banners.map((banner) => ({
          name: normalizeText(banner.name),
          size: normalizeText(banner.size),
          headline: normalizeText(banner.headline),
          subheadline: normalizeText(banner.subheadline),
          cta: normalizeText(banner.cta, cta),
          disclaimer: normalizeText(banner.disclaimer, disclaimer),
          logo_url: normalizeText(banner.logo_url, assets.logos[0] || ""),
          background_image_ref: normalizeText(banner.background_image_ref),
          layout: normalizeText(banner.layout),
          visual_focus: normalizeText(banner.visual_focus),
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
  const imageTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase() === "background_images" &&
      normalizeText(item.status).toLowerCase() === "done"
  );
  const related = {
    visualTask,
    adTask,
    imageTask,
    visualOutput:
      visualTask &&
      visualTask.output_data &&
      typeof visualTask.output_data === "object"
        ? visualTask.output_data
        : {},
    adOutput:
      adTask && adTask.output_data && typeof adTask.output_data === "object"
        ? adTask.output_data
        : {},
    imageOutput:
      imageTask &&
      imageTask.output_data &&
      typeof imageTask.output_data === "object"
        ? imageTask.output_data
        : {},
  };
  try {
    return await generateBannerSetWithAI(task, related);
  } catch (e) {
    console.error(
      "⚠️ AI banner_renderer failed, using fallback:",
      e?.message || e
    );
    return buildBannerRendererFallback(task, related);
  }
}

function buildBannerComposerFallback(task, related = {}) {
  const bannerOutput = related.bannerOutput || {};
  const finalBanners = Array.isArray(bannerOutput.final_banners)
    ? bannerOutput.final_banners
    : [];
  return {
    ok: true,
    note: "banner_composer fallback",
    brief_title: getBriefTitle(task),
    planner_brief: getTaskInput(task).planner_brief ?? null,
    composed_banners: finalBanners.map((banner) => ({
      name: normalizeText(banner.name),
      size: normalizeText(banner.size),
      headline: normalizeText(banner.headline),
      subheadline: normalizeText(banner.subheadline),
      file_name: "",
      file_path: "",
      public_url: "",
      composition_status: "not_composed",
    })),
  };
}

// ─── KEPT AS FALLBACK — used when Gemini banner composition fails ──────────────
async function composeBannerPng({
  briefTitle,
  banner,
  generatedImages,
  assets,
}) {
  const sharp = await getSharp();
  const { width, height } = parseBannerDimensions(banner.size);
  const backgroundRef = normalizeText(banner.background_image_ref);
  const backgroundMeta = Array.isArray(generatedImages)
    ? generatedImages.find(
        (img) =>
          normalizeText(img.banner_name).toLowerCase() ===
          backgroundRef.toLowerCase()
      )
    : null;
  let backgroundBuffer = null;
  if (backgroundMeta?.image_file_path) {
    backgroundBuffer = await readAssetBuffer(backgroundMeta.image_file_path);
  }
  if (!backgroundBuffer && backgroundMeta?.image_public_url) {
    backgroundBuffer = await readAssetBuffer(backgroundMeta.image_public_url);
  }
  if (!backgroundBuffer) {
    const fallbackBgSvg = `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#023E8A"/>
            <stop offset="50%" stop-color="#0077B6"/>
            <stop offset="100%" stop-color="#90E0EF"/>
          </linearGradient>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#bg)"/>
      </svg>
    `.trim();
    backgroundBuffer = await sharp(Buffer.from(fallbackBgSvg))
      .png()
      .toBuffer();
  }
  const backgroundBase = sharp(backgroundBuffer).resize(width, height, {
    fit: "cover",
    position: "centre",
  });
  const composites = [];
  const overlaySvg = buildBannerOverlaySvg({
    width,
    height,
    headline: banner.headline,
    subheadline: banner.subheadline,
    cta: banner.cta,
    disclaimer: banner.disclaimer,
    logoInsetWidth:
      banner.logo_url || assets.logos[0] ? Math.round(width * 0.22) : 0,
  });
  composites.push({
    input: Buffer.from(overlaySvg),
    top: 0,
    left: 0,
  });
  const logoCandidate = firstNonEmpty(banner.logo_url, assets.logos[0], "");
  if (logoCandidate) {
    try {
      const logoBuffer = await readAssetBuffer(logoCandidate);
      if (logoBuffer) {
        const logoWidth = Math.round(width * 0.18);
        const logoHeight = Math.round(height * 0.06);
        const preparedLogo = await sharp(logoBuffer)
          .resize({
            width: logoWidth,
            height: logoHeight,
            fit: "contain",
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
        composites.push({
          input: preparedLogo,
          left: Math.round(width * 0.06),
          top: Math.round(height * 0.055),
        });
      }
    } catch (e) {
      console.error("⚠️ logo load failed:", e?.message || e);
    }
  }
  const outputBuffer = await backgroundBase
    .composite(composites)
    .png()
    .toBuffer();
  const fileName = `${slugify(briefTitle)}-${slugify(
    banner.name
  )}-${randomUUID()}.png`;
  const saved = await saveBufferToPublic("banners", fileName, outputBuffer);
  return {
    name: normalizeText(banner.name),
    size: normalizeText(banner.size),
    headline: normalizeText(banner.headline),
    subheadline: normalizeText(banner.subheadline),
    cta: normalizeText(banner.cta),
    disclaimer: normalizeText(banner.disclaimer),
    background_image_ref: normalizeText(banner.background_image_ref),
    file_name: fileName,
    file_path: saved.file_path,
    relative_path: saved.relative_path,
    public_url: saved.public_url,
    composition_status: "composed",
  };
}

// ─── NEW: Build the Gemini prompt for a complete banner with Hebrew text ──────
function buildBannerGeminiPrompt({ banner, width, height, briefTitle, hasBackground }) {
  const isVertical  = height > width * 1.2;
  const isLandscape = width  > height * 1.2;

  // Layout-specific instructions matching the reference banner style
  const layoutGuide = isVertical
    ? `LAYOUT — Vertical Story (${width}×${height}px, 9:16):
• Top 45%: dark gradient overlay (deep navy/black, 85% opacity). All text goes here.
• Headline: top-center, large bold text.
• Subheadline: below headline, smaller.
• Middle 45%: the real estate photo shows through clearly — this is the hero visual.
• Bottom 20%: dark band with gold CTA button centered. Disclaimer below button.`
    : isLandscape
    ? `LAYOUT — Landscape Display (${width}×${height}px, 16:9):
• Left ~55%: real estate photo visible (hero visual).
• Right ~45%: dark gradient panel (deep navy, 90% opacity). All text right-aligned here.
• Top of right panel: headline (large, bold).
• Middle of right panel: subheadline.
• Bottom of right panel: gold CTA button, then disclaimer tiny below.`
    : `LAYOUT — Square (${width}×${height}px, 1:1):
• Top 40%: dark gradient overlay (deep navy/black, 85-90% opacity). All text here.
• Headline: near top, bold, centered or right-aligned.
• Subheadline: below headline, smaller weight.
• Middle 45%: real estate photo shows through clearly.
• Bottom 15%: dark band, gold CTA button centered. Disclaimer below button.`;

  const styleGuide = `
═══ VISUAL STYLE — MATCH THIS EXACTLY ═══
Reference style: premium Israeli real estate marketing banners (like Mivtachim / Pras Hamachir style).

TYPOGRAPHY:
• HEADLINE: Very large (dominant). Bold weight. Color: bright gold/yellow (#D4A017 or #E8B84B) OR pure white. 
  If the headline contains a price or key number, make that number EXTRA large and gold metallic.
• SUBHEADLINE: Medium size, normal weight. Color: white (#FFFFFF) or light silver.
• CTA BUTTON: Wide rounded-pill shape. Gold metallic gradient fill (from #C8960C to #F0C040). 
  Dark navy text inside (#0A1628). Bold. Centered text. Subtle drop shadow.
• DISCLAIMER: Very small, 70% white opacity, bottom of banner.

OVERLAY & DEPTH:
• Apply a strong dark gradient overlay on the top portion so headline text pops against any background.
• The gradient should go from near-black (top, 85-90% opacity) fading to transparent (middle), 
  revealing the photorealistic building/city background in the lower portion.
• The background photo must be clearly visible in at least 40% of the banner — it is the hero visual.

GOLD ACCENTS:
• The overall palette is: deep navy background tones + gold/yellow text + white secondary text + gold CTA.
• This creates the premium "gold on dark" real estate advertisement look.
• Optional: a gold seal/badge element in one corner if there is a key selling point to highlight.

HEBREW TEXT RENDERING:
• All text is in Hebrew, reading RIGHT TO LEFT.
• Text must be centered or right-aligned.
• Hebrew glyphs must be fully formed and correct — no broken characters, no Latin substitution.
• Font: clean bold sans-serif (Noto Sans Hebrew, Arial, or similar — bold weight).`;

  const textSpec = `
═══ TEXT CONTENT TO RENDER ═══
HEADLINE (large bold gold or white):
${banner.headline}

SUBHEADLINE (medium white, below headline):
${banner.subheadline}

CTA BUTTON (gold pill button, centered/right):
${banner.cta}

DISCLAIMER (tiny, bottom, semi-transparent white):
${banner.disclaimer}`;

  const backgroundInstruction = hasBackground
    ? `\n═══ BACKGROUND IMAGE ═══\nA real estate background photo is provided. Use it as the hero visual in the lower/clear portion of the banner. Apply the dark gradient overlay on top as specified above.`
    : `\n═══ BACKGROUND ═══\nGenerate a premium photorealistic real estate background: aerial or eye-level view of modern luxury residential towers at golden hour / dramatic dusk. Deep blue-purple sky, warm building lights, green landscaping. Ultra-sharp, cinematic. No text in the background image.`;

  const logoInstruction = banner.logo_url
    ? `\n• Reserve a 180×55px area at TOP-LEFT for a brand logo (leave it empty/dark — do not place any text there).`
    : "";

  return [
    hasBackground
      ? "You are given a real estate background photo. Produce a COMPLETE, print-ready Hebrew real estate marketing banner by overlaying the text and UI elements described below onto this photo."
      : `Create a COMPLETE, print-ready Hebrew real estate marketing banner for the campaign: "${briefTitle}".`,
    "Generate the actual finished image — do NOT describe it or return text.",
    "",
    layoutGuide,
    styleGuide,
    textSpec,
    backgroundInstruction,
    logoInstruction,
    "",
    "FINAL REQUIREMENTS:",
    "• Output must look identical in quality to a professional paid real estate Facebook/Instagram ad.",
    "• No English text unless it appeared in the Hebrew content above.",
    "• No watermarks, no stock-photo UI overlays, no lorem ipsum.",
    "• The banner must be production-ready and visually stunning.",
  ].filter(Boolean).join("\n");
}

// ─── NEW: Compose a full banner using Gemini (Hebrew text baked in) ───────────
async function composeBannerWithGemini({ briefTitle, banner, generatedImages, assets }) {
  if (!gemini) throw new Error("GEMINI_API_KEY is missing — cannot compose banner with Gemini");

  const { width, height } = parseBannerDimensions(banner.size);
  const imageConfig      = mapBannerSizeToGeminiImageConfig(banner.size);
  const backgroundRef    = normalizeText(banner.background_image_ref);

  // Try to load the background image that was generated in the image_generator step
  const backgroundMeta = Array.isArray(generatedImages)
    ? generatedImages.find(
        (img) =>
          normalizeText(img.banner_name).toLowerCase() ===
          backgroundRef.toLowerCase()
      )
    : null;

  let backgroundBase64  = null;
  let backgroundMimeType = "image/png";

  if (backgroundMeta?.image_file_path) {
    const buf = await readAssetBuffer(backgroundMeta.image_file_path);
    if (buf) {
      backgroundBase64    = buf.toString("base64");
      backgroundMimeType  = normalizeText(backgroundMeta.mime_type, "image/png");
    }
  }

  if (!backgroundBase64 && backgroundMeta?.image_public_url) {
    const buf = await readAssetBuffer(backgroundMeta.image_public_url);
    if (buf) {
      backgroundBase64    = buf.toString("base64");
      backgroundMimeType  = normalizeText(backgroundMeta.mime_type, "image/png");
    }
  }

  const prompt = buildBannerGeminiPrompt({
    banner,
    width,
    height,
    briefTitle,
    hasBackground: !!backgroundBase64,
  });

  // Build multimodal contents — image first if available, then text prompt
  const parts = [];
  if (backgroundBase64) {
    parts.push({
      inlineData: {
        mimeType: backgroundMimeType,
        data: backgroundBase64,
      },
    });
  }
  parts.push({ text: prompt });

  const contents = [{ role: "user", parts }];

  console.log(
    `🎨 Composing banner "${banner.name}" (${banner.size}) via Gemini 2.0 Flash — ` +
    `background: ${backgroundBase64 ? "Imagen 3 photo loaded ✓" : "none, generating from scratch"}`
  );

  const response = await gemini.models.generateContent({
    model: GEMINI_BANNER_MODEL,
    contents,
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: {
        aspectRatio: imageConfig.aspect_ratio,
      },
    },
  });

  const images = extractGeminiInlineImages(response);
  const firstImage = images[0];

  if (!firstImage?.data) {
    throw new Error(
      `Gemini returned no image for banner "${banner.name}" — ` +
      `finishReason: ${JSON.stringify(response?.candidates?.[0]?.finishReason ?? "unknown")}`
    );
  }

  const fileBase = `${slugify(briefTitle)}-${slugify(banner.name)}-${randomUUID()}`;

  const saved = await saveGeneratedImageToPublic({
    subdir:       "banners",
    filenameBase: fileBase,
    base64:       firstImage.data,
    mimeType:     firstImage.mime_type,
    targetWidth:  width,
    targetHeight: height,
  });

  return {
    name:                  normalizeText(banner.name),
    size:                  normalizeText(banner.size),
    headline:              normalizeText(banner.headline),
    subheadline:           normalizeText(banner.subheadline),
    cta:                   normalizeText(banner.cta),
    disclaimer:            normalizeText(banner.disclaimer),
    background_image_ref:  normalizeText(banner.background_image_ref),
    file_name:             path.basename(saved.file_path),
    file_path:             saved.file_path,
    relative_path:         saved.relative_path,
    public_url:            saved.public_url,
    composition_status:    "composed",
    generator:             "gemini_2_flash",
    generator_model:       GEMINI_BANNER_MODEL,
    used_background_image: !!backgroundBase64,
  };
}

// ─── UPDATED: runBannerComposer — Gemini first, sharp fallback ────────────────
async function runBannerComposer(task) {
  const input        = getTaskInput(task);
  const sourceTaskId = normalizeText(input.source_task_id, "");

  let siblings = [];
  if (sourceTaskId) {
    siblings = await listSiblingTasksForSourceTask(sourceTaskId);
  }

  const bannerTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase()   === "banner_set" &&
      normalizeText(item.status).toLowerCase() === "done"
  );

  const imageTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase()   === "background_images" &&
      normalizeText(item.status).toLowerCase() === "done"
  );

  const related = {
    bannerTask,
    imageTask,
    bannerOutput:
      bannerTask?.output_data && typeof bannerTask.output_data === "object"
        ? bannerTask.output_data
        : {},
    imageOutput:
      imageTask?.output_data && typeof imageTask.output_data === "object"
        ? imageTask.output_data
        : {},
  };

  const bannerOutput    = related.bannerOutput;
  const imageOutput     = related.imageOutput;
  const finalBanners    = Array.isArray(bannerOutput.final_banners)    ? bannerOutput.final_banners    : [];
  const generatedImages = Array.isArray(imageOutput.generated_images)  ? imageOutput.generated_images  : [];
  const assets          = getAssets(task);
  const briefTitle      = getBriefTitle(task);

  if (!finalBanners.length) {
    console.error("⚠️ banner_composer: No final_banners found");
    return buildBannerComposerFallback(task, related);
  }

  const composed_banners = [];

  for (const banner of finalBanners) {
    const bannerName = normalizeText(banner.name);

    // ── Primary path: Gemini full-banner generation with Hebrew text ──
    try {
      const composed = await composeBannerWithGemini({
        briefTitle,
        banner,
        generatedImages,
        assets,
      });
      composed_banners.push(composed);
      console.log(`✅ Banner composed by Gemini: ${bannerName}`);
      continue;
    } catch (geminiErr) {
      console.error(
        `⚠️ Gemini banner composition failed for "${bannerName}", trying sharp fallback:`,
        geminiErr?.message || geminiErr
      );
    }

    // ── Fallback path: original sharp + SVG overlay ──
    try {
      const composed = await composeBannerPng({
        briefTitle,
        banner,
        generatedImages,
        assets,
      });
      composed_banners.push({ ...composed, generator: "sharp_svg_fallback" });
      console.log(`⚠️ Banner composed via sharp fallback: ${bannerName}`);
    } catch (sharpErr) {
      console.error(
        `❌ Sharp fallback also failed for "${bannerName}":`,
        sharpErr?.message || sharpErr
      );
      composed_banners.push({
        name:                 bannerName,
        size:                 normalizeText(banner.size),
        headline:             normalizeText(banner.headline),
        subheadline:          normalizeText(banner.subheadline),
        cta:                  normalizeText(banner.cta),
        disclaimer:           normalizeText(banner.disclaimer),
        background_image_ref: normalizeText(banner.background_image_ref),
        file_name:            "",
        file_path:            "",
        relative_path:        "",
        public_url:           "",
        composition_status:   "failed",
        error:                String(sharpErr?.message || sharpErr),
      });
    }
  }

  const composedCount = composed_banners.filter(
    (b) => b.composition_status === "composed"
  ).length;

  return {
    ok:           true,
    ai_generated: composedCount > 0,
    note:
      composedCount === composed_banners.length
        ? "banner_composer rendered all banners via Gemini"
        : composedCount > 0
        ? `banner_composer partial success (${composedCount}/${composed_banners.length})`
        : "banner_composer: no banners composed",
    brief_title:    briefTitle,
    planner_brief:  getTaskInput(task).planner_brief ?? null,
    related_sources: {
      banner_task_found: Boolean(related.bannerTask),
      image_task_found:  Boolean(related.imageTask),
    },
    composed_banners,
  };
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
    disclaimer: getDisclaimer(task),
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
    case "banner_compose":
      return "banner_composer";
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
    disclaimer: normalizedBrief.disclaimer,
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
      title: `Compose final banners for: ${baseTitle}`,
      type: "banner_compose",
      assigned_agent: "banner_composer",
      priority: "normal",
      goal_id: task.goal_id ?? null,
      campaign_id: task.campaign_id ?? null,
      status: "backlog",
      input_data: {
        ...baseInput,
        deliverable: "banner_compose",
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
    if (
      deliverable === "ads" ||
      deliverable === "ad_copy" ||
      type === "ad_copy"
    ) {
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
  if (
    deliverable === "ads" ||
    deliverable === "ad_copy" ||
    type === "ad_copy"
  ) {
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
    hebrew_copy: `נוצר טקסט בסיס עבור ${getBriefTitle(
      task
    )}. אפשר להרחיב אותו, לחדד את הטון, או לשלוח סבב תיקונים נוסף לפי צורך.`,
  };
}

// ─── Landing Page Builder ────────────────────────────────────────────────────

async function generateLogoWithGemini(brandName) {
  if (!gemini) throw new Error("Gemini not configured");
  console.log(`🎨 Generating logo for brand: ${brandName}`);
  const prompt = `Create a clean, modern business logo for "${brandName}".
Requirements:
- Simple wordmark or icon+wordmark style
- Professional and premium look
- White or transparent background
- No shadows, no gradients that look cheap
- Suitable for real estate or professional services
- Clean typography, minimal design
- Output: PNG image, square format approx 400x400px`;

  const result = await gemini.models.generateContent({
    model: GEMINI_IMAGE_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
  });
  const parts = result?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData?.mimeType?.startsWith("image/"));
  if (!imgPart) throw new Error("Gemini did not return an image for logo");
  return `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
}

async function buildLandingPageHTML({ brief, copy, images, logoDataUrl, logoUrl, config }) {
  if (!openai) throw new Error("OpenAI not configured for landing page generation");

  const lang = config.language || "he";
  const isHebrew = lang === "he";
  const dir = isHebrew ? "rtl" : "ltr";

  // Resolve form fields
  const defaultFields = [
    { label: isHebrew ? "שם מלא" : "Full Name", type: "text", name: "name", required: true },
    { label: isHebrew ? "טלפון" : "Phone", type: "tel", name: "phone", required: true },
    { label: isHebrew ? "אימייל" : "Email", type: "email", name: "email", required: false },
  ];
  const formFields = (config.form_fields && config.form_fields.length > 0)
    ? config.form_fields
    : defaultFields;

  const submitText = config.submit_button_text || (isHebrew ? "שלח פרטים" : "Send Details");
  const zapierWebhook = config.zapier_webhook_url || "";
  const redirectUrl = config.redirect_url || "";
  const metaPixelId = config.meta_pixel_id || "";
  const whatsappEnabled = config.whatsapp_enabled !== false && config.whatsapp_number;
  const whatsappNumber = config.whatsapp_number || "";
  const whatsappMessage = config.whatsapp_message || (isHebrew ? "שלום, אני מעוניין לקבל מידע נוסף" : "Hello, I would like more information");
  const phoneInNav = config.phone_in_nav || "";
  const pageSlug = config.page_slug || "landing";
  const colorScheme = config.color_scheme || "dark_luxury";

  // Color scheme presets
  const colors = {
    dark_luxury: {
      bg: "#0a0a0f", cardBg: "#12121a", accent: "#c9a84c",
      accentDark: "#a07830", text: "#f5f0e8", subtext: "#b0a898",
      navBg: "rgba(10,10,15,0.95)", heroOverlay: "rgba(0,0,0,0.55)",
    },
    light_modern: {
      bg: "#f8f9fa", cardBg: "#ffffff", accent: "#2563eb",
      accentDark: "#1d4ed8", text: "#111827", subtext: "#6b7280",
      navBg: "rgba(255,255,255,0.95)", heroOverlay: "rgba(0,0,0,0.40)",
    },
    green_health: {
      bg: "#f0fdf4", cardBg: "#ffffff", accent: "#16a34a",
      accentDark: "#15803d", text: "#14532d", subtext: "#4b7a5a",
      navBg: "rgba(240,253,244,0.95)", heroOverlay: "rgba(0,0,0,0.45)",
    },
  }[colorScheme] || colors?.dark_luxury || {
    bg: "#0a0a0f", cardBg: "#12121a", accent: "#c9a84c",
    accentDark: "#a07830", text: "#f5f0e8", subtext: "#b0a898",
    navBg: "rgba(10,10,15,0.95)", heroOverlay: "rgba(0,0,0,0.55)",
  };

  // Prepare images for HTML
  const heroImage = images[0] || "";
  const contentImages = images.slice(1, 4);

  // Generate form fields HTML
  const formFieldsHtml = formFields.map(f => {
    const req = f.required ? 'required' : '';
    const reqMark = f.required ? '<span style="color:#e74c3c">*</span>' : '';
    if (f.type === "select" && Array.isArray(f.options)) {
      const opts = f.options.map(o => `<option value="${o}">${o}</option>`).join("");
      return `<div class="form-group"><label>${f.label} ${reqMark}</label>
        <select name="${f.name || f.label}" ${req} class="form-input"><option value="">בחר...</option>${opts}</select></div>`;
    }
    if (f.type === "checkbox") {
      return `<div class="form-group form-check"><label class="check-label">
        <input type="checkbox" name="${f.name || f.label}" ${req}> ${f.label} ${reqMark}</label></div>`;
    }
    return `<div class="form-group"><label>${f.label} ${reqMark}</label>
      <input type="${f.type || 'text'}" name="${f.name || f.label}" placeholder="${f.placeholder || f.label}" ${req} class="form-input"></div>`;
  }).join("\n");

  // Zapier submit script
  const zapierScript = zapierWebhook ? `
    async function submitForm(e) {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = '${isHebrew ? "שולח..." : "Sending..."}';
      const form = e.target;
      const data = {};
      new FormData(form).forEach((v, k) => { data[k] = v; });
      // UTM passthrough
      const params = new URLSearchParams(window.location.search);
      ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(p => {
        if (params.get(p)) data[p] = params.get(p);
      });
      data.page_slug = '${pageSlug}';
      data.submitted_at = new Date().toISOString();
      try {
        await fetch('${zapierWebhook}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
          mode: 'no-cors'
        });
      } catch(err) { console.error('Zapier error:', err); }
      document.getElementById('form-container').innerHTML = '<div class="success-msg">${isHebrew ? "תודה! נציג יחזור אליך בהקדם 🎉" : "Thank you! We will be in touch soon 🎉"}</div>';
      ${redirectUrl ? `setTimeout(() => { window.location.href = '${redirectUrl}'; }, 2000);` : ""}
    }` : `
    function submitForm(e) {
      e.preventDefault();
      document.getElementById('form-container').innerHTML = '<div class="success-msg">${isHebrew ? "תודה! נציג יחזור אליך בהקדם 🎉" : "Thank you! We will be in touch soon 🎉"}</div>';
      ${redirectUrl ? `setTimeout(() => { window.location.href = '${redirectUrl}'; }, 2000);` : ""}
    }`;

  // Meta Pixel
  const pixelScript = metaPixelId ? `
  <!-- Meta Pixel -->
  <script>
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '${metaPixelId}');
    fbq('track', 'PageView');
  </\script>
  <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${metaPixelId}&ev=PageView&noscript=1"/></noscript>` : "";

  // WhatsApp button
  const whatsappBtn = whatsappEnabled ? `
  <a href="https://wa.me/${whatsappNumber.replace(/\D/g,'')}?text=${encodeURIComponent(whatsappMessage)}"
     class="whatsapp-btn" target="_blank" rel="noopener" title="WhatsApp">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
    </svg>
  </a>` : "";

  // Testimonials section
  const testimonialsSection = config.show_testimonials !== false && copy.testimonials ? `
  <section class="section testimonials-section">
    <div class="container">
      <h2 class="section-title">${isHebrew ? "מה לקוחותינו אומרים" : "What Our Clients Say"}</h2>
      <div class="testimonials-grid">
        ${copy.testimonials.map(t => `
        <div class="testimonial-card">
          <div class="stars">★★★★★</div>
          <p class="testimonial-text">"${t.text}"</p>
          <p class="testimonial-author">— ${t.author}</p>
        </div>`).join("")}
      </div>
    </div>
  </section>` : "";

  // FAQ section
  const faqSection = config.show_faq !== false && copy.faq ? `
  <section class="section faq-section">
    <div class="container">
      <h2 class="section-title">${isHebrew ? "שאלות נפוצות" : "Frequently Asked Questions"}</h2>
      <div class="faq-list">
        ${copy.faq.map((item, i) => `
        <div class="faq-item" onclick="toggleFaq(${i})">
          <div class="faq-question">
            <span>${item.question}</span>
            <span class="faq-arrow" id="arrow-${i}">▼</span>
          </div>
          <div class="faq-answer" id="faq-${i}">${item.answer}</div>
        </div>`).join("")}
      </div>
    </div>
  </section>` : "";

  // Stats bar
  const statsBar = config.show_stats !== false && copy.stats ? `
  <section class="stats-bar">
    <div class="container stats-grid">
      ${copy.stats.map(s => `
      <div class="stat-item">
        <div class="stat-number">${s.value}</div>
        <div class="stat-label">${s.label}</div>
      </div>`).join("")}
    </div>
  </section>` : "";

  // Logo HTML
  const logoHtml = logoDataUrl
    ? `<img src="${logoDataUrl}" alt="${brief.title}" class="nav-logo">`
    : logoUrl
    ? `<img src="${logoUrl}" alt="${brief.title}" class="nav-logo">`
    : `<span class="nav-brand">${brief.brand_name || brief.title}</span>`;

  // Content sections with images
  const contentSections = copy.sections ? copy.sections.map((sec, i) => `
  <section class="section content-section ${i % 2 === 1 ? "alt-bg" : ""}">
    <div class="container section-flex ${i % 2 === 1 ? "reverse" : ""}">
      ${contentImages[i] ? `<div class="section-image"><img src="${contentImages[i]}" alt="${sec.title || ""}" loading="lazy"></div>` : ""}
      <div class="section-text">
        ${sec.title ? `<h2 class="section-title">${sec.title}</h2>` : ""}
        ${sec.body ? `<p class="section-body">${sec.body}</p>` : ""}
        ${sec.bullets ? `<ul class="section-bullets">${sec.bullets.map(b => `<li>${b}</li>`).join("")}</ul>` : ""}
      </div>
    </div>
  </section>`).join("") : "";

  // Hero section
  const heroStyle = heroImage
    ? `background-image: url('${heroImage}'); background-size: cover; background-position: center;`
    : `background: linear-gradient(135deg, ${colors.bg} 0%, ${colors.cardBg} 100%);`;

  const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${copy.page_title || brief.title}</title>
  <meta name="description" content="${copy.meta_description || brief.context || ""}">
  ${metaPixelId ? pixelScript : ""}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Hebrew:wght@300;400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: 'Noto Sans Hebrew', Arial, sans-serif;
      background: ${colors.bg};
      color: ${colors.text};
      direction: ${dir};
      line-height: 1.6;
      overflow-x: hidden;
    }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

    /* NAV */
    nav {
      position: sticky; top: 0; z-index: 100;
      background: ${colors.navBg};
      backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 14px 0;
    }
    .nav-inner { display: flex; align-items: center; justify-content: space-between; }
    .nav-logo { height: 48px; width: auto; object-fit: contain; }
    .nav-brand { font-size: 1.3rem; font-weight: 700; color: ${colors.accent}; }
    .nav-phone { color: ${colors.accent}; font-size: 1.05rem; font-weight: 600; text-decoration: none; letter-spacing: 0.5px; }

    /* HERO */
    .hero {
      position: relative; min-height: 88vh;
      display: flex; align-items: center;
      ${heroStyle}
    }
    .hero::after {
      content: ''; position: absolute; inset: 0;
      background: ${colors.heroOverlay};
    }
    .hero-content { position: relative; z-index: 1; padding: 80px 0; }
    .hero-badge {
      display: inline-block; background: ${colors.accent};
      color: #fff; font-size: 0.8rem; font-weight: 700;
      padding: 5px 14px; border-radius: 20px; margin-bottom: 20px;
      text-transform: uppercase; letter-spacing: 1px;
    }
    .hero-title {
      font-size: clamp(2rem, 5vw, 3.4rem);
      font-weight: 800; line-height: 1.2;
      color: #fff; margin-bottom: 18px;
    }
    .hero-title span { color: ${colors.accent}; }
    .hero-subtitle {
      font-size: clamp(1rem, 2.5vw, 1.3rem);
      color: rgba(255,255,255,0.85);
      margin-bottom: 36px; max-width: 600px;
    }
    .hero-cta-group { display: flex; gap: 14px; flex-wrap: wrap; }
    .btn-primary {
      background: linear-gradient(135deg, ${colors.accent}, ${colors.accentDark});
      color: #fff; border: none; padding: 15px 32px;
      font-size: 1.05rem; font-weight: 700; border-radius: 8px;
      cursor: pointer; text-decoration: none; display: inline-block;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
    .btn-secondary {
      background: transparent; color: #fff;
      border: 2px solid rgba(255,255,255,0.5);
      padding: 13px 28px; font-size: 1rem; font-weight: 600;
      border-radius: 8px; cursor: pointer; text-decoration: none;
      display: inline-block; transition: all 0.2s;
    }
    .btn-secondary:hover { background: rgba(255,255,255,0.1); border-color: #fff; }

    /* STATS BAR */
    .stats-bar {
      background: ${colors.accent};
      padding: 28px 0;
    }
    .stats-grid { display: flex; justify-content: space-around; flex-wrap: wrap; gap: 20px; }
    .stat-item { text-align: center; }
    .stat-number { font-size: 2rem; font-weight: 800; color: #fff; }
    .stat-label { font-size: 0.85rem; color: rgba(255,255,255,0.85); font-weight: 500; }

    /* SECTIONS */
    .section { padding: 72px 0; }
    .alt-bg { background: ${colors.cardBg}; }
    .section-flex { display: flex; align-items: center; gap: 56px; }
    .section-flex.reverse { flex-direction: row-reverse; }
    .section-image { flex: 1; }
    .section-image img { width: 100%; border-radius: 12px; object-fit: cover; max-height: 380px; }
    .section-text { flex: 1; }
    .section-title {
      font-size: clamp(1.5rem, 3vw, 2.2rem);
      font-weight: 700; color: ${colors.text};
      margin-bottom: 16px; text-align: center;
    }
    .section-text .section-title { text-align: ${dir === "rtl" ? "right" : "left"}; }
    .section-body { color: ${colors.subtext}; font-size: 1.05rem; line-height: 1.8; margin-bottom: 16px; }
    .section-bullets { list-style: none; padding: 0; }
    .section-bullets li {
      padding: 8px 0 8px 8px;
      color: ${colors.subtext}; font-size: 1rem;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      display: flex; align-items: center; gap: 10px;
    }
    .section-bullets li::before {
      content: '✓'; color: ${colors.accent}; font-weight: 700;
      min-width: 20px;
    }

    /* FORM SECTION */
    .form-section {
      background: ${colors.cardBg};
      padding: 80px 0;
    }
    .form-wrapper {
      max-width: 560px; margin: 0 auto;
      background: ${colors.bg};
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px; padding: 48px 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .form-title { font-size: 1.8rem; font-weight: 700; margin-bottom: 8px; color: ${colors.text}; text-align: center; }
    .form-subtitle { color: ${colors.subtext}; margin-bottom: 32px; text-align: center; font-size: 0.95rem; }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; color: ${colors.subtext}; font-size: 0.85rem; font-weight: 600; margin-bottom: 6px; }
    .form-input {
      width: 100%; padding: 13px 16px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px; color: ${colors.text};
      font-size: 1rem; font-family: inherit;
      transition: border-color 0.2s;
    }
    .form-input:focus { outline: none; border-color: ${colors.accent}; }
    .form-check { display: flex; align-items: center; }
    .check-label { display: flex; align-items: center; gap: 10px; cursor: pointer; color: ${colors.subtext}; }
    .form-submit {
      width: 100%; padding: 16px;
      background: linear-gradient(135deg, ${colors.accent}, ${colors.accentDark});
      color: #fff; border: none; border-radius: 8px;
      font-size: 1.1rem; font-weight: 700;
      cursor: pointer; margin-top: 8px;
      transition: transform 0.2s, box-shadow 0.2s;
      font-family: inherit;
    }
    .form-submit:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.35); }
    .form-submit:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
    .success-msg {
      text-align: center; font-size: 1.3rem; font-weight: 700;
      color: ${colors.accent}; padding: 48px 24px;
    }

    /* TESTIMONIALS */
    .testimonials-section { background: ${colors.bg}; }
    .testimonials-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 24px; margin-top: 40px; }
    .testimonial-card {
      background: ${colors.cardBg};
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px; padding: 28px 24px;
    }
    .stars { color: ${colors.accent}; font-size: 1.1rem; margin-bottom: 12px; }
    .testimonial-text { color: ${colors.subtext}; font-size: 0.95rem; line-height: 1.7; margin-bottom: 14px; }
    .testimonial-author { color: ${colors.text}; font-weight: 600; font-size: 0.9rem; }

    /* FAQ */
    .faq-section { background: ${colors.cardBg}; }
    .faq-list { max-width: 760px; margin: 40px auto 0; }
    .faq-item {
      border-bottom: 1px solid rgba(255,255,255,0.08);
      cursor: pointer;
    }
    .faq-question {
      display: flex; justify-content: space-between; align-items: center;
      padding: 20px 0; font-weight: 600; font-size: 1rem;
      color: ${colors.text};
    }
    .faq-arrow { color: ${colors.accent}; transition: transform 0.3s; font-size: 0.8rem; }
    .faq-answer {
      display: none; color: ${colors.subtext};
      padding-bottom: 20px; font-size: 0.95rem; line-height: 1.7;
    }
    .faq-answer.open { display: block; }

    /* FOOTER */
    footer {
      background: #05050a;
      border-top: 1px solid rgba(255,255,255,0.06);
      padding: 32px 0; text-align: center;
    }
    .footer-text { color: rgba(255,255,255,0.3); font-size: 0.8rem; line-height: 1.8; }

    /* WHATSAPP FLOAT */
    .whatsapp-btn {
      position: fixed; bottom: 28px;
      ${dir === "rtl" ? "left: 28px;" : "right: 28px;"}
      background: #25d366;
      width: 60px; height: 60px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 20px rgba(37,211,102,0.4);
      z-index: 999; transition: transform 0.2s;
      text-decoration: none;
    }
    .whatsapp-btn:hover { transform: scale(1.1); }

    /* RESPONSIVE */
    @media (max-width: 768px) {
      .section-flex, .section-flex.reverse { flex-direction: column; }
      .hero-cta-group { flex-direction: column; }
      .btn-primary, .btn-secondary { text-align: center; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .form-wrapper { padding: 32px 20px; }
    }
  </style>
</head>
<body>

  <!-- NAV -->
  <nav>
    <div class="container nav-inner">
      <div>${logoHtml}</div>
      ${phoneInNav ? `<a href="tel:${phoneInNav.replace(/\s/g,'')}" class="nav-phone">${phoneInNav}</a>` : ""}
    </div>
  </nav>

  <!-- HERO -->
  <section class="hero">
    <div class="container hero-content">
      ${copy.badge ? `<div class="hero-badge">${copy.badge}</div>` : ""}
      <h1 class="hero-title">${copy.hero_title || brief.title}</h1>
      <p class="hero-subtitle">${copy.hero_subtitle || brief.context || ""}</p>
      <div class="hero-cta-group">
        <a href="#lead-form" class="btn-primary">${copy.cta_primary || submitText}</a>
        ${copy.cta_secondary ? `<a href="#content" class="btn-secondary">${copy.cta_secondary}</a>` : ""}
      </div>
    </div>
  </section>

  <!-- STATS BAR -->
  ${statsBar}

  <!-- CONTENT SECTIONS -->
  <div id="content">
    ${contentSections}
  </div>

  <!-- TESTIMONIALS -->
  ${testimonialsSection}

  <!-- FAQ -->
  ${faqSection}

  <!-- LEAD FORM -->
  <section class="form-section" id="lead-form">
    <div class="container">
      <div class="form-wrapper">
        <h2 class="form-title">${copy.form_title || (isHebrew ? "השאירו פרטים" : "Get In Touch")}</h2>
        <p class="form-subtitle">${copy.form_subtitle || (isHebrew ? "נציג יחזור אליכם בהקדם האפשרי" : "We will get back to you shortly")}</p>
        <div id="form-container">
          <form onsubmit="submitForm(event)" novalidate>
            ${formFieldsHtml}
            <button type="submit" class="form-submit" id="submit-btn">${submitText}</button>
          </form>
        </div>
      </div>
    </div>
  </section>

  <!-- FOOTER -->
  <footer>
    <div class="container">
      <p class="footer-text">
        ${copy.footer_disclaimer || brief.disclaimer || (isHebrew ? "המידע באתר זה אינו מהווה ייעוץ משפטי או פיננסי. התמונות להמחשה בלבד." : "The information on this site does not constitute legal or financial advice. Images are for illustration purposes only.")}
      </p>
    </div>
  </footer>

  <!-- WHATSAPP FLOAT -->
  ${whatsappBtn}

  <script>
    ${zapierScript}

    function toggleFaq(i) {
      const el = document.getElementById('faq-' + i);
      const arrow = document.getElementById('arrow-' + i);
      if (el.classList.contains('open')) {
        el.classList.remove('open');
        arrow.style.transform = 'rotate(0deg)';
      } else {
        document.querySelectorAll('.faq-answer').forEach(a => a.classList.remove('open'));
        document.querySelectorAll('.faq-arrow').forEach(a => a.style.transform = 'rotate(0deg)');
        el.classList.add('open');
        arrow.style.transform = 'rotate(180deg)';
      }
    }

    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const target = document.querySelector(a.getAttribute('href'));
        if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      });
    });
  </script>
</body>
</html>`;

  return html;
}

async function generateLandingPageCopyWithAI(brief, config) {
  if (!openai) throw new Error("OpenAI not configured");
  const lang = config.language || "he";
  const isHebrew = lang === "he";

  const prompt = `You are an expert ${isHebrew ? "Hebrew-language" : "English-language"} landing page copywriter specializing in ${brief.campaign_type || "real estate"} marketing.

Create complete landing page copy for the following brief:
Title: ${brief.title}
Context: ${brief.context || ""}
Audience: ${brief.audience || ""}
Tone: ${brief.tone || "premium, professional"}
CTA: ${brief.cta || ""}
Offer/Product: ${brief.offer || ""}
Location: ${brief.location || ""}
Key points: ${brief.key_points?.join(", ") || ""}

${config.show_testimonials !== false ? "Include 3 testimonials." : "No testimonials needed."}
${config.show_faq !== false ? "Include 4 FAQ items." : "No FAQ needed."}
${config.show_stats !== false ? "Include 3-4 compelling stats/numbers." : "No stats needed."}

Respond ONLY with a JSON object (no markdown, no backticks) in this exact shape:
{
  "page_title": "...",
  "meta_description": "...",
  "badge": "...",
  "hero_title": "...",
  "hero_subtitle": "...",
  "cta_primary": "...",
  "cta_secondary": "...",
  "form_title": "...",
  "form_subtitle": "...",
  "sections": [
    { "title": "...", "body": "...", "bullets": ["...","...","..."] },
    { "title": "...", "body": "...", "bullets": ["...","...","..."] }
  ],
  "stats": [
    { "value": "...", "label": "..." }
  ],
  "testimonials": [
    { "text": "...", "author": "..." }
  ],
  "faq": [
    { "question": "...", "answer": "..." }
  ],
  "footer_disclaimer": "..."
}

All text must be in ${isHebrew ? "Hebrew" : "English"}. Make copy compelling, specific, and conversion-focused.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 3000,
  });

  const raw = response.choices[0].message.content || "";
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function runLandingPageBuilder(task) {
  const input = getTaskInput(task);
  const sourceTaskId = normalizeText(input.source_task_id, "");
  const briefTitle = getBriefTitle(task);
  const assets = getAssets(task);

  // ── 1. Gather sibling outputs ──────────────────────────────────────────────
  let siblings = [];
  if (sourceTaskId) {
    siblings = await listSiblingTasksForSourceTask(sourceTaskId);
  }

  const copyTask = siblings.find(
    (item) =>
      ["article", "ad_copy"].includes(normalizeText(item.type).toLowerCase()) &&
      normalizeText(item.status).toLowerCase() === "done"
  );
  const visualTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase() === "visual_prompts" &&
      normalizeText(item.status).toLowerCase() === "done"
  );
  const imageTask = siblings.find(
    (item) =>
      normalizeText(item.type).toLowerCase() === "background_images" &&
      normalizeText(item.status).toLowerCase() === "done"
  );

  const copyOutput = copyTask?.output_data || {};
  const visualOutput = visualTask?.output_data || {};
  const imageOutput = imageTask?.output_data || {};

  // ── 2. Collect images (sibling-generated first, then asset URLs) ───────────
  const siblingImages = Array.isArray(imageOutput.generated_images)
    ? imageOutput.generated_images
        .map((img) => img.image_public_url || img.public_url || img.url || "")
        .filter(Boolean)
    : [];
  const assetImages = assets.images || [];
  const allImages = [...siblingImages, ...assetImages];

  // ── 3. Resolve logo ────────────────────────────────────────────────────────
  // Priority: input.logo_url > assets.logos[0] > generate with Gemini
  const logoUrlInput = normalizeText(input.logo_url, "");
  const assetLogo = assets.logos?.[0] || "";
  let logoUrl = logoUrlInput || assetLogo || "";
  let logoDataUrl = "";
  const brandName = normalizeText(input.brand_name || input.brand, "");

  if (!logoUrl && brandName) {
    try {
      console.log(`🎨 No logo provided — generating logo for: ${brandName}`);
      logoDataUrl = await generateLogoWithGemini(brandName);
      console.log("✅ Logo generated by Gemini");
    } catch (logoErr) {
      console.error("⚠️ Logo generation failed:", logoErr?.message || logoErr);
    }
  }

  // ── 4. Build brief from task + sibling copy ────────────────────────────────
  const normalizedBrief = buildNormalizedBrief(task);
  normalizedBrief.brand_name = brandName || briefTitle;

  // ── 5. Landing page config from input_data ─────────────────────────────────
  const config = {
    language: normalizeText(input.language, "he"),
    color_scheme: normalizeText(input.color_scheme, "dark_luxury"),
    page_slug: normalizeText(input.page_slug, `page-${Date.now()}`),
    // Form
    form_fields: Array.isArray(input.form_fields) ? input.form_fields : [],
    submit_button_text: normalizeText(input.submit_button_text, ""),
    zapier_webhook_url: normalizeText(input.zapier_webhook_url, ""),
    redirect_url: normalizeText(input.redirect_url, ""),
    // Optional sections
    show_testimonials: input.show_testimonials !== false,
    show_faq: input.show_faq !== false,
    show_stats: input.show_stats !== false,
    // Optional elements
    whatsapp_enabled: Boolean(input.whatsapp_enabled) && Boolean(input.whatsapp_number),
    whatsapp_number: normalizeText(input.whatsapp_number, ""),
    whatsapp_message: normalizeText(input.whatsapp_message, ""),
    phone_in_nav: normalizeText(input.phone_in_nav, ""),
    meta_pixel_id: normalizeText(input.meta_pixel_id, ""),
  };

  // ── 6. Generate AI copy ────────────────────────────────────────────────────
  let copy;
  try {
    // Use existing copywriter output as seed if available
    const existingCopy = normalizeText(
      copyOutput.article || copyOutput.body || copyOutput.ad_copy,
      ""
    );
    const enrichedBrief = {
      ...normalizedBrief,
      existing_copy_seed: existingCopy ? existingCopy.slice(0, 1200) : undefined,
      visual_style: normalizeText(visualOutput.visual_style, ""),
      color_palette: normalizeText(visualOutput.color_palette, ""),
    };
    copy = await generateLandingPageCopyWithAI(enrichedBrief, config);
    console.log("✅ Landing page copy generated by GPT-4o");
  } catch (copyErr) {
    console.error("⚠️ AI copy generation failed, using fallback:", copyErr?.message || copyErr);
    const isHebrew = config.language === "he";
    copy = {
      page_title: briefTitle,
      meta_description: normalizedBrief.context || briefTitle,
      badge: isHebrew ? "הזדמנות מיוחדת" : "Special Offer",
      hero_title: briefTitle,
      hero_subtitle: normalizedBrief.context || "",
      cta_primary: normalizedBrief.cta || (isHebrew ? "השאירו פרטים" : "Get In Touch"),
      cta_secondary: isHebrew ? "גלו עוד" : "Learn More",
      form_title: isHebrew ? "השאירו פרטים" : "Contact Us",
      form_subtitle: isHebrew ? "נחזור אליכם בהקדם" : "We will get back to you soon",
      sections: [{ title: briefTitle, body: normalizedBrief.context || "", bullets: normalizedBrief.key_points }],
      stats: [],
      testimonials: [],
      faq: [],
      footer_disclaimer: normalizedBrief.disclaimer,
    };
  }

  // ── 7. Build HTML ──────────────────────────────────────────────────────────
  let html;
  try {
    html = await buildLandingPageHTML({
      brief: normalizedBrief,
      copy,
      images: allImages,
      logoDataUrl,
      logoUrl,
      config,
    });
    console.log("✅ Landing page HTML built");
  } catch (htmlErr) {
    console.error("❌ HTML build failed:", htmlErr?.message || htmlErr);
    throw htmlErr;
  }

  // ── 8. Save HTML file ──────────────────────────────────────────────────────
  await ensureDir(PAGES_DIR);
  const safeSlug = config.page_slug.replace(/[^a-z0-9-_]/gi, "-").slice(0, 60) || `page-${Date.now()}`;
  const fileName = `${safeSlug}.html`;
  const filePath = path.join(PAGES_DIR, fileName);
  await fs.writeFile(filePath, html, "utf8");
  const publicUrl = PUBLIC_ASSET_BASE_URL
    ? `${PUBLIC_ASSET_BASE_URL}/pages/${fileName}`
    : `/pages/${fileName}`;
  console.log(`✅ Landing page saved: ${filePath}`);

  return {
    ok: true,
    note: "landing_page_builder completed",
    brief_title: briefTitle,
    planner_brief: input.planner_brief ?? null,
    related_sources: {
      copy_task_found: Boolean(copyTask),
      image_task_found: Boolean(imageTask),
      images_used: allImages.length,
      logo_source: logoDataUrl ? "gemini_generated" : logoUrl ? "provided_url" : "none",
    },
    landing_page: {
      file_name: fileName,
      file_path: filePath,
      public_url: publicUrl,
      page_slug: safeSlug,
      language: config.language,
      whatsapp_enabled: config.whatsapp_enabled,
      form_fields_count: (config.form_fields.length > 0 ? config.form_fields : [1, 2, 3]).length,
      has_meta_pixel: Boolean(config.meta_pixel_id),
      has_zapier: Boolean(config.zapier_webhook_url),
      html_size_bytes: Buffer.byteLength(html, "utf8"),
    },
  };
}

// ── QA Agent ──────────────────────────────────────────────────────────────────
async function runQA(task) {
  const input = getTaskInput(task);
  const sourceTaskId = normalizeText(input.source_task_id, "");
  const briefTitle = getBriefTitle(task);

  // Gather all sibling tasks
  let siblings = [];
  if (sourceTaskId) {
    siblings = await listSiblingTasksForSourceTask(sourceTaskId);
  }

  const find = (type) =>
    siblings.find(
      (s) => normalizeText(s.type).toLowerCase() === type && normalizeText(s.status).toLowerCase() === "done"
    );

  const copyTask    = find("article") || find("ad_copy");
  const imageTask   = find("background_images");
  const bannerTask  = find("banner_set");
  const lpTask      = find("landing_page");

  const copyOutput   = copyTask?.output_data   || null;
  const imageOutput  = imageTask?.output_data  || null;
  const bannerOutput = bannerTask?.output_data || null;
  const lpOutput     = lpTask?.output_data     || null;

  // ── Structured checks ──────────────────────────────────────────────────────
  const checks = [];
  const flag = (id, label, passed, detail = "") =>
    checks.push({ id, label, passed, detail });

  // Copywriter
  flag("copy_exists",    "Copy task completed",        Boolean(copyTask),   copyTask ? "" : "No done copywriter task found");
  flag("copy_title",     "Page title present",         Boolean(copyOutput?.title || copyOutput?.page_title || copyOutput?.headlines?.length), "");
  flag("copy_body",      "Body copy present",          Boolean(copyOutput?.article_text || copyOutput?.primary_texts?.length), "");

  // Images
  const generatedImages = imageOutput?.generated_images || [];
  const goodImages = generatedImages.filter((img) => img.generation_status === "generated" && img.image_public_url);
  flag("images_exist",   "Images task completed",      Boolean(imageTask),  imageTask ? "" : "No done image_generator task found");
  flag("images_count",   "At least 2 images generated", goodImages.length >= 2, `${goodImages.length} image(s) generated`);
  flag("images_urls",    "All images have public URLs", goodImages.length === generatedImages.length && generatedImages.length > 0, "");

  // Banners
  const banners = bannerOutput?.banners || bannerOutput?.final_banners || [];
  const goodBanners = banners.filter((b) => b.status === "composed" || b.status === "generated" || b.image_public_url || b.composed_image_url);
  flag("banners_exist",  "Banner task completed",      Boolean(bannerTask), bannerTask ? "" : "No done banner task found");
  flag("banners_count",  "At least 1 banner composed", goodBanners.length >= 1, `${goodBanners.length} banner(s) found`);

  // Landing page
  const lp = lpOutput?.landing_page || null;
  flag("lp_exists",      "Landing page task completed", Boolean(lpTask),    lpTask ? "" : "No done landing_page_builder task found");
  flag("lp_url",         "Landing page has public URL", Boolean(lp?.public_url), lp?.public_url || "");
  flag("lp_form",        "Lead form has fields",        (lp?.form_fields_count || 0) >= 2, `${lp?.form_fields_count || 0} form field(s)`);

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;
  const score  = Math.round((passed / checks.length) * 100);

  // ── AI narrative review ────────────────────────────────────────────────────
  let ai_review = null;
  if (openai && copyOutput) {
    try {
      const reviewPrompt = `You are a senior marketing QA reviewer for a real estate advertising agency.
Review the following campaign outputs and provide a short, actionable QA report in Hebrew.

Brief: ${briefTitle}

Copy output summary:
${JSON.stringify({ title: copyOutput.title || copyOutput.page_title, headlines: copyOutput.headlines, article_text: (copyOutput.article_text || "").slice(0, 400) }, null, 2)}

Pipeline status:
- Copywriter: ${copyTask ? "✅ done" : "❌ missing"}
- Images: ${goodImages.length} generated
- Banners: ${goodBanners.length} composed
- Landing page: ${lp?.public_url ? "✅ built — " + lp.public_url : "❌ missing"}
- QA score: ${score}/100 (${passed}/${checks.length} checks passed)

Failed checks: ${checks.filter(c => !c.passed).map(c => c.label).join(", ") || "none"}

Respond in Hebrew with:
1. סיכום קצר (2-3 משפטים) של מצב הקמפיין
2. בעיות שנמצאו (אם יש)
3. המלצה: האם הקמפיין מוכן לפרסום?

Be concise and direct.`;

      const reviewResponse = await openai.responses.create({
        model: "gpt-4o",
        input: reviewPrompt,
        max_output_tokens: 400,
      });
      ai_review = reviewResponse.output_text?.trim() || null;
    } catch (e) {
      console.warn("⚠️ QA AI review failed:", e?.message);
    }
  }

  const approved = score >= 60 && Boolean(lp?.public_url);

  console.log(`🔍 QA complete — score: ${score}/100, approved: ${approved}`);

  return {
    ok: true,
    brief_title: briefTitle,
    approved,
    score,
    passed_checks: passed,
    total_checks: checks.length,
    checks,
    ai_review,
    pipeline_summary: {
      copy:        copyTask  ? { status: "done", id: copyTask.id }  : null,
      images:      imageTask ? { status: "done", count: goodImages.length, id: imageTask.id } : null,
      banners:     bannerTask? { status: "done", count: goodBanners.length, id: bannerTask.id } : null,
      landing_page: lpTask   ? { status: "done", public_url: lp?.public_url, id: lpTask.id } : null,
    },
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
      console.error(
        "⚠️ AI visual_director failed, using fallback:",
        e?.message || e
      );
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
          `צור תמונת נדל"ן שיווקית עבור ${getBriefTitle(
            task
          )} בסגנון יוקרתי, מודרני, נקי, עם תאורה טבעית, קומפוזיציה חזקה ואווירת פרימיום`,
          `צור ויזואל שיווקי עבור ${getBriefTitle(
            task
          )} שמתאים לבאנר נדל"ן, עם דגש על יוקרה, אמינות, השקעה חכמה ונראות מסחרית גבוהה`,
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
    return await runImageGenerator(task);
  },
  banner_renderer: async (task) => {
    return await runBannerRenderer(task);
  },
  banner_composer: async (task) => {
    return await runBannerComposer(task);
  },
  landing_page_builder: async (task) => {
    return runLandingPageBuilder(task);
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
    return runQA(task);
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

function sendBuffer(
  res,
  statusCode,
  buffer,
  contentType = "application/octet-stream"
) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(buffer);
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

async function handleFileRequest(url, res) {
  const relativePath = decodeURIComponent(
    url.pathname.replace(/^\/files\//, "")
  );
  const absPath = path.resolve(PUBLIC_DIR, relativePath);
  if (!absPath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }
  try {
    const fileBuffer = await fs.readFile(absPath);
    const ext = path.extname(absPath).toLowerCase();
    let contentType = "application/octet-stream";
    if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".webp") contentType = "image/webp";
    else if (ext === ".svg") contentType = "image/svg+xml";
    else if (ext === ".json") contentType = "application/json";
    sendBuffer(res, 200, fileBuffer, contentType);
  } catch {
    sendJson(res, 404, { ok: false, error: "File not found" });
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
  if (req.method === "GET" && url.pathname.startsWith("/files/")) {
    await handleFileRequest(url, res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/pages/")) {
    const fileName = path.basename(url.pathname);
    const absPath = path.resolve(PAGES_DIR, fileName);
    if (!absPath.startsWith(PAGES_DIR) || !fileName.endsWith(".html")) {
      sendJson(res, 403, { ok: false, error: "Forbidden" });
      return;
    }
    try {
      const fileBuffer = await fs.readFile(absPath);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
      });
      res.end(fileBuffer);
    } catch {
      sendJson(res, 404, { ok: false, error: "Page not found" });
    }
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "agent-runner",
      uptime_sec: Math.round(process.uptime()),
      now: new Date().toISOString(),
      ai_enabled: Boolean(openai || gemini),
      openai_enabled: Boolean(openai),
      gemini_enabled: Boolean(gemini),
      imagen_model: gemini ? IMAGEN_MODEL : null,
      gemini_banner_model: gemini ? GEMINI_BANNER_MODEL : null,
      gemini_image_model: gemini ? GEMINI_IMAGE_MODEL : null,
      public_dir: PUBLIC_DIR,
      public_asset_base_url: PUBLIC_ASSET_BASE_URL || null,
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
  await ensureDir(GENERATED_IMAGES_DIR);
  await ensureDir(BANNERS_DIR);
  await ensureDir(PAGES_DIR);
  await auth();
  if (openai) {
    console.log("🤖 OpenAI is enabled for copywriter");
  } else {
    console.log("⚠️ OpenAI is not configured. Copywriter will use fallback outputs.");
  }
  if (gemini) {
    console.log(`🟣 Gemini is configured and ready`);
    console.log(`   📸 Background images: ${IMAGEN_MODEL}`);
    console.log(`   🎨 Banner composition: ${GEMINI_BANNER_MODEL}`);
  } else {
    console.log("⚠️ Gemini is not configured yet.");
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
