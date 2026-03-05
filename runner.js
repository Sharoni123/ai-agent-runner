import PocketBase from "pocketbase";

const PB_URL = process.env.POCKETBASE_URL;
const ADMIN_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL;
const ADMIN_PASS = process.env.POCKETBASE_ADMIN_PASSWORD;

if (!PB_URL || !ADMIN_EMAIL || !ADMIN_PASS) {
  console.error("Missing environment variables.");
  process.exit(1);
}

const pb = new PocketBase(PB_URL);

async function main() {
  console.log("Starting agent runner...");

  // התחברות ל-PocketBase
  await pb.collection("_superusers").authWithPassword(
    ADMIN_EMAIL,
    ADMIN_PASS
  );

  console.log("✅ Connected to PocketBase");

  // שומר את השרת חי
  setInterval(() => {
    console.log("heartbeat", new Date().toISOString());
  }, 15000);
}

main().catch((err) => {
  console.error("Runner error:", err);
  process.exit(1);
});
