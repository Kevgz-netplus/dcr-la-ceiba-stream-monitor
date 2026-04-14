import fs from "fs/promises";
import { GoogleAuth } from "google-auth-library";

const STREAM_URL = process.env.STREAM_URL;
const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID;
const FCM_TOPIC = process.env.FCM_TOPIC || "radio_status";
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!STREAM_URL) throw new Error("Missing STREAM_URL");
if (!FCM_PROJECT_ID) throw new Error("Missing FCM_PROJECT_ID");
if (!FIREBASE_SERVICE_ACCOUNT) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT");

const STATE_FILE = "./state.json";

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { lastStatus: "unknown" };
  }
}

async function writeState(nextStatus) {
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify({ lastStatus: nextStatus }, null, 2) + "\n",
    "utf8"
  );
}

async function checkStream() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(STREAM_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Icy-MetaData": "1",
        "User-Agent": "DCR-La-Ceiba-Monitor/1.0"
      }
    });

    clearTimeout(timeout);

    // Ajusta esto si tu proveedor usa otro código cuando sí hay transmisión.
    const isOnline = response.ok;
    return {
      status: isOnline ? "online" : "offline",
      details: `HTTP ${response.status}`
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      status: "offline",
      details: error?.name === "AbortError" ? "Timeout" : String(error)
    };
  }
}

async function getAccessToken() {
  const credentials = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"]
  });

  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token = accessTokenResponse?.token || accessTokenResponse;

  if (!token) {
    throw new Error("Could not get OAuth access token for FCM");
  }

  return token;
}

async function sendTopicMessage({ title, body, status }) {
  const accessToken = await getAccessToken();

  const payload = {
    message: {
      topic: FCM_TOPIC,
      notification: {
        title,
        body
      },
      data: {
        status,
        source: "github_actions_monitor"
      },
      android: {
        priority: "high",
        notification: {
          channel_id: "com.dcr.radio.channel.audio"
        }
      },
      apns: {
        headers: {
          "apns-priority": "10"
        },
        payload: {
          aps: {
            sound: "default"
          }
        }
      }
    }
  };

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${FCM_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`FCM send failed: ${response.status} ${text}`);
  }

  console.log("FCM sent:", text);
}

async function main() {
  const previous = await readState();
  const current = await checkStream();

  console.log("Previous status:", previous.lastStatus);
  console.log("Current status:", current.status, "-", current.details);

  if (previous.lastStatus === current.status) {
    console.log("No status change. Nothing to notify.");
    return;
  }

  if (current.status === "offline") {
    await sendTopicMessage({
      title: "DCR La Ceiba temporalmente fuera de línea",
      body: "La transmisión no está disponible en este momento. Se restablecerá lo más pronto posible.",
      status: "offline"
    });
  } else if (current.status === "online") {
    await sendTopicMessage({
      title: "DCR La Ceiba ya fue restablecida",
      body: "La transmisión en vivo está nuevamente disponible.",
      status: "online"
    });
  }

  await writeState(current.status);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
