import express, { Request, Response } from "express";
import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { calculateParticipantDuration } from "./services/duration.service";
import { getActualMeetParticipants, MeetingParticipant, extractMeetingCode } from "./services/meet.service";
import { classifyMeetingWithAI, AIClassificationResult } from "./services/ai-classification.service";
import {
  seedTasksheetDemoData,
  validateAndCreateTasksheetEntries,
  formatMinutesToEffortString,
  findBestMatchingEmployee,
  INITIAL_DEMO_EMPLOYEES,
  INITIAL_DEMO_PROJECTS,
} from "./services/tasksheet.service";
import {
  syncEmployeesFromExternal,
  syncProjectsFromExternal,
  pushTasksheetEntryToExternal,
  retryPendingTasksheetSyncs,
  addEmployeeEmailAlias,
  removeEmployeeEmailAlias,
  getEmployeeEmailAliases,
  getExternalSyncConfig,
} from "./services/external-sync.service";
import multer from "multer";
import {
  transcribeAudioChunk,
  appendMeetingTranscript,
  getMeetingTranscript,
  ensureTranscriptTableExists,
  clearMeetingTranscript,
} from "./services/transcript.service";

dotenv.config();

const app = express();

// CORS Middleware for Chrome Extension communication
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// Configure Multer for in-memory audio chunk uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max for full meeting audio
});

// Parse JSON webhook requests
app.use(express.json());

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const TOKEN_PATH = path.join(process.cwd(), "token.json");

// --------------------------------------------------
// Google OAuth Scopes (Calendar + Meet APIs)
// --------------------------------------------------

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/meetings.space.readonly",
];

export interface Meeting {
  id?: number;
  eventId: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  startTimestamp: string;
  endTimestamp: string;
  durationMinutes: number;
  meetLink: string;
  organizer: string | null;
  participants: string[];
  description: string | null;
  status?: string;
  projectId?: string | null;
  projectName?: string | null;
  projectConfidence?: number | null;
  projectReason?: string | null;
}

interface CalendarWatch {
  id: number;
  channelId: string;
  resourceId: string | null;
  calendarId: string;
  expiration: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// --------------------------------------------------
// Load Google OAuth credentials
// --------------------------------------------------

if (!fs.existsSync(CREDENTIALS_PATH)) {
  throw new Error("credentials.json not found in project root.");
}

const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));

if (!credentials.web) {
  throw new Error("Invalid credentials.json. Expected web OAuth credentials.");
}

const { client_id, client_secret } = credentials.web;

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  REDIRECT_URI
);

