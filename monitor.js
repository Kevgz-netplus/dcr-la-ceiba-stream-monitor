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
const STATUS_FILE = "./stream-status.json";

// How many times the stream is probed before a verdict, and how many of those
// probes have to fail for it to count as down.
const MAX_ATTEMPTS = 3;
const FAILURES_TO_DECLARE_OFFLINE = 2;
const RETRY_DELAY_MS = 5000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { lastStatus: "unknown" };
  }
}

// `lastNotifiedStatus` is tracked apart from `lastStatus` on purpose.
//
// The state used to be saved only after the notification had gone out, so a
// failed FCM call left state.json claiming the old status while
// stream-status.json already carried the new one: the two files disagreed
// about reality. Keeping the two facts apart lets the observation be recorded
// straight away and still leaves the notification to be retried next run.
async function writeState({ lastStatus, lastNotifiedStatus }) {
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify({ lastStatus, lastNotifiedStatus }, null, 2) + "\n",
    "utf8"
  );
}

async function readPublicStatus() {
  try {
    return JSON.parse(await fs.readFile(STATUS_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Written only when something a reader would care about changed.
//
// The old version stamped a fresh `lastChecked` on every run, so the file
// always differed and the workflow always had something to commit. That is
// where the 2,020 commits came from, and why the promise in the README to exit
// silently when nothing changed was never true. The timestamp now marks the
// last change rather than the last check, which is the only one of the two
// that means anything in a file that is no longer rewritten every run.
async function writePublicStatus({ status, details }) {
  const online = status === "online";
  const message = online ? "Stream activo" : `Señal no disponible (${details})`;
  const previous = await readPublicStatus();

  if (previous && previous.online === online && previous.message === message) {
    return false;
  }

  await fs.writeFile(
    STATUS_FILE,
    JSON.stringify(
      { online, lastChanged: new Date().toISOString(), message },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return true;
}

async function probeStream() {
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

// Declares the stream down only once the failures add up.
//
// A single failed fetch used to be enough to notify every listener. The probe
// runs on a shared GitHub runner over the public internet, so one isolated
// failure says more about the runner than about the transmitter in La Ceiba,
// and that is the likeliest source of the false "fuera de linea" pushes.
//
// Stops as soon as the probes left cannot change the verdict, so a stream that
// is plainly up costs two requests rather than three.
async function checkStream() {
  const attempts = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await delay(RETRY_DELAY_MS);

    attempts.push(await probeStream());

    const last = attempts[attempts.length - 1];
    console.log(`Probe ${attempt}/${MAX_ATTEMPTS}: ${last.status} - ${last.details}`);

    const failures = attempts.filter((a) => a.status === "offline").length;
    const remaining = MAX_ATTEMPTS - attempts.length;

    if (failures >= FAILURES_TO_DECLARE_OFFLINE) {
      return verdict(attempts, "offline");
    }

    if (failures + remaining < FAILURES_TO_DECLARE_OFFLINE) {
      return verdict(attempts, "online");
    }
  }

  return verdict(attempts, "offline");
}

// Reports the verdict with the details of the last probe that supports it, so
// an offline result carries the failure that caused it rather than whichever
// probe happened to run last.
function verdict(attempts, status) {
  const supporting = attempts.filter((a) => a.status === status);
  const source = supporting[supporting.length - 1] ?? attempts[attempts.length - 1];

  return { status, details: source.details };
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

  // Older state files only carried `lastStatus`, which stood for both the last
  // thing seen and the last thing announced.
  const lastNotifiedStatus = previous.lastNotifiedStatus ?? previous.lastStatus;

  console.log("Previous status:", previous.lastStatus);
  console.log("Last notified:", lastNotifiedStatus);
  console.log("Current status:", current.status, "-", current.details);

  const statusFileChanged = await writePublicStatus(current);
  console.log(
    statusFileChanged
      ? "Public status rewritten."
      : "Public status unchanged. Nothing to commit."
  );

  // Recorded before notifying, so the two files agree even if FCM fails.
  await writeState({ lastStatus: current.status, lastNotifiedStatus });

  // A first run has nothing to compare against. Announcing that the stream
  // "ya fue restablecida" because the monitor had never run before would be a
  // push nobody asked for, so a first observation is only recorded.
  if (lastNotifiedStatus === "unknown") {
    console.log("No previous status to compare against. Recorded, not notified.");
    await writeState({
      lastStatus: current.status,
      lastNotifiedStatus: current.status
    });
    return;
  }

  if (lastNotifiedStatus === current.status) {
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

  await writeState({
    lastStatus: current.status,
    lastNotifiedStatus: current.status
  });
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
