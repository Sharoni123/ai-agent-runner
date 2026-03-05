import PocketBase from "pocketbase";

const PB_URL = process.env.POCKETBASE_URL;
const PB_EMAIL = process.env.POCKETBASE_ADMIN_EMAIL;
const PB_PASSWORD = process.env.POCKETBASE_ADMIN_PASSWORD;

if (!PB_URL || !PB_EMAIL || !PB_PASSWORD) {
  console.error("Missing env vars: POCKETBASE_URL / POCKETBASE_ADMIN_EMAIL / POCKETBASE_ADMIN_PASSWORD");
  process.exit(1);
}

const pb = new PocketBase(PB_URL);

async function main() {
  await pb.admins.authWithPassword(PB_EMAIL, PB_PASSWORD);
  console.log("✅ Agent Runner connected to PocketBase");

  // Keep the process alive (so Railway won't exit)
  setInterval(() => {
    console.log("🟢 heartbeat", new Date().toISOString());
  }, 30000);
}

main().catch((err) => {
  console.error("❌ Runner error:", err);
  process.exit(1);
});