// Automatically persist refreshed OAuth tokens to token.json to prevent invalid_grant
oauth2Client.on("tokens", (tokens) => {
  try {
    let current: any = {};
    if (fs.existsSync(TOKEN_PATH)) {
      current = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    }
    const merged = { ...current, ...tokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    console.log("[OAUTH] Refreshed OAuth tokens automatically persisted to token.json.");
  } catch (err) {
    console.error("[OAUTH] Error persisting refreshed tokens:", err);
  }
});

// --------------------------------------------------
// SQLite database Initialization & Migrations
// --------------------------------------------------

const db = new Database(path.join(process.cwd(), "meetings.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_event_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    date TEXT,
    start_time TEXT,
    end_time TEXT,
    start_timestamp TEXT,
    end_timestamp TEXT,
    duration_minutes INTEGER,
    meet_link TEXT,
    organizer TEXT,
    participants TEXT,
    description TEXT,
    status TEXT DEFAULT 'DETECTED',
    project_id TEXT,
    project_name TEXT,
    project_confidence REAL,
    project_reason TEXT,
    demo_participants_json TEXT,
    conference_record_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

try {
  db.exec("ALTER TABLE meetings ADD COLUMN conference_record_id TEXT;");
} catch (e) {
  // column already exists
}

db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_watch_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT UNIQUE NOT NULL,
    resource_id TEXT,
    calendar_id TEXT UNIQUE NOT NULL,
    expiration TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS meeting_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL,
    participant_id TEXT NOT NULL,
    employee_email TEXT,
    display_name TEXT,
    total_duration_minutes INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS meeting_participant_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_participant_id INTEGER NOT NULL,
    joined_at TEXT NOT NULL,
    left_at TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (meeting_participant_id) REFERENCES meeting_participants(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT UNIQUE NOT NULL,
    project_name TEXT NOT NULL,
    description TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS employee_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(employee_id, project_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tasksheet_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    meeting_id INTEGER,
    project_id TEXT NOT NULL,
    date TEXT NOT NULL,
    task_category TEXT NOT NULL,
    task_details TEXT NOT NULL,
    effort_minutes INTEGER NOT NULL,
    comments TEXT DEFAULT 'Meeting',
    source TEXT DEFAULT 'MEETING_AUTOMATION',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(meeting_id, employee_id, date),
    FOREIGN KEY (employee_id) REFERENCES employees(employee_id),
    FOREIGN KEY (project_id) REFERENCES projects(project_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  )
`);

// Execute DB migrations safely for existing databases
try { db.exec("ALTER TABLE meetings ADD COLUMN project_id TEXT;"); } catch {}
try { db.exec("ALTER TABLE meetings ADD COLUMN project_name TEXT;"); } catch {}
try { db.exec("ALTER TABLE meetings ADD COLUMN project_confidence REAL;"); } catch {}
try { db.exec("ALTER TABLE meetings ADD COLUMN project_reason TEXT;"); } catch {}
try { db.exec("ALTER TABLE meetings ADD COLUMN demo_participants_json TEXT;"); } catch {}
try { db.exec("ALTER TABLE meetings ADD COLUMN start_timestamp TEXT;"); } catch {}
try { db.exec("ALTER TABLE meetings ADD COLUMN end_timestamp TEXT;"); } catch {}
try { db.exec("ALTER TABLE tasksheet_entries ADD COLUMN created_at TEXT;"); } catch {}
try { db.exec("ALTER TABLE tasksheet_entries ADD COLUMN updated_at TEXT;"); } catch {}
try { db.exec("ALTER TABLE tasksheet_entries ADD COLUMN sync_status TEXT DEFAULT 'PENDING';"); } catch {}
try { db.exec("ALTER TABLE tasksheet_entries ADD COLUMN external_entry_id TEXT;"); } catch {}
try { db.exec("ALTER TABLE tasksheet_entries ADD COLUMN synced_at TEXT;"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS employee_email_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    alias_email TEXT UNIQUE NOT NULL,
    alias_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(employee_id) ON DELETE CASCADE
  )
`);

// Migrate tasksheet_entries UNIQUE constraint to include date for multi-day recurring meeting support
try {
  const tableDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasksheet_entries'").get() as any;
  if (tableDef?.sql && tableDef.sql.includes("UNIQUE(meeting_id, employee_id)") && !tableDef.sql.includes("UNIQUE(meeting_id, employee_id, date)")) {
    console.log("[DB MIGRATION] Migrating tasksheet_entries to UNIQUE(meeting_id, employee_id, date)...");
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasksheet_entries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT NOT NULL,
        meeting_id INTEGER,
        project_id TEXT NOT NULL,
        date TEXT NOT NULL,
        task_category TEXT NOT NULL,
        task_details TEXT NOT NULL,
        effort_minutes INTEGER NOT NULL,
        comments TEXT DEFAULT 'Meeting',
        source TEXT DEFAULT 'MEETING_AUTOMATION',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(meeting_id, employee_id, date),
        FOREIGN KEY (employee_id) REFERENCES employees(employee_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id),
        FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO tasksheet_entries_new (id, employee_id, meeting_id, project_id, date, task_category, task_details, effort_minutes, comments, source, created_at, updated_at)
      SELECT id, employee_id, meeting_id, project_id, date, task_category, task_details, effort_minutes, comments, source, created_at, updated_at FROM tasksheet_entries;
      DROP TABLE tasksheet_entries;
      ALTER TABLE tasksheet_entries_new RENAME TO tasksheet_entries;
    `);
    db.pragma("foreign_keys = ON");
    console.log("[DB MIGRATION] tasksheet_entries migration complete.");
  }
} catch (migErr) {
  console.error("[DB MIGRATION] tasksheet_entries migration error:", migErr);
}

// Seed demo employees, projects, and initial tasksheet data
seedTasksheetDemoData(db);
ensureTranscriptTableExists(db);

// Initial external API sync (if configured)
if (getExternalSyncConfig().enabled) {
  void syncEmployeesFromExternal(db);
  void syncProjectsFromExternal(db);
}

// Background retry sweep for pending tasksheet syncs (every 60s)
setInterval(() => {
  if (getExternalSyncConfig().enabled) {
    void retryPendingTasksheetSyncs(db);
  }
}, 60000);

console.log("Meeting & Tasksheet database initialized.");

const CALENDAR_ID = "primary";
const OLD_RESOURCE_ID = "2NmE7bNaA6sidTe82KVU5pUeaX4";
const OLD_CHANNEL_IDS = [
  "whitecode-1787735539966",
  "whitecode-1787735547531",
  "whitecode-1787735552406",
  "whitecode-1787735610003",
  "whitecode-1787735801233",
  "whitecode-1787735814205",
];

// --------------------------------------------------
// Save meeting to database
// --------------------------------------------------

function saveMeeting(meeting: Meeting): boolean {
  const existing = db.prepare(`
    SELECT id, title, start_time, end_time, duration_minutes, participants, description
    FROM meetings
    WHERE google_event_id = ?
  `).get(meeting.eventId) as any;

  if (existing) {
    const participantsJson = JSON.stringify(meeting.participants);
    const hasChanged =
      existing.title !== meeting.title ||
      existing.start_time !== meeting.startTime ||
      existing.end_time !== meeting.endTime ||
      existing.duration_minutes !== meeting.durationMinutes ||
      existing.description !== meeting.description ||
      existing.participants !== participantsJson;

    if (hasChanged) {
      db.prepare(`
        UPDATE meetings
        SET title = ?,
            date = ?,
            start_time = ?,
            end_time = ?,
            start_timestamp = ?,
            end_timestamp = ?,
            duration_minutes = ?,
            meet_link = ?,
            organizer = ?,
            participants = ?,
            description = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        meeting.title,
        meeting.date,
        meeting.startTime,
        meeting.endTime,
        meeting.startTimestamp,
        meeting.endTimestamp,
        meeting.durationMinutes,
        meeting.meetLink,
        meeting.organizer,
        participantsJson,
        meeting.description,
        existing.id
      );
      console.log(`[CALENDAR SYNC] Updated existing meeting #${existing.id} ("${meeting.title}") with calendar changes.`);
      return true;
    }
    return false;
  }

  const result = db.prepare(`
    INSERT INTO meetings (
      google_event_id,
      title,
      date,
      start_time,
      end_time,
      start_timestamp,
      end_timestamp,
      duration_minutes,
      meet_link,
      organizer,
      participants,
      description,
      status,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    meeting.eventId,
    meeting.title,
    meeting.date,
    meeting.startTime,
    meeting.endTime,
    meeting.startTimestamp,
    meeting.endTimestamp,
    meeting.durationMinutes,
    meeting.meetLink,
    meeting.organizer,
    JSON.stringify(meeting.participants),
    meeting.description,
    "DETECTED"
  );

  console.log(`\n======================================================================`);
  console.log(`[STAGE 1: NEW MEETING SAVED TO DATABASE]`);
  console.log(` - Meeting ID: #${result.lastInsertRowid} ("${meeting.title}")`);
  console.log(` - Meet URL: ${meeting.meetLink || "N/A"}`);
  console.log(` - Scheduled Time: ${meeting.startTime || "N/A"} to ${meeting.endTime || "N/A"} (${meeting.durationMinutes || 0}m)`);
  console.log(` - Status: DETECTED (Saved in 'meetings' table)`);
  console.log(`======================================================================\n`);
  return true;
}

// --------------------------------------------------
// Process detected meetings
// --------------------------------------------------

async function processMeetings() {
  const meetings = await getMeetings();
  let newMeetings = 0;

  for (const meeting of meetings) {
    if (!meeting.eventId) {
      continue;
    }
    const saved = saveMeeting(meeting);
    if (saved) {
      newMeetings++;
    }
  }

  if (newMeetings > 0) {
    console.log(`[CALENDAR] New meetings detected and queued: ${newMeetings}`);
  }
  void processAllUnprocessedMeetings();
  return newMeetings;
}

// --------------------------------------------------
// Calendar Watch Helpers
// --------------------------------------------------

function getStoredWatch(calendarId: string): CalendarWatch | null {
  const watch = db.prepare(`
    SELECT
      id,
      channel_id AS channelId,
      resource_id AS resourceId,
      calendar_id AS calendarId,
      expiration,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM calendar_watch_channels
    WHERE calendar_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(calendarId) as CalendarWatch | undefined;

  return watch ?? null;
}

function isWatchActive(watch: CalendarWatch | null): boolean {
  if (!watch?.channelId || !watch.expiration) {
    return false;
  }

  const expiration = Number(watch.expiration);
  return Number.isFinite(expiration) && expiration > Date.now();
}

function logCalendarWatch(
  watch: CalendarWatch,
  status: "ACTIVE" | "EXPIRED"
): void {
  console.log(`
  ================================
  CALENDAR WATCH
  ================================

  Calendar: ${watch.calendarId}
  Channel ID: ${watch.channelId}
  Resource ID: ${watch.resourceId ?? "unknown"}
  Expiration: ${watch.expiration ?? "unknown"}
  Status: ${status}
  `);
}

function logCalendarWatchStatus(): void {
  const watch = getStoredWatch(CALENDAR_ID);
  console.log(`
================================
CALENDAR WATCH STATUS
================================
Channel ID: ${watch?.channelId ?? "none"}
Resource ID: ${watch?.resourceId ?? "none"}
Expiration: ${watch?.expiration ?? "none"}
Status: ${watch ? (isWatchActive(watch) ? "ACTIVE" : "EXPIRED") : "NONE"}
================================
`);
}

type StopWatchResult = "stopped" | "alreadyStoppedOrExpired" | "failed";

async function stopCalendarWatch(
  channelId: string,
  resourceId: string
): Promise<StopWatchResult> {
  if (!loadToken()) {
    throw new Error("Google Calendar is not connected.");
  }

  const calendar = google.calendar({
    version: "v3",
    auth: oauth2Client,
  });

  try {
    await calendar.channels.stop({
      requestBody: {
        id: channelId,
        resourceId,
      },
    });
    console.log(`Stopped old calendar watch:\n${channelId}`);
    return "stopped";
  } catch (error: any) {
    const status = error?.status || error?.code || error?.response?.status;
    const msg = String(error?.message || "").toLowerCase();

    if (
      status === 404 ||
      status === 410 ||
      status === 400 ||
      msg.includes("not found") ||
      msg.includes("expired") ||
      msg.includes("channel")
    ) {
      console.log(`Could not stop old calendar watch:\n${channelId}`);
      return "alreadyStoppedOrExpired";
    }

    console.log(`Could not stop old calendar watch:\n${channelId}`);
    return "failed";
  }
}

async function startCalendarWatch(): Promise<{
  watch: CalendarWatch;
  created: boolean;
}> {
  const existingWatch = getStoredWatch(CALENDAR_ID);

  if (existingWatch && isWatchActive(existingWatch)) {
    logCalendarWatch(existingWatch, "ACTIVE");
    console.log("Do not create another watch.");
    return { watch: existingWatch, created: false };
  }

  if (existingWatch) {
    logCalendarWatch(existingWatch, "EXPIRED");

    if (existingWatch.resourceId) {
      await stopCalendarWatch(
        existingWatch.channelId,
        existingWatch.resourceId
      );
    }
  }

  if (!loadToken()) {
    throw new Error("Google Calendar is not connected.");
  }

  const calendar = google.calendar({
    version: "v3",
    auth: oauth2Client,
  });

  const channelId = `whitecode-${Date.now()}`;

  const publicWebhookUrl = process.env.PUBLIC_WEBHOOK_URL?.replace(/\/+$/, "");

  if (!publicWebhookUrl) {
    throw new Error("PUBLIC_WEBHOOK_URL is not configured.");
  }

  const webhookUrl = `${publicWebhookUrl}/google/calendar/webhook`;

  const response = await calendar.events.watch({
    calendarId: CALENDAR_ID,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: webhookUrl,
    },
  });

  const watch: CalendarWatch = {
    id: existingWatch?.id ?? 0,
    channelId: response.data.id ?? channelId,
    resourceId: response.data.resourceId ?? null,
    calendarId: CALENDAR_ID,
    expiration: response.data.expiration ?? null,
    createdAt: null,
    updatedAt: null,
  };

  if (existingWatch) {
    db.prepare(`
      UPDATE calendar_watch_channels
      SET channel_id = ?, resource_id = ?, expiration = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      watch.channelId,
      watch.resourceId,
      watch.expiration,
      existingWatch.id
    );
    watch.createdAt = existingWatch.createdAt;
  } else {
    const result = db.prepare(`
      INSERT INTO calendar_watch_channels (
        channel_id, resource_id, calendar_id, expiration
      )
      VALUES (?, ?, ?, ?)
    `).run(
      watch.channelId,
      watch.resourceId,
      watch.calendarId,
      watch.expiration
    );
    watch.id = Number(result.lastInsertRowid);
  }

  const storedWatch = getStoredWatch(CALENDAR_ID) ?? watch;
  logCalendarWatch(storedWatch, "ACTIVE");

  console.log("\n================================");
  console.log("GOOGLE CALENDAR WATCH STARTED");
  console.log("================================");
  console.log("Channel ID:", response.data.id);
  console.log("Resource ID:", response.data.resourceId);
  console.log("Expiration:", response.data.expiration);
  console.log("Webhook:", webhookUrl);
  console.log("================================\n");

  return { watch: storedWatch, created: true };
}

logCalendarWatchStatus();

// --------------------------------------------------
// Home page & Navigation
// --------------------------------------------------

app.get("/", (_req: Request, res: Response) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  if (fs.existsSync(TOKEN_PATH)) {
    let missingMeetScope = false;
    try {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
      missingMeetScope = !String(tokens.scope || "").includes("meetings");
    } catch {}

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>WhiteCode AI Meet Automation</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 40px; background-color: #f8f9fa; }
            h1 { color: #1a73e8; }
            .btn { padding: 12px 20px; font-size: 15px; font-weight: bold; color: white; background-color: #1a73e8; border: none; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; margin-right: 10px; margin-bottom: 10px; }
            .btn-secondary { background-color: #3c4043; }
            .btn-success { background-color: #1e8e3e; }
            .btn-warning { background-color: #d93025; }
            .card { background: white; padding: 24px; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.1); margin-top: 20px; }
            .alert-warning { background: #fce8e6; color: #c5221f; padding: 16px; border-radius: 6px; margin-bottom: 16px; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>WhiteCode AI Meeting → Employee Tasksheet Automation</h1>
          ${missingMeetScope ? `
            <div class="alert-warning">
              ⚠️ ATTENTION REQUIRED: Your saved Google token is missing Google Meet API permissions.<br>
              Click below to grant Google Meet permissions so live participant logs can be read.
            </div>
            <a href="${authUrl}" class="btn btn-warning">🔐 Grant Google Meet Permissions</a>
          ` : `<p>Google Calendar, Meet API & Google Gemini AI connected ✅</p>`}
          
          <div class="card">
            <h3>Quick Actions</h3>
            <a href="/tasksheets" class="btn btn-success">📋 View Employee Tasksheets</a>
            <a href="/meetings" class="btn">📅 Sync Calendar Meetings</a>
            <a href="/stored-meetings" class="btn btn-secondary">🗄️ View Stored Meetings</a>
            <a href="${authUrl}" class="btn btn-secondary">🔄 Re-connect Google Account</a>
          </div>
        </body>
      </html>
    `);
    return;
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>WhiteCode AI Meet Automation</title>
      </head>
      <body style="font-family: Arial; padding: 40px;">
        <h1>WhiteCode AI Meeting Automation</h1>
        <p>Connect your Google Calendar & Meet permissions to get started.</p>
        <a href="${authUrl}">
          <button style="padding: 12px 20px; font-size: 16px; cursor: pointer; background-color: #1a73e8; color: white; border: none; border-radius: 4px;">
            Connect Google Services
          </button>
        </a>
      </body>
    </html>
  `);
});

// --------------------------------------------------
// Google OAuth Callback
// --------------------------------------------------

app.get("/oauth2callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing OAuth code parameter.");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    console.log("OAuth tokens saved to token.json successfully.");
    await startCalendarWatch();

    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authentication Successful</title></head>
        <body style="font-family: Arial; padding: 40px;">
          <h2>Google Authentication Successful! ✅</h2>
          <p>Google Calendar and Meet API credentials connected.</p>
          <a href="/tasksheets"><button style="padding: 10px 16px; cursor: pointer;">Go to Employee Tasksheets</button></a>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error("OAuth exchange error:", error);
    res.status(500).send(`OAuth authorization error: ${error?.message || "Unknown error"}`);
  }
});

// --------------------------------------------------
// Google Calendar Webhook
// --------------------------------------------------

export async function renewExpiredWatchChannels(authClient: any = oauth2Client): Promise<{ renewedCount: number }> {
  if (!loadToken()) {
    return { renewedCount: 0 };
  }

  const TEN_MINS_MS = 10 * 60 * 1000;
  const nowMs = Date.now();

  const watches = db.prepare(`
    SELECT id, channel_id AS channelId, resource_id AS resourceId, calendar_id AS calendarId, expiration
    FROM calendar_watch_channels
  `).all() as any[];

  let renewedCount = 0;

  for (const w of watches) {
    const expMs = Number(w.expiration);
    const isExpiringSoon = !expMs || isNaN(expMs) || (expMs - nowMs) <= TEN_MINS_MS;

    if (isExpiringSoon) {
      console.log(`[WATCH] Renewing expired or expiring watch channel (ID: ${w.channelId})...`);
      try {
        const result = await startCalendarWatch();
        if (result.created) {
          renewedCount++;
        }
      } catch (err: any) {
        console.error(`[WATCH] Failed to renew watch channel ${w.channelId}:`, err?.message || err);
      }
    }
  }

  return { renewedCount };
}

app.post("/google/calendar/webhook", async (req: Request, res: Response) => {
  const channelId = req.headers["x-goog-channel-id"];
  const resourceId = req.headers["x-goog-resource-id"];

  if (typeof channelId !== "string" || typeof resourceId !== "string") {
    res.status(400).send("Missing x-goog-channel-id or x-goog-resource-id header.");
    return;
  }

  const knownWatch = db.prepare(`
    SELECT id
    FROM calendar_watch_channels
    WHERE channel_id = ? AND resource_id = ?
  `).get(channelId, resourceId);

  if (!knownWatch) {
    console.warn(`[WEBHOOK] Unauthorized notification attempt (Channel ID: ${channelId}, Resource ID: ${resourceId})`);
    res.status(401).send("Unauthorized channel ID or resource ID.");
    return;
  }

  console.log(`[WEBHOOK] Notification verified for channel ${channelId}`);
  res.status(200).send("OK");

  void processMeetings()
    .then((newMeetings) => {
      console.log(`Calendar webhook processing completed. New meetings: ${newMeetings}`);
    })
    .catch((error: unknown) => {
      console.error("Calendar processing error:", error);
    });
});

// --------------------------------------------------
// Helper: Load saved token
// --------------------------------------------------

function loadToken(): boolean {
  if (!fs.existsSync(TOKEN_PATH)) {
    return false;
  }

  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    const scopeStr = String(tokens.scope || "");
    if (!scopeStr.includes("meetings")) {
      console.warn("\n=======================================================================");
      console.warn("⚠️  OAUTH SCOPE NOTICE: Your token.json is missing Google Meet scopes.");
      console.warn("Visit http://localhost:3000/ to grant Google Meet API permissions!");
      console.warn("=======================================================================\n");
    }
    oauth2Client.setCredentials(tokens);
    return true;
  } catch (error: any) {
    const isInvalidGrant = String(error?.message || "").includes("invalid_grant");
    if (isInvalidGrant) {
      console.warn("\n=======================================================================");
      console.warn("⚠️  GOOGLE OAUTH TOKEN EXPIRED (invalid_grant)");
      console.warn("Please visit http://localhost:3000/ in your browser to re-connect Google.");
      console.warn("=======================================================================\n");
      try { fs.unlinkSync(TOKEN_PATH); } catch {}
    } else {
      console.error("Could not read token.json:", error);
    }
    return false;
  }
}

// --------------------------------------------------
// Helper: Find Google Meet link
// --------------------------------------------------

function getMeetLink(event: calendar_v3.Schema$Event): string | null {
  if (event.hangoutLink) {
    return event.hangoutLink;
  }
  const videoEntry = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === "video"
  );
  return videoEntry?.uri || null;
}

// --------------------------------------------------
// Helper: Get Google Calendar meetings
// --------------------------------------------------

async function getMeetings(): Promise<Meeting[]> {
  if (!loadToken()) {
    throw new Error("Google Calendar is not connected. Visit http://localhost:3000/");
  }

  const calendar = google.calendar({
    version: "v3",
    auth: oauth2Client,
  });

  const now = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const meetings: Meeting[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const response: any = await calendar.events.list({
      calendarId: "primary",
      timeMin: now,
      maxResults: 100,
      singleEvents: true,
      orderBy: "startTime",
      pageToken,
    });

    const events = response.data?.items || [];

    for (const event of events) {
      const eventId = event.id;
      if (!eventId) continue;

      // Handle cancelled or deleted calendar events
      if (event.status === "cancelled") {
        const existingMeeting = db.prepare("SELECT id FROM meetings WHERE google_event_id = ?").get(eventId) as any;
        if (existingMeeting) {
          db.prepare("UPDATE meetings SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingMeeting.id);
          console.log(`[CALENDAR SYNC] Meeting #${existingMeeting.id} cancelled in Google Calendar. Marked as CANCELLED.`);
        }
        continue;
      }

      const meetLink = getMeetLink(event);
      if (!meetLink) continue;

      const isAllDay = Boolean(event.start?.date);
      if (isAllDay) continue;

      const start = event.start?.dateTime || event.start?.date;
      const end = event.end?.dateTime || event.end?.date;
      if (!start || !end) continue;

      const startTimestamp = new Date(start).toISOString();
      const endTimestamp = new Date(end).toISOString();
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      const durationMinutes = Math.max(0, Math.round((endMs - startMs) / 60000));

      const participants = (event.attendees || [])
        .map((attendee: { email?: string | null }) => attendee.email)
        .filter((email: any): email is string => Boolean(email));

      meetings.push({
        eventId,
        title: event.summary || "Untitled Meeting",
        date: new Date(start).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
        startTime: startTimestamp,
        endTime: endTimestamp,
        startTimestamp,
        endTimestamp,
        durationMinutes,
        meetLink,
        organizer: event.organizer?.email || null,
        participants,
        description: event.description || null,
      });
    }

    pageToken = response.data?.nextPageToken || undefined;
  } while (pageToken);

  return meetings;
}

// --------------------------------------------------
// Core Meeting Processing Workflow Function
// --------------------------------------------------

export async function processMeetingRecord(
  meeting: any,
  options: { silent?: boolean; forceReclassify?: boolean } = {}
): Promise<any> {
  const silent = options.silent ?? false;
  const forceReclassify = options.forceReclassify ?? false;

  if (!silent) {
    console.log(`\n======================================================================`);
    console.log(`[PROCESS] Processing Meeting ID: ${meeting.id} - "${meeting.title}"`);
    console.log(`======================================================================`);
    console.log(`[STEP 1: CALENDAR DATA EXTRACTED]`);
    console.log(` - Title: "${meeting.title}"`);
    console.log(` - Scheduled Time: ${meeting.start_time || "N/A"} to ${meeting.end_time || "N/A"} (${meeting.duration_minutes || 0} mins)`);
    console.log(` - Meet Link: ${meeting.meet_link || "N/A"}`);
  }

  // Update meeting status to PROCESSING
  db.prepare("UPDATE meetings SET status = 'PROCESSING', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(meeting.id);

  // Parse Calendar / Detected Attendees cleanly (supporting both email addresses and display names)
  const calendarAttendeeRaw: string[] = JSON.parse(meeting.participants || "[]");
  const calendarAttendees = calendarAttendeeRaw.map((item: string) => {
    const isEmail = item.includes("@");
    return {
      email: isEmail ? item.trim() : null,
      displayName: isEmail ? item.split("@")[0].trim() : item.trim(),
    };
  });

  // Also query distinct non-generic speakers from meeting_transcripts if available
  const meetingCodeForSpeakers = extractMeetingCode(meeting.meet_link);
  if (meetingCodeForSpeakers) {
    try {
      const distinctRows = db.prepare(`
        SELECT DISTINCT speaker FROM meeting_transcripts
        WHERE meeting_code = ? OR meeting_code = ?
      `).all(meetingCodeForSpeakers, meetingCodeForSpeakers.replace(/-/g, "")) as Array<{ speaker: string }>;

      for (const row of distinctRows) {
        const spk = (row.speaker || "").trim();
        if (spk && !["participant", "meeting participant", "you", "unknown", "speaker"].includes(spk.toLowerCase())) {
          const isEmail = spk.includes("@");
          const already = calendarAttendees.some((a) =>
            (a.email && a.email.toLowerCase() === spk.toLowerCase()) ||
            (a.displayName && a.displayName.toLowerCase() === (isEmail ? spk.split("@")[0].trim().toLowerCase() : spk.toLowerCase()))
          );
          if (!already) {
            calendarAttendees.push({
              email: isEmail ? spk.trim() : null,
              displayName: isEmail ? spk.split("@")[0].trim() : spk.trim(),
            });
          }
        }
      }
    } catch (err) {
      console.warn("[PROCESS] Could not query transcript speakers:", err);
    }
  }

  // STEP 2 & STEP 3: Retrieve actual Meet participants and sessions
  let actualParticipants: MeetingParticipant[] = [];
  let confRecordId: string | null = null;
  let isConferenceEnded = false;

  // Demo fixtures are authoritative and must not be replaced by a recent live conference fallback.
  if (meeting.demo_participants_json) {
    try {
      actualParticipants = JSON.parse(meeting.demo_participants_json);
      if (!silent) console.log(`[MEET] Using pre-seeded actual participant session data for meeting.`);
    } catch (err) {
      console.error("Error parsing demo participants JSON:", err);
    }
  } else if (loadToken()) {
    const result = await getActualMeetParticipants(
      oauth2Client,
      meeting.meet_link,
      calendarAttendees,
      silent
    );
    confRecordId = result.conferenceRecordId;
    actualParticipants = result.participants;
    isConferenceEnded = result.isEnded;
  }

  const nowMs = Date.now();
  const storedEndTimestamp = meeting.end_timestamp
    || (meeting.date && meeting.end_time ? `${meeting.date} ${meeting.end_time}` : null);
  const endMs = storedEndTimestamp ? new Date(storedEndTimestamp).getTime() : 0;
  const isScheduledTimePast = (!isNaN(endMs) && endMs > 0 && nowMs >= endMs);
  const isMeetingCompleted = isConferenceEnded || isScheduledTimePast || !!meeting.demo_participants_json || forceReclassify;

  // Fallback for Consumer (@gmail.com) or External domain meetings:
  // If conference records were unavailable/empty, but meeting has ended and calendar attendees exist:
  const fallbackDuration = (meeting.duration_minutes && meeting.duration_minutes > 0) ? meeting.duration_minutes : 30;
  if (actualParticipants.length === 0 && isMeetingCompleted && calendarAttendees.length > 0 && !meeting.demo_participants_json) {
    if (!silent) console.log(`[MEET FALLBACK] No live Google Meet conference records found (consumer or external domain call). Falling back to ${calendarAttendees.length} calendar attendees for review.`);
    actualParticipants = calendarAttendees.map((att) => ({
      participantId: `cal-${att.email || att.displayName}`,
      email: att.email || null,
      displayName: att.displayName || null,
      joinedAt: meeting.start_timestamp || new Date(Date.now() - fallbackDuration * 60000).toISOString(),
      leftAt: meeting.end_timestamp || new Date().toISOString(),
      durationMinutes: fallbackDuration,
      sessions: [{
        joinedAt: meeting.start_timestamp || new Date(Date.now() - fallbackDuration * 60000).toISOString(),
        leftAt: meeting.end_timestamp || new Date().toISOString(),
        durationMinutes: fallbackDuration,
      }],
      isStillInCall: false,
    }));
  } else if (actualParticipants.length === 0 && isMeetingCompleted) {
    console.log("[MEET] Meeting has ended but no actual participant records were returned.");
  }

  if (!silent) {
    console.log(`\n[STEP 2: GOOGLE MEET PARTICIPANT SESSION CHECK]`);
    if (confRecordId) {
      console.log(` - Conference Record Found: ${confRecordId} (Call Ended: ${isConferenceEnded})`);
    } else {
      console.log(` - Conference Record Status: ${actualParticipants.length > 0 ? "Participants Detected" : "No active session record yet"}`);
    }
    console.log(` - Actual Attending Participants Found: ${actualParticipants.length}`);
  }

  // Filter participants who have completed sessions (have left the call with > 0 mins)
  const completedParticipants = actualParticipants.filter(p => p.durationMinutes > 0);

  if (completedParticipants.length === 0 && !isMeetingCompleted) {
    if (!silent) console.log(` - Result: Meeting #${meeting.id} has no completed exit sessions yet. Holding tasksheet creation until employee leaves call.`);
    db.prepare("UPDATE meetings SET status = 'DETECTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(meeting.id);
    return {
      meetingId: meeting.id,
      googleEventId: meeting.google_event_id,
      title: meeting.title,
      project: null,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      durationMinutes: meeting.duration_minutes,
      participants: [],
      tasksheetEntriesCreated: 0,
      status: "DETECTED",
    };
  }

  // Clear previous participant records for duplicate processing protection
  db.prepare(`DELETE FROM meeting_participants WHERE meeting_id = ?`).run(meeting.id);

  // Save actual participants & sessions to DB
  const insertPartStmt = db.prepare(`
    INSERT INTO meeting_participants (
      meeting_id, participant_id, employee_email, display_name, total_duration_minutes
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const insertSessStmt = db.prepare(`
    INSERT INTO meeting_participant_sessions (
      meeting_participant_id, joined_at, left_at, duration_minutes
    ) VALUES (?, ?, ?, ?)
  `);

  const savedParticipants: Array<{
    email: string | null;
    displayName: string | null;
    durationMinutes: number;
    joinedAt?: string | null;
    leftAt?: string | null;
    sessions?: any[];
    isStillInCall?: boolean;
  }> = [];

  for (const p of actualParticipants) {
    const partResult = insertPartStmt.run(
      meeting.id,
      p.participantId,
      p.email,
      p.displayName,
      p.durationMinutes
    );
    const meetingParticipantId = Number(partResult.lastInsertRowid);

    for (const s of p.sessions) {
      insertSessStmt.run(
        meetingParticipantId,
        s.joinedAt,
        s.leftAt,
        s.durationMinutes
      );
    }

    if (!silent) console.log(` - Attending Employee Identified: ${p.displayName || p.email || "Unknown"} -> ${p.durationMinutes} mins`);
    savedParticipants.push({
      email: p.email,
      displayName: p.displayName,
      durationMinutes: p.durationMinutes,
      joinedAt: p.joinedAt,
      leftAt: p.leftAt,
      sessions: p.sessions,
      isStillInCall: p.isStillInCall,
    });
  }

  // STEP 3: Google Gemini AI Classification & Multilingual Topic Extraction
  let aiClassification: AIClassificationResult;

  const meetingCode = extractMeetingCode(meeting.meet_link);
  const existingTranscript = meeting.transcript || (meetingCode ? getMeetingTranscript(db, meetingCode) : "");

  // If forceReclassify is true OR if there is an active discussion transcript to extract topics from:
  const canUseCachedClassification = !forceReclassify && !existingTranscript && meeting.project_id && meeting.project_name;

  if (canUseCachedClassification) {
    if (!silent) console.log(`\n[STEP 3: AI PROJECT CLASSIFICATION (CACHED)]`);
    aiClassification = {
      projectId: meeting.project_id,
      projectName: meeting.project_name,
      taskCategory: "Meeting",
      taskDetails: meeting.description
        ? `Attended project meeting to discuss ${meeting.description.toLowerCase().replace(/\.$/, "")}.`
        : `Attended project meeting for ${meeting.project_name}.`,
      confidence: meeting.project_confidence ?? 0.95,
      reason: meeting.project_reason || "Re-used existing cached project classification",
      isNewProject: false,
    };
  } else {
    if (!silent) console.log(`\n[STEP 3: AI PROJECT CLASSIFICATION & DISCUSSION TOPIC EXTRACTION]`);
    const dbProjects = db.prepare("SELECT project_id as projectId, project_name as projectName, description FROM projects").all() as any[];
    const availableProjectsInfo = dbProjects.map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName,
      description: p.description,
      keywords: [p.projectName, p.projectId],
    }));

    aiClassification = await classifyMeetingWithAI(
      {
        title: meeting.title,
        description: meeting.description,
        transcript: existingTranscript || null,
      },
      availableProjectsInfo
    );
  }

  if (!silent) {
    console.log(` - Classified Project: "${aiClassification.projectName}" (${aiClassification.projectId})`);
    console.log(` - AI Confidence Score: ${aiClassification.confidence}`);
  }

  // Merge AI-discovered active participants from transcript & speaker tags
  if (aiClassification.activeParticipants && Array.isArray(aiClassification.activeParticipants)) {
    for (const rawName of aiClassification.activeParticipants) {
      const name = (rawName || "").trim();
      if (!name || ["participant", "meeting participant", "you", "unknown", "speaker"].includes(name.toLowerCase())) {
        continue;
      }

      // Resolve employee in database (handles first names like Monika, Vedant, Suraj or full names)
      const matchedEmp = findBestMatchingEmployee(db, name.includes("@") ? name : null, name);
      const displayName = matchedEmp ? matchedEmp.name : name;
      const email = matchedEmp ? matchedEmp.email : (name.includes("@") ? name : null);

      // Check if already in savedParticipants
      const alreadySaved = savedParticipants.some((p) => {
        if (matchedEmp) {
          const empMatch = findBestMatchingEmployee(db, p.email, p.displayName);
          if (empMatch && empMatch.employee_id === matchedEmp.employee_id) return true;
        }
        if (email && p.email && email.toLowerCase() === p.email.toLowerCase()) return true;
        if (displayName && p.displayName && displayName.toLowerCase() === p.displayName.toLowerCase()) return true;
        return false;
      });

      if (!alreadySaved) {
        if (!silent) {
          console.log(`[AI PARTICIPANT DISCOVERY] Identified active participant from transcript: ${displayName} (${matchedEmp?.employee_id || "External"})`);
        }
        const duration = (meeting.duration_minutes && meeting.duration_minutes > 0) ? meeting.duration_minutes : 30;
        const joinedAt = meeting.start_timestamp || new Date(Date.now() - duration * 60000).toISOString();
        const leftAt = meeting.end_timestamp || new Date().toISOString();

        // Insert into meeting_participants and meeting_participant_sessions DB
        const partResult = insertPartStmt.run(
          meeting.id,
          `ai-${matchedEmp?.employee_id || displayName.replace(/\s+/g, "_")}`,
          email,
          displayName,
          duration
        );
        const meetingParticipantId = Number(partResult.lastInsertRowid);
        insertSessStmt.run(
          meetingParticipantId,
          joinedAt,
          leftAt,
          duration
        );

        savedParticipants.push({
          email,
          displayName,
          durationMinutes: duration,
          joinedAt,
          leftAt,
          sessions: [{
            joinedAt,
            leftAt,
            durationMinutes: duration,
          }],
          isStillInCall: false,
        });
      }
    }

    // Keep meetings.participants column updated in SQLite
    try {
      const currentList: string[] = [];
      for (const sp of savedParticipants) {
        const idStr = sp.email || sp.displayName;
        if (idStr && !currentList.some((item) => item.toLowerCase() === idStr.toLowerCase())) {
          currentList.push(idStr);
        }
      }
      db.prepare("UPDATE meetings SET participants = ? WHERE id = ?").run(JSON.stringify(currentList), meeting.id);
      meeting.participants = JSON.stringify(currentList);
    } catch (updateErr) {
      console.warn("[PROCESS] Could not sync updated participants to meetings table:", updateErr);
    }
  }

  // STEP 4: Employee Project Validation & Individual Tasksheet Updates
  if (!silent) console.log(`\n[STEP 4: EMPLOYEE TASKSHEET UPDATES]`);
  const tasksheetResult = validateAndCreateTasksheetEntries(
    db,
    meeting,
    savedParticipants,
    aiClassification
  );

  // Check if any participants are STILL in the call
  const hasActiveParticipantsInCall = savedParticipants.some(p => Boolean(p.isStillInCall || !p.leftAt));

  // Determine final meeting status:
  // 1. If ANY participant is still active in call OR call has not ended:
  //    Keep in DETECTED status so background poller continues checking until EVERYONE leaves!
  // 2. Only mark PROCESSED when all participants have left and call is ended!
  let finalStatus = "DETECTED";

  if (hasActiveParticipantsInCall || (!isConferenceEnded && !isScheduledTimePast)) {
    finalStatus = "DETECTED";
    if (!silent) {
      console.log(`[STATUS] Meeting #${meeting.id} is STILL ACTIVE (participants are currently in the call).`);
      console.log(` - Remaining in DETECTED status so remaining participants are tracked when they leave.`);
    }
  } else if (tasksheetResult.createdCount > 0) {
    finalStatus = tasksheetResult.status;
  } else if (tasksheetResult.status === "REVIEW_REQUIRED") {
    finalStatus = "REVIEW_REQUIRED";
  } else if (isMeetingCompleted) {
    finalStatus = "NO_PARTICIPANTS";
  }

  // Update meeting status and project columns
  db.prepare(`
    UPDATE meetings
    SET status = ?,
        project_id = ?,
        project_name = ?,
        project_confidence = ?,
        project_reason = ?,
        conference_record_id = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    finalStatus,
    aiClassification.projectId,
    aiClassification.projectName,
    aiClassification.confidence,
    aiClassification.reason,
    confRecordId,
    meeting.id
  );

  if (!silent || tasksheetResult.createdCount > 0) {
    console.log(`\n======================================================================`);
    console.log(`[STAGE 2 & STAGE 3: PARTICIPANTS RECORDED & AI TASKSHEET UPDATED]`);
    console.log(`======================================================================`);
    console.log(`[STAGE 1 DATA: MEETING DATABASE RECORD]`);
    console.log(` - Meeting ID: #${meeting.id} ("${meeting.title}")`);
    console.log(` - Scheduled Time: ${meeting.start_time || "N/A"} to ${meeting.end_time || "N/A"} (${meeting.duration_minutes || 0}m)`);
    console.log(` - Meet Link: ${meeting.meet_link || "N/A"}`);
    console.log(`\n[STAGE 2 DATA: PARTICIPANTS RECORDED TO 'meeting_participants']`);
    if (confRecordId) {
      console.log(` - Google Meet Conference Record: ${confRecordId}`);
    }
    for (const p of savedParticipants) {
      console.log(` - Attending Employee: ${p.displayName || p.email || "Unknown"} -> ${p.durationMinutes} mins`);
    }
    console.log(`\n[STAGE 3 DATA: AI CLASSIFIED & EMPLOYEE TASKSHEET UPDATED]`);
    console.log(` - Classified Project: "${aiClassification.projectName}" (${aiClassification.projectId})`);
    console.log(` - AI Confidence Score: ${aiClassification.confidence}`);
    console.log(` - Tasksheet Entries Written: ${tasksheetResult.createdCount} entry/entries into employee tasksheet(s)!`);
    console.log(`======================================================================`);
    console.log(`[SUMMARY] Meeting #${meeting.id} Complete | Status: ${finalStatus} | Tasksheet Entries: ${tasksheetResult.createdCount}`);
    console.log(`======================================================================\n`);
  }

  return {
    meetingId: meeting.id,
    googleEventId: meeting.google_event_id,
    title: meeting.title,
    project: {
      projectId: aiClassification.projectId,
      projectName: aiClassification.projectName,
      confidence: aiClassification.confidence,
      reason: aiClassification.reason,
      taskDetails: aiClassification.taskDetails,
      topicsDiscussed: aiClassification.topicsDiscussed || [],
    },
    startTime: meeting.start_time,
    endTime: meeting.end_time,
    durationMinutes: meeting.duration_minutes,
    participants: tasksheetResult.processedParticipants,
    tasksheetEntriesCreated: tasksheetResult.createdCount,
    status: finalStatus,
  };
}

async function processAllUnprocessedMeetings() {
  // Query DETECTED/FAILED meetings that have not been checked in the last 5 seconds
  const unprocessed = db.prepare(`
    SELECT * FROM meetings 
    WHERE (status = 'DETECTED' OR status = 'FAILED')
      AND (updated_at IS NULL OR (strftime('%s', 'now') - strftime('%s', updated_at)) >= 5)
    ORDER BY id ASC
  `).all() as any[];

  if (unprocessed.length > 0) {
    const nowMs = Date.now();
    const FIVE_MINS_MS = 5 * 60 * 1000;

    for (const m of unprocessed) {
      // Do not poll Google Meet API for meetings scheduled in the future (> 5 mins from now)
      if (m.start_timestamp) {
        const startMs = new Date(m.start_timestamp).getTime();
        if (!isNaN(startMs) && startMs > (nowMs + FIVE_MINS_MS)) {
          continue;
        }
      }

      await processMeetingRecord(m, { silent: true }).catch((err) =>
        {
          console.error(`Auto-process error for meeting ${m.id}:`, err);
          db.prepare("UPDATE meetings SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(m.id);
        }
      );
    }
  }
}

// Active Background Polling Loop: Check live pending meetings every 5 seconds
setInterval(() => {
  void processAllUnprocessedMeetings();
}, 5000);

// --------------------------------------------------
// Meeting Query Endpoints
// --------------------------------------------------

// GET /meetings
app.get("/meetings", async (_req: Request, res: Response) => {
  try {
    const meetings = await getMeetings();
    for (const meeting of meetings) {
      if (meeting.eventId) {
        saveMeeting(meeting);
      }
    }

    console.log("\n================================");
    console.log("GOOGLE MEET MEETINGS");
    console.log("================================\n");

    res.json({
      success: true,
      totalMeetings: meetings.length,
      meetings,
    });
  } catch (error) {
    console.error("Meeting extraction error:", error);
    res.status(500).json({
      success: false,
      message: "Could not retrieve Google Meet meetings.",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// GET /stored-meetings
app.get("/stored-meetings", (_req: Request, res: Response) => {
  const meetings = db.prepare(`
    SELECT *
    FROM meetings
    ORDER BY created_at DESC
  `).all();

  res.json({
    success: true,
    totalMeetings: meetings.length,
    meetings,
  });
});

// GET /meetings/:id
app.get("/meetings/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  
  let meeting: any = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id);
  if (!meeting) {
    meeting = db.prepare(`SELECT * FROM meetings WHERE google_event_id = ?`).get(id);
  }

  if (!meeting) {
    res.status(404).json({ success: false, message: `Meeting with ID '${id}' not found.` });
    return;
  }

  const participants = db.prepare(`
    SELECT 
      mp.id,
      mp.participant_id AS participantId,
      mp.employee_email AS email,
      mp.display_name AS displayName,
      mp.total_duration_minutes AS durationMinutes
    FROM meeting_participants mp
    WHERE mp.meeting_id = ?
  `).all(meeting.id);

  for (const p of participants as any[]) {
    p.sessions = db.prepare(`
      SELECT joined_at AS joinedAt, left_at AS leftAt, duration_minutes AS durationMinutes
      FROM meeting_participant_sessions
      WHERE meeting_participant_id = ?
      ORDER BY id ASC
    `).all(p.id);
  }

  res.json({
    success: true,
    meeting: {
      id: meeting.id,
      googleEventId: meeting.google_event_id,
      title: meeting.title,
      date: meeting.date,
      startTime: meeting.start_time,
      endTime: meeting.end_time,
      durationMinutes: meeting.duration_minutes,
      meetLink: meeting.meet_link,
      organizer: meeting.organizer,
      calendarAttendees: JSON.parse(meeting.participants || "[]"),
      description: meeting.description,
      status: meeting.status,
      project: meeting.project_id
        ? {
            projectId: meeting.project_id,
            projectName: meeting.project_name,
            confidence: meeting.project_confidence,
            reason: meeting.project_reason,
          }
        : null,
      actualParticipants: participants,
    },
  });
});

// GET /meetings/:id/participants
app.get("/meetings/:id/participants", (req: Request, res: Response) => {
  const { id } = req.params;

  let meeting: any = db.prepare(`SELECT id FROM meetings WHERE id = ?`).get(id);
  if (!meeting) {
    meeting = db.prepare(`SELECT id FROM meetings WHERE google_event_id = ?`).get(id);
  }

  if (!meeting) {
    res.status(404).json({ success: false, message: `Meeting with ID '${id}' not found.` });
    return;
  }

  const participants = db.prepare(`
    SELECT 
      mp.id,
      mp.participant_id AS participantId,
      mp.employee_email AS email,
      mp.display_name AS displayName,
      mp.total_duration_minutes AS durationMinutes
    FROM meeting_participants mp
    WHERE mp.meeting_id = ?
  `).all(meeting.id);

  res.json({
    success: true,
    meetingId: meeting.id,
    totalParticipants: participants.length,
    participants,
  });
});

// GET /meetings/:id/project
app.get("/meetings/:id/project", async (req: Request, res: Response) => {
  const { id } = req.params;

  let meeting: any = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id);
  if (!meeting) {
    meeting = db.prepare(`SELECT * FROM meetings WHERE google_event_id = ?`).get(id);
  }

  if (!meeting) {
    res.status(404).json({ success: false, message: `Meeting with ID '${id}' not found.` });
    return;
  }

  if (meeting.project_id) {
    res.json({
      success: true,
      meetingId: meeting.id,
      project: {
        projectId: meeting.project_id,
        projectName: meeting.project_name,
        confidence: meeting.project_confidence,
        reason: meeting.project_reason,
      },
    });
    return;
  }

  const dbProjects = db.prepare("SELECT project_id as projectId, project_name as projectName, description FROM projects").all() as any[];
  const availableProjectsInfo = dbProjects.map((p) => ({
    projectId: p.projectId,
    projectName: p.projectName,
    description: p.description,
    keywords: [p.projectName, p.projectId],
  }));

  const identification = await classifyMeetingWithAI(
    { title: meeting.title, description: meeting.description },
    availableProjectsInfo
  );

  res.json({
    success: true,
    meetingId: meeting.id,
    project: identification,
  });
});

// --------------------------------------------------
// Employee & Tasksheet API Endpoints
// --------------------------------------------------

// GET /employees
app.get("/employees", (_req: Request, res: Response) => {
  const employees = db.prepare("SELECT employee_id AS employeeId, name, email, active FROM employees ORDER BY employee_id ASC").all();
  res.json({
    success: true,
    totalEmployees: employees.length,
    employees,
  });
});

// GET /employees/:id/tasksheet
app.get("/employees/:id/tasksheet", (req: Request, res: Response) => {
  const paramId = String(req.params.id);

  let employee = db.prepare("SELECT * FROM employees WHERE employee_id = ?").get(paramId) as any;
  if (!employee) {
    employee = db.prepare("SELECT * FROM employees WHERE LOWER(name) = ? OR LOWER(email) = ?").get(paramId.toLowerCase(), paramId.toLowerCase()) as any;
  }

  if (!employee) {
    res.status(404).json({ success: false, message: `Employee '${paramId}' not found.` });
    return;
  }

  const entries = db.prepare(`
    SELECT 
      t.id,
      t.employee_id AS employeeId,
      t.meeting_id AS meetingId,
      t.project_id AS projectId,
      p.project_name AS projectName,
      t.date,
      t.task_category AS taskCategory,
      t.task_details AS taskDetails,
      t.effort_minutes AS effortMinutes,
      t.comments,
      t.source,
      t.sync_status AS syncStatus,
      t.external_entry_id AS externalEntryId,
      t.synced_at AS syncedAt
    FROM tasksheet_entries t
    JOIN projects p ON t.project_id = p.project_id
    WHERE t.employee_id = ?
    ORDER BY t.id DESC
  `).all(employee.employee_id) as any[];

  const formattedEntries = entries.map((entry) => ({
    ...entry,
    totalEfforts: formatMinutesToEffortString(entry.effortMinutes),
  }));

  res.json({
    success: true,
    employee: {
      employeeId: employee.employee_id,
      name: employee.name,
      email: employee.email,
    },
    totalEntries: formattedEntries.length,
    tasksheet: formattedEntries,
  });
});

// GET /projects
app.get("/projects", (_req: Request, res: Response) => {
  const projects = db.prepare("SELECT project_id AS projectId, project_name AS projectName, description, active FROM projects").all();
  res.json({
    success: true,
    totalProjects: projects.length,
    projects,
  });
});

// GET /projects/:id/tasks
app.get("/projects/:id/tasks", (req: Request, res: Response) => {
  const paramId = String(req.params.id);

  let project = db.prepare("SELECT * FROM projects WHERE project_id = ?").get(paramId) as any;
  if (!project) {
    project = db.prepare("SELECT * FROM projects WHERE LOWER(project_name) LIKE ?").get(`%${paramId.toLowerCase()}%`) as any;
  }

  if (!project) {
    res.status(404).json({ success: false, message: `Project '${paramId}' not found.` });
    return;
  }

  const entries = db.prepare(`
    SELECT 
      t.id,
      t.employee_id AS employeeId,
      e.name AS employeeName,
      t.date,
      t.task_category AS taskCategory,
      t.task_details AS taskDetails,
      t.effort_minutes AS effortMinutes,
      t.comments,
      t.source
    FROM tasksheet_entries t
    JOIN employees e ON t.employee_id = e.employee_id
    WHERE t.project_id = ?
    ORDER BY t.id DESC
  `).all(project.project_id) as any[];

  const formattedTasks = entries.map((task) => ({
    ...task,
    totalEfforts: formatMinutesToEffortString(task.effortMinutes),
  }));

  res.json({
    success: true,
    project: {
      projectId: project.project_id,
      projectName: project.project_name,
    },
    totalTasks: formattedTasks.length,
    tasks: formattedTasks,
  });
});

// --------------------------------------------------
// Interactive Tasksheet Web UI with Employee Selector
// --------------------------------------------------

// Auto-sync Calendar meetings every 15 seconds in background
setInterval(() => {
  processMeetings().catch(() => {});
}, 15000);

app.get("/tasksheets", async (_req: Request, res: Response) => {
  await processMeetings().catch(() => {});
  const employees = db.prepare("SELECT * FROM employees ORDER BY employee_id ASC").all() as any[];
  const syncConfig = getExternalSyncConfig();

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>WhiteCode Employee Tasksheets & Production Sync</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 30px; background-color: #f4f6f8; color: #333; margin: 0; }
          .header { display: flex; justify-content: space-between; align-items: center; background: white; padding: 20px 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.08); margin-bottom: 20px; flex-wrap: wrap; gap: 15px; }
          h1 { margin: 0; font-size: 22px; color: #1a73e8; }
          .selector-box { font-size: 15px; font-weight: bold; display: flex; align-items: center; gap: 10px; }
          select { padding: 8px 14px; font-size: 14px; border-radius: 6px; border: 1px solid #dadce0; cursor: pointer; outline: none; background: #fff; }
          .actions-bar { display: flex; gap: 10px; margin-bottom: 20px; align-items: center; flex-wrap: wrap; }
          table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
          th { background-color: #f8f9fa; color: #5f6368; font-weight: bold; text-align: left; padding: 14px 18px; border-bottom: 2px solid #e8eaed; font-size: 14px; }
          td { padding: 14px 18px; border-bottom: 1px solid #e8eaed; font-size: 14px; }
          tr:hover { background-color: #f1f3f4; }
          .badge-auto { background-color: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
          .badge-manual { background-color: #e8f0fe; color: #1a73e8; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
          .badge-synced { background-color: #e6f4ea; color: #137333; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
          .badge-pending { background-color: #fef7e0; color: #b06000; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
          .badge-failed { background-color: #fce8e6; color: #c5221f; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
          .badge-local { background-color: #f1f3f4; color: #5f6368; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
          .effort-col { font-weight: bold; color: #202124; }
          .nav-btn { text-decoration: none; padding: 8px 14px; background: #3c4043; color: white; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; display: inline-flex; align-items: center; gap: 6px; }
          .btn-sync { background-color: #1e8e3e; }
          .btn-alias { background-color: #1a73e8; }
          .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; }
          .modal-content { background: white; padding: 24px 30px; border-radius: 10px; max-width: 600px; width: 90%; max-height: 85vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
          .form-group { margin-bottom: 15px; }
          .form-group label { display: block; font-weight: bold; margin-bottom: 6px; font-size: 13px; }
          .form-group input, .form-group select { width: 100%; padding: 9px 12px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
          .alias-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #f8f9fa; border-radius: 6px; margin-bottom: 8px; border: 1px solid #e8eaed; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <a href="/" class="nav-btn">← Home</a>
            <span style="font-weight: bold; font-size: 20px; color: #1a73e8; margin-left: 10px;">WhiteCode Tasksheet Portal</span>
          </div>
          <div class="selector-box">
            <label for="empSelect">Employee: </label>
            <select id="empSelect" onchange="loadTasksheet(this.value)">
              ${employees.map(e => `<option value="${e.employee_id}">${e.name} (${e.email})</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="actions-bar">
          <button class="nav-btn btn-sync" onclick="triggerExternalSync()" id="syncBtn">
            🔄 Sync with WhiteCode Portal
          </button>
          <button class="nav-btn btn-alias" onclick="openAliasModal()">
            📧 Personal Google Aliases Bridge
          </button>
          <span id="syncNotice" style="font-size: 13px; color: #5f6368;">
            External Sync: <strong>${syncConfig.enabled ? "Active (" + syncConfig.baseUrl + ")" : "Local Mode (configure in .env)"}</strong>
          </span>
        </div>

        <div id="tasksheetContainer">
          <p style="text-align: center; color: #777;">Loading Tasksheet...</p>
        </div>

        <!-- Email Alias Management Modal -->
        <div id="aliasModal" class="modal">
          <div class="modal-content">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
              <h3 style="margin: 0; color: #1a73e8;">Personal Google Aliases Bridge</h3>
              <button onclick="closeAliasModal()" style="border: none; background: none; font-size: 20px; cursor: pointer;">&times;</button>
            </div>
            <p style="font-size: 13px; color: #5f6368; line-height: 1.5;">
              Maps personal Google accounts (e.g. <code>surajdantrao123@gmail.com</code>) to official corporate emails (e.g. <code>suraj.dantarao@whitecode.in</code>) so hours are credited to the employee's official Tasksheet regardless of which account they use to join Google Meet.
            </p>

            <div style="background: #e8f0fe; padding: 14px; border-radius: 6px; margin-bottom: 16px;">
              <h4 style="margin: 0 0 10px 0; font-size: 14px; color: #1a73e8;">+ Add New Email Alias</h4>
              <div class="form-group">
                <label>Select Official Employee:</label>
                <select id="aliasEmpSelect">
                  ${employees.map(e => `<option value="${e.employee_id}">${e.name} (${e.email})</option>`).join("")}
                </select>
              </div>
              <div class="form-group">
                <label>Personal Google / Meet Email to Link:</label>
                <input type="email" id="aliasEmailInput" placeholder="e.g. surajdantrao123@gmail.com" />
              </div>
              <button class="nav-btn btn-alias" onclick="saveAlias()" style="width: 100%; justify-content: center;">
                Save Mapping
              </button>
            </div>

            <h4 style="margin: 16px 0 10px 0; font-size: 14px;">Existing Mapped Aliases</h4>
            <div id="aliasesList">
              <p style="color: #777; font-size: 13px;">Loading aliases...</p>
            </div>
          </div>
        </div>

        <script>
          async function loadTasksheet(empId) {
            const container = document.getElementById("tasksheetContainer");
            container.innerHTML = "<p style='text-align: center; color: #777;'>Loading Tasksheet entries...</p>";

            try {
              const res = await fetch("/employees/" + empId + "/tasksheet");
              const data = await res.json();

              if (!data.success || !data.tasksheet) {
                container.innerHTML = "<p style='color: red;'>Failed to load tasksheet.</p>";
                return;
              }

              if (data.tasksheet.length === 0) {
                container.innerHTML = "<div style='background: white; padding: 40px; text-align: center; border-radius: 8px;'><p>No Tasksheet entries found for this employee.</p></div>";
                return;
              }

              let html = '<table>';
              html += '<thead><tr><th>Date</th><th>Project Name</th><th>Task Category</th><th>Task Details</th><th>Topics Discussed</th><th>Total Efforts</th><th>Sync Status</th><th>Source</th></tr></thead>';
              html += '<tbody>';

              for (const entry of data.tasksheet) {
                const sourceBadge = entry.source === 'MEETING_AUTOMATION' 
                  ? '<span class="badge-auto" title="Automatically created from Google Meet">🤖 Meeting Automation</span>' 
                  : '<span class="badge-manual">Manual</span>';

                let syncBadge = '<span class="badge-local">💾 Local Store</span>';
                if (entry.syncStatus === 'SYNCED') {
                  syncBadge = '<span class="badge-synced" title="ID: ' + (entry.externalEntryId || 'Synced') + '">☁️ Synced to Portal</span>';
                } else if (entry.syncStatus === 'PENDING') {
                  syncBadge = '<span class="badge-pending">⏳ Pending Push</span>';
                } else if (entry.syncStatus === 'FAILED') {
                  syncBadge = '<span class="badge-failed">⚠️ Push Failed</span>';
                }

                const topicsList = (entry.comments && entry.comments !== 'Meeting')
                  ? entry.comments.split('; ').map(t => '<span style="display: block; margin-bottom: 2px;">• ' + t + '</span>').join('')
                  : '<span style="color: #94a3b8; font-style: italic;">General Discussion</span>';

                html += '<tr>';
                html += '<td>' + entry.date + '</td>';
                html += '<td><strong>' + entry.projectName + '</strong></td>';
                html += '<td>' + entry.taskCategory + '</td>';
                html += '<td style="white-space: pre-wrap; font-size: 13px; line-height: 1.4; max-width: 320px;">' + entry.taskDetails + '</td>';
                html += '<td style="font-size: 12px; color: #4338ca; line-height: 1.4; max-width: 280px;">' + topicsList + '</td>';
                html += '<td class="effort-col">' + entry.totalEfforts + '</td>';
                html += '<td>' + syncBadge + '</td>';
                html += '<td>' + sourceBadge + '</td>';
                html += '</tr>';
              }

              html += '</tbody></table>';
              container.innerHTML = html;
            } catch (err) {
              container.innerHTML = "<p style='color: red;'>Error loading tasksheet: " + err.message + "</p>";
            }
          }

          async function triggerExternalSync() {
            const btn = document.getElementById("syncBtn");
            const originalText = btn.innerHTML;
            btn.innerHTML = "⏳ Syncing...";
            btn.disabled = true;

            try {
              const res = await fetch("/api/sync/external", { method: "POST" });
              const data = await res.json();
              if (data.success) {
                alert("External Sync Complete!\\n\\nEmployees synced: " + (data.employeesSynced || 0) + "\\nProjects synced: " + (data.projectsSynced || 0) + "\\nTasksheet entries pushed: " + (data.tasksheetEntriesPushed || 0));
                const select = document.getElementById("empSelect");
                if (select && select.value) loadTasksheet(select.value);
              } else {
                alert("External sync returned notice: " + (data.error || "Check server logs."));
              }
            } catch (err) {
              alert("Error connecting to external sync: " + err.message);
            } finally {
              btn.innerHTML = originalText;
              btn.disabled = false;
            }
          }

          function openAliasModal() {
            document.getElementById("aliasModal").style.display = "flex";
            loadAliases();
          }

          function closeAliasModal() {
            document.getElementById("aliasModal").style.display = "none";
          }

          async function loadAliases() {
            const list = document.getElementById("aliasesList");
            try {
              const res = await fetch("/api/aliases");
              const data = await res.json();
              if (data.aliases && data.aliases.length > 0) {
                list.innerHTML = data.aliases.map(a => 
                  '<div class="alias-item">' +
                    '<div>' +
                      '<strong>' + a.alias_email + '</strong><br>' +
                      '<span style="font-size: 12px; color: #5f6368;">↳ ' + a.employee_name + ' (' + a.official_email + ')</span>' +
                    '</div>' +
                    '<button onclick="deleteAlias(\\'' + a.alias_email + '\\')" style="background: none; border: none; color: #d93025; cursor: pointer; font-size: 13px;">Remove</button>' +
                  '</div>'
                ).join('');
              } else {
                list.innerHTML = "<p style='color: #777; font-size: 13px;'>No custom email aliases registered yet.</p>";
              }
            } catch (e) {
              list.innerHTML = "<p style='color: red; font-size: 13px;'>Failed to load aliases.</p>";
            }
          }

          async function saveAlias() {
            const empId = document.getElementById("aliasEmpSelect").value;
            const email = document.getElementById("aliasEmailInput").value.trim();
            if (!email) {
              alert("Please enter a personal Google/Gmail email.");
              return;
            }

            try {
              const res = await fetch("/api/aliases", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ employeeId: empId, aliasEmail: email })
              });
              const data = await res.json();
              if (data.success) {
                document.getElementById("aliasEmailInput").value = "";
                loadAliases();
              } else {
                alert(data.message || "Failed to save alias.");
              }
            } catch (err) {
              alert("Error saving alias: " + err.message);
            }
          }

          async function deleteAlias(email) {
            if (!confirm("Remove alias " + email + "?")) return;
            try {
              await fetch("/api/aliases", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ aliasEmail: email })
              });
              loadAliases();
            } catch (e) {
              alert("Error removing alias.");
            }
          }

          // Initial load
          document.addEventListener("DOMContentLoaded", () => {
            const select = document.getElementById("empSelect");
            if (select && select.value) {
              loadTasksheet(select.value);
            }
          });
        </script>
      </body>
    </html>
  `);
});

// --------------------------------------------------
// Production External API & Aliases Endpoints
// --------------------------------------------------

app.post("/api/sync/external", async (_req: Request, res: Response) => {
  try {
    const empRes = await syncEmployeesFromExternal(db);
    const projRes = await syncProjectsFromExternal(db);
    const retryRes = await retryPendingTasksheetSyncs(db);
    res.json({
      success: true,
      employeesSynced: empRes.syncedCount,
      projectsSynced: projRes.syncedCount,
      tasksheetEntriesPushed: retryRes.successCount,
      pendingProcessed: retryRes.processedCount,
      config: getExternalSyncConfig(),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || err });
  }
});

app.get("/api/aliases", (_req: Request, res: Response) => {
  const aliases = getEmployeeEmailAliases(db);
  res.json({ success: true, count: aliases.length, aliases });
});

app.post("/api/aliases", (req: Request, res: Response) => {
  const { employeeId, aliasEmail, aliasName } = req.body;
  if (!employeeId || !aliasEmail) {
    res.status(400).json({ success: false, message: "employeeId and aliasEmail are required." });
    return;
  }
  const ok = addEmployeeEmailAlias(db, employeeId, aliasEmail, aliasName);
  if (!ok) {
    res.status(400).json({ success: false, message: `Could not map alias. Ensure employee '${employeeId}' exists.` });
    return;
  }
  res.json({ success: true, message: `Mapped '${aliasEmail}' to employee '${employeeId}' successfully.` });
});

app.delete("/api/aliases", (req: Request, res: Response) => {
  const { aliasEmail } = req.body;
  if (!aliasEmail) {
    res.status(400).json({ success: false, message: "aliasEmail is required." });
    return;
  }
  const ok = removeEmployeeEmailAlias(db, aliasEmail);
  res.json({ success: ok, message: ok ? `Alias '${aliasEmail}' removed.` : `Alias not found.` });
});

// --------------------------------------------------
// Chrome Extension & Google Gemini AI Real-Time Meeting Endpoints
// --------------------------------------------------

/**
 * POST /api/meet/audio-chunk
 * Receives an audio chunk (WebM/Opus) recorded by the Chrome Extension,
 * transcribes it using Google Gemini AI (supporting English & Marathi),
 * and appends the transcription to the meeting record.
 */
app.post("/api/meet/audio-chunk", upload.single("audio"), async (req: Request, res: Response) => {
  try {
    const meetingCode = (req.body.meetingCode || req.query.meetingCode || "").trim();
    const speaker = (req.body.speaker || req.query.speaker || "Participant").trim();

    let detectedParticipants: string[] = [];
    if (req.body.participants) {
      try {
        detectedParticipants = typeof req.body.participants === "string"
          ? JSON.parse(req.body.participants)
          : req.body.participants;
      } catch (err) {
        console.warn("[AUDIO_CHUNK] Could not parse participants JSON:", err);
      }
    }

    if (!req.file || !req.file.buffer) {
      res.status(400).json({ success: false, message: "No audio file chunk uploaded." });
      return;
    }

    if (!meetingCode) {
      res.status(400).json({ success: false, message: "meetingCode is required." });
      return;
    }

    console.log(`[AUDIO_CHUNK] Received ${req.file.buffer.length} bytes for meeting code '${meetingCode}' (Speaker: ${speaker}) - Detected: ${detectedParticipants.length} participants`);

    const transcribedText = await transcribeAudioChunk(
      req.file.buffer,
      req.file.mimetype || "audio/webm",
      speaker
    );

    let finalizeResult: any = null;
    if (transcribedText) {
      appendMeetingTranscript(db, meetingCode, speaker, transcribedText, "AUDIO");

      // Auto-finalize discussion and update tasksheet entries immediately on audio transcription!
      // This ensures tasksheets are filled even if the extension popup was closed by the user.
      try {
        console.log(`[AUDIO_CHUNK] Automatically updating tasksheet for meeting '${meetingCode}'...`);
        finalizeResult = await finalizeMeetingDiscussion(meetingCode, detectedParticipants);
        console.log(`[AUDIO_CHUNK] Auto-tasksheet update completed for '${meetingCode}': ${finalizeResult?.processResult?.project?.projectName} (${finalizeResult?.processResult?.tasksheetEntriesCreated} entries).`);
      } catch (finalizeErr: any) {
        console.warn(`[AUDIO_CHUNK] Auto-finalize note: ${finalizeErr?.message || finalizeErr}`);
      }
    }

    res.json({
      success: true,
      transcribedText,
      meetingCode,
      length: transcribedText.length,
      tasksheetUpdated: Boolean(finalizeResult),
      classifiedProject: finalizeResult?.processResult?.project || null,
      tasksheetEntriesCreated: finalizeResult?.processResult?.tasksheetEntriesCreated || 0,
    });
  } catch (error: any) {
    console.error("[AUDIO_CHUNK] Error transcribing audio chunk:", error);
    res.status(500).json({ success: false, error: error?.message || "Failed to transcribe audio chunk" });
  }
});

/**
 * POST /api/meet/caption-stream
 * Receives live captions (English & Marathi) captured directly by the Chrome Extension DOM.
 */
app.post("/api/meet/caption-stream", (req: Request, res: Response) => {
  try {
    const { meetingCode, speaker, text } = req.body;
    if (!meetingCode || !text) {
      res.status(400).json({ success: false, message: "meetingCode and text are required." });
      return;
    }

    appendMeetingTranscript(db, meetingCode, speaker || "Participant", text, "LIVE_CAPTION");
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || err });
  }
});

/**
 * GET /api/meet/:meetingCode/transcript
 * Returns the current compiled transcript for a meeting.
 */
app.get("/api/meet/:meetingCode/transcript", (req: Request, res: Response) => {
  try {
    const meetingCode = String(req.params.meetingCode || "");
    const transcript = getMeetingTranscript(db, meetingCode);
    res.json({ success: true, meetingCode, transcript });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || err });
  }
});

/**
 * Helper to finalize discussion for a meeting code, trigger AI topic extraction,
 * and update employee tasksheet entries. Handles both new meetings and rejoining existing meetings on new dates/sessions.
 */
export async function finalizeMeetingDiscussion(
  cleanCode: string,
  detectedParticipants: string[] = []
): Promise<any> {
  const todayStr = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const nowTimeStr = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });

  // Find meeting in database
  let meeting: any = db.prepare(`
    SELECT * FROM meetings 
    WHERE meet_link LIKE ? OR meet_link LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(`%${cleanCode}%`, `%${cleanCode.replace(/-/g, "")}%`);

  const fullTranscript = getMeetingTranscript(db, cleanCode);

  // Extract distinct speakers from meeting_transcripts
  const distinctRows = db.prepare(`
    SELECT DISTINCT speaker FROM meeting_transcripts
    WHERE meeting_code = ? OR meeting_code = ?
  `).all(cleanCode, cleanCode.replace(/-/g, "")) as Array<{ speaker: string }>;
  const transcriptSpeakers = distinctRows
    .map((r) => (r.speaker || "").trim())
    .filter((s) => s && !["participant", "meeting participant", "you", "unknown", "speaker"].includes(s.toLowerCase()));

  // Extract existing participants from meeting row (if exists)
  let existingParticipants: string[] = [];
  if (meeting && meeting.participants) {
    try {
      existingParticipants = JSON.parse(meeting.participants);
    } catch {}
  }

  // Combine and deduplicate participants
  const combinedSet = new Set<string>();
  for (const p of [...detectedParticipants, ...transcriptSpeakers, ...existingParticipants]) {
    const trimmed = (p || "").trim();
    if (trimmed && !["participant", "meeting participant", "you", "unknown", "speaker"].includes(trimmed.toLowerCase())) {
      combinedSet.add(trimmed);
    }
  }

  // If set is completely empty, fallback to suraj@whitecodelabs.com as default creator
  if (combinedSet.size === 0) {
    combinedSet.add("suraj@whitecodelabs.com");
  }

  const finalParticipants = Array.from(combinedSet);
  console.log(`[FINALIZE] Merged participants for '${cleanCode}' (${finalParticipants.length}):`, finalParticipants);

  if (!meeting) {
    // If meeting was not detected by calendar sync, auto-create meeting record for this call
    console.log(`[FINALIZE] No calendar event found for '${cleanCode}'. Creating instant meeting record.`);
    const insRes = db.prepare(`
      INSERT INTO meetings (
        google_event_id, title, date, start_time, end_time, duration_minutes,
        meet_link, organizer, participants, description, transcript, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `meet-${cleanCode}-${Date.now()}`,
      `Meeting (${cleanCode})`,
      todayStr,
      nowTimeStr,
      nowTimeStr,
      30,
      `https://meet.google.com/${cleanCode}`,
      "WhiteCode Team",
      JSON.stringify(finalParticipants),
      "Instant meeting captured via WhiteCode Chrome Extension",
      fullTranscript,
      "DETECTED"
    );
    meeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(insRes.lastInsertRowid);
  } else {
    // If meeting exists (even from an earlier day or previous session):
    // Update transcript, participants, update date to today if different, and reset status to DETECTED so it re-processes
    db.prepare(`
      UPDATE meetings 
      SET transcript = ?, 
          participants = ?,
          date = ?, 
          end_time = ?, 
          status = 'DETECTED', 
          updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(fullTranscript, JSON.stringify(finalParticipants), todayStr, nowTimeStr, meeting.id);
    meeting.transcript = fullTranscript;
    meeting.participants = JSON.stringify(finalParticipants);
    meeting.date = todayStr;
    meeting.end_time = nowTimeStr;
    meeting.status = "DETECTED";
  }

  // Process meeting and update tasksheet entries with discussion topics
  const processResult = await processMeetingRecord(meeting, { silent: false, forceReclassify: true });
  return {
    meeting,
    processResult,
    fullTranscript,
  };
}

/**
 * POST /api/meet/finalize-discussion
 * Finalizes discussion for a meeting code, triggers AI topic extraction in English & Marathi,
 * updates task_details with exact discussion topics, and updates employee tasksheet entries.
 */
app.post("/api/meet/finalize-discussion", async (req: Request, res: Response) => {
  try {
    const { meetingCode, participants } = req.body;
    if (!meetingCode) {
      res.status(400).json({ success: false, message: "meetingCode is required." });
      return;
    }

    let detectedParticipants: string[] = [];
    if (participants) {
      try {
        detectedParticipants = Array.isArray(participants) ? participants : JSON.parse(participants);
      } catch (err) {
        console.warn("[FINALIZE] Could not parse participants JSON:", err);
      }
    }

    const cleanCode = meetingCode.replace(/[^a-zA-Z0-9-]/g, "").trim();
    console.log(`[FINALIZE] Finalizing discussion for meeting code: ${cleanCode} with ${detectedParticipants.length} detected participants`);

    const { meeting, processResult, fullTranscript } = await finalizeMeetingDiscussion(cleanCode, detectedParticipants);

    res.json({
      success: true,
      message: `Meeting discussion finalized and tasksheet updated.`,
      meetingId: meeting.id,
      meetingCode: cleanCode,
      classifiedProject: processResult.project,
      tasksheetEntriesCreated: processResult.tasksheetEntriesCreated,
      transcriptLength: fullTranscript.length,
      viewTasksheetsUrl: "http://localhost:3000/tasksheets",
    });
  } catch (error: any) {
    console.error("[FINALIZE] Error finalizing meeting discussion:", error);
    res.status(500).json({ success: false, error: error?.message || "Failed to finalize discussion" });
  }
});

// --------------------------------------------------
// POST /meetings/:id/process & /process-all
// --------------------------------------------------

app.post("/meetings/:id/process", async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    let meeting: any = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id);
    if (!meeting) {
      meeting = db.prepare(`SELECT * FROM meetings WHERE google_event_id = ?`).get(id);
    }

    if (!meeting) {
      res.status(404).json({ success: false, message: `Meeting '${id}' not found.` });
      return;
    }

    const processedMeeting = await processMeetingRecord(meeting);

    res.json({
      success: true,
      message: "Meeting processed successfully",
      meetingId: processedMeeting.meetingId,
      project: processedMeeting.project,
      participants: processedMeeting.participants,
      tasksheetEntriesCreated: processedMeeting.tasksheetEntriesCreated,
      status: processedMeeting.status,
    });
  } catch (error: any) {
    console.error("Meeting process error:", error);
    const failedMeeting = db.prepare("SELECT id FROM meetings WHERE id = ? OR google_event_id = ?").get(id, id) as { id: number } | undefined;
    if (failedMeeting) {
      db.prepare("UPDATE meetings SET status = 'FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(failedMeeting.id);
    }
    res.status(500).json({
      success: false,
      message: "Could not process meeting.",
      error: error?.message || "Unknown error",
    });
  }
});

app.all("/process-all", async (_req: Request, res: Response) => {
  try {
    const meetings = db.prepare("SELECT * FROM meetings ORDER BY id DESC").all() as any[];
    const results = [];

    for (const m of meetings) {
      const r = await processMeetingRecord(m);
      results.push(r);
    }

    res.json({
      success: true,
      totalProcessed: results.length,
      meetings: results,
    });
  } catch (error: any) {
    console.error("Process all error:", error);
    res.status(500).json({ success: false, error: error?.message || "Unknown error" });
  }
});

// --------------------------------------------------
// Demo / Test Scenario Seeder Endpoint
// --------------------------------------------------

app.all("/demo/seed-test-scenario", async (req: Request, res: Response) => {
  try {
    const scenario = String(req.query.type || req.body?.type || "existing").toLowerCase();
    const date = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    const baseToday = new Date().toISOString().split("T")[0];

    let testGoogleEventId = "test-scenario-event-001";
    let title = "IQAC Cluster Website - Weekly Development Meeting";
    let description = "Discuss UI/UX improvements, audit workflow, dashboard changes, and pending backend development.";

    if (scenario === "new") {
      testGoogleEventId = "test-scenario-event-002";
      title = "Mobile App Redesign & API Sync";
      description = "Initial kickoff for the brand new Mobile App Redesign project and backend endpoint planning.";
    } else if (scenario === "untitled") {
      testGoogleEventId = "test-scenario-event-003";
      title = "Untitled Meeting";
      description = "General internal team catchup and daily status update.";
    }

    const startTime = "10:00 AM";
    const endTime = "11:30 AM";
    const durationMinutes = 90;
    const meetLink = `https://meet.google.com/whitecode-demo-${scenario}`;
    const organizer = "suraj@whitecodelabs.com";
    const calendarAttendees = [
      "suraj@whitecodelabs.com",
      "rahul@whitecodelabs.com",
      "amit@whitecodelabs.com",
      "priya@whitecodelabs.com",
    ];

    const testActualParticipants: MeetingParticipant[] = [
      {
        participantId: "part-suraj",
        email: "suraj@whitecodelabs.com",
        displayName: "Suraj",
        joinedAt: `${baseToday}T10:00:00.000Z`,
        leftAt: `${baseToday}T11:30:00.000Z`,
        durationMinutes: 90,
        sessions: [{ joinedAt: `${baseToday}T10:00:00.000Z`, leftAt: `${baseToday}T11:30:00.000Z`, durationMinutes: 90 }],
      },
      {
        participantId: "part-rahul",
        email: "rahul@whitecodelabs.com",
        displayName: "Rahul",
        joinedAt: `${baseToday}T10:05:00.000Z`,
        leftAt: `${baseToday}T11:20:00.000Z`,
        durationMinutes: 75,
        sessions: [{ joinedAt: `${baseToday}T10:05:00.000Z`, leftAt: `${baseToday}T11:20:00.000Z`, durationMinutes: 75 }],
      },
      {
        participantId: "part-amit",
        email: "amit@whitecodelabs.com",
        displayName: "Amit",
        joinedAt: `${baseToday}T10:10:00.000Z`,
        leftAt: `${baseToday}T11:30:00.000Z`,
        durationMinutes: 80,
        sessions: [{ joinedAt: `${baseToday}T10:10:00.000Z`, leftAt: `${baseToday}T11:30:00.000Z`, durationMinutes: 80 }],
      },
      {
        participantId: "part-priya",
        email: "priya@whitecodelabs.com",
        displayName: "Priya",
        joinedAt: `${baseToday}T10:15:00.000Z`,
        leftAt: `${baseToday}T11:15:00.000Z`,
        durationMinutes: 60,
        sessions: [{ joinedAt: `${baseToday}T10:15:00.000Z`, leftAt: `${baseToday}T11:15:00.000Z`, durationMinutes: 60 }],
      },
    ];

    // Remove existing test meeting if present
    const existing = db.prepare("SELECT id FROM meetings WHERE google_event_id = ?").get(testGoogleEventId) as any;
    if (existing) {
      db.prepare("DELETE FROM tasksheet_entries WHERE meeting_id = ?").run(existing.id);
      db.prepare("DELETE FROM meeting_participants WHERE meeting_id = ?").run(existing.id);
      db.prepare("DELETE FROM meetings WHERE id = ?").run(existing.id);
    }

    const insertResult = db.prepare(`
      INSERT INTO meetings (
        google_event_id, title, date, start_time, end_time, duration_minutes,
        meet_link, organizer, participants, description, status, demo_participants_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      testGoogleEventId,
      title,
      date,
      startTime,
      endTime,
      durationMinutes,
      meetLink,
      organizer,
      JSON.stringify(calendarAttendees),
      description,
      "DETECTED",
      JSON.stringify(testActualParticipants)
    );

    const newMeetingId = Number(insertResult.lastInsertRowid);
    const meetingRow = db.prepare("SELECT * FROM meetings WHERE id = ?").get(newMeetingId);

    // Auto-process meeting immediately to update employee tasksheets
    const processResult = await processMeetingRecord(meetingRow);

    res.json({
      success: true,
      message: `Test scenario '${scenario}' seeded and processed successfully.`,
      meetingId: newMeetingId,
      scenario,
      googleEventId: testGoogleEventId,
      title,
      classifiedProject: processResult.project,
      tasksheetEntriesCreated: processResult.tasksheetEntriesCreated,
      actualMeetParticipants: testActualParticipants.map((p) => ({
        email: p.email,
        displayName: p.displayName,
        durationMinutes: p.durationMinutes,
        effortString: formatMinutesToEffortString(p.durationMinutes),
      })),
      viewTasksheetsUrl: "http://localhost:3000/tasksheets",
    });
  } catch (error: any) {
    console.error("Test scenario seed error:", error);
    res.status(500).json({ success: false, error: error?.message || "Unknown error" });
  }
});

// --------------------------------------------------
// Server Start
// --------------------------------------------------

if (!process.env.NO_SERVER_LISTEN) {
  app.listen(PORT, () => {
    void startCalendarWatch().catch((error: any) => {
      const msg = String(error?.message || "");
      if (msg.includes("invalid_grant")) {
        console.warn("\n=======================================================================");
        console.warn("⚠️  GOOGLE OAUTH RE-AUTHENTICATION REQUIRED (invalid_grant)");
        console.warn("👉 Please open http://localhost:3000/ in your browser and click");
        console.warn("   'Connect Google Services' to obtain fresh API tokens.");
        console.warn("=======================================================================\n");
        try { if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH); } catch {}
      } else {
        console.warn(`[WATCH] Calendar watch notice: ${msg || error}`);
      }
    });
    console.log(`
=====================================================
 WhiteCode AI Meeting → Tasksheet Automation Platform
=====================================================

Server:
http://localhost:${PORT}

Tasksheets UI:
http://localhost:${PORT}/tasksheets

Seed Test Scenario:
POST http://localhost:${PORT}/demo/seed-test-scenario

=====================================================
    `);
  });
}