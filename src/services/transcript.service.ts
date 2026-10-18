import Database from "better-sqlite3";
import { transcribeAudioChunkWithGemini } from "./gemini.service";

export interface TranscriptEntry {
  id?: number;
  meetingCode: string;
  speaker: string | null;
  text: string;
  source: string;
  createdAt?: string;
}

/**
 * Initializes the SQLite table for storing incremental meeting discussion transcripts.
 */
export function ensureTranscriptTableExists(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_code TEXT NOT NULL,
      speaker TEXT,
      text TEXT NOT NULL,
      source TEXT DEFAULT 'AUDIO',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_transcripts_code ON meeting_transcripts(meeting_code);
  `);

  try {
    db.exec("ALTER TABLE meetings ADD COLUMN transcript TEXT;");
  } catch {
    // Column already exists
  }
}

/**
 * Transcribes an audio chunk using Gemini 3.6 Flash with a 2.5 Flash fallback for transient errors.
 * Specifically primed to handle bilingual English and Marathi (Mar-glish) code-switching.
 */
export async function transcribeAudioChunk(
  audioBuffer: Buffer,
  mimeType: string = "audio/webm",
  speaker?: string
): Promise<string> {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!geminiKey) {
    console.warn("[TRANSCRIPT] GEMINI_API_KEY is not configured in .env. Skipping audio transcription.");
    return "";
  }

  return transcribeAudioChunkWithGemini(audioBuffer, mimeType);
}

/**
 * Detects if a text string is an automated Google Meet system accessibility toast or UI announcement
 * rather than real human participant discussion.
 */
export function isSystemNotification(text: string): boolean {
  if (!text || text.trim().length === 0) return true;
  const t = text.trim();

  // Filter common Google Meet UI announcements and toasts
  const systemPatterns = [
    /microphone is (on|off)/i,
    /camera is (on|off)/i,
    /left the meeting/i,
    /joined the (meeting|call)/i,
    /^[A-Za-z0-9\s._-]+ (has )?(joined|left)( the meeting| the call)?\.?$/i,
    /rate the audio and video/i,
    /returning to home screen/i,
    /\b\d+\s*seconds?\s*left/i,
    /someone wants to join/i,
    /admit/i,
    /you are muted/i,
    /your mic is/i,
    /turn on microphone/i,
    /presenting to everyone/i,
    /stop presenting/i,
    /jump to latest/i,
    /captions have been turned (on|off)/i,
    /chat messages/i,
    /in-call messages/i,
    /can't start video/i,
    /network connection is unstable/i,
  ];

  return systemPatterns.some((pattern) => pattern.test(t));
}

/**
 * Appends a transcribed fragment or live caption into the database.
 */
export function appendMeetingTranscript(
  db: Database.Database,
  meetingCode: string,
  speaker: string | null,
  text: string,
  source: "AUDIO" | "LIVE_CAPTION" | "WHISPER" | string = "AUDIO"
): void {
  ensureTranscriptTableExists(db);
  const cleanCode = meetingCode.replace(/[^a-zA-Z0-9-]/g, "").trim();
  const cleanText = text.trim();

  if (!cleanText) return;

  // Reject Google Meet system UI announcements
  if (isSystemNotification(cleanText)) {
    console.log(`[TRANSCRIPT] Filtered out system UI announcement: "${cleanText.slice(0, 60)}"`);
    return;
  }

  // Prevent exact duplicate consecutive entries
  const lastRow = db.prepare(`
    SELECT text FROM meeting_transcripts 
    WHERE meeting_code = ? 
    ORDER BY id DESC LIMIT 1
  `).get(cleanCode) as { text: string } | undefined;

  if (lastRow && lastRow.text.trim() === cleanText) {
    return;
  }

  db.prepare(`
    INSERT INTO meeting_transcripts (meeting_code, speaker, text, source)
    VALUES (?, ?, ?, ?)
  `).run(cleanCode, speaker || "Speaker", cleanText, source);

  // Sync combined transcript onto the meetings table record if matching meeting code exists
  const combined = getMeetingTranscript(db, cleanCode);
  db.prepare(`
    UPDATE meetings 
    SET transcript = ?, updated_at = CURRENT_TIMESTAMP
    WHERE meet_link LIKE ?
  `).run(combined, `%${cleanCode}%`);
}

/**
 * Retrieves the compiled speaker-attributed transcript for a given meeting code.
 */
export function getMeetingTranscript(
  db: Database.Database,
  meetingCode: string
): string {
  ensureTranscriptTableExists(db);
  const cleanCode = meetingCode.replace(/[^a-zA-Z0-9-]/g, "").trim();

  const rows = db.prepare(`
    SELECT speaker, text, source, created_at 
    FROM meeting_transcripts 
    WHERE meeting_code = ? 
    ORDER BY id ASC
  `).all(cleanCode) as Array<{ speaker: string | null; text: string; source?: string }>;

  if (rows.length === 0) return "";

  // Filter out any system notifications that might have been saved previously
  const cleanRows = rows.filter((r) => !isSystemNotification(r.text));

  // If we have AUDIO transcriptions (which represent full speech processed with Gemini 3.6 Flash),
  // they are authoritative. We prioritize AUDIO rows if present, or all valid speech rows.
  const audioRows = cleanRows.filter((r) => r.source === "AUDIO");
  const selectedRows = audioRows.length > 0 ? audioRows : cleanRows;

  return selectedRows
    .map((r) => `${r.speaker ? `[${r.speaker}]` : "[Participant]"}: ${r.text}`)
    .join("\n");
}

/**
 * Clears transcripts for a meeting (useful for testing or resetting).
 */
export function clearMeetingTranscript(
  db: Database.Database,
  meetingCode: string
): void {
  ensureTranscriptTableExists(db);
  const cleanCode = meetingCode.replace(/[^a-zA-Z0-9-]/g, "").trim();
  db.prepare("DELETE FROM meeting_transcripts WHERE meeting_code = ?").run(cleanCode);
}
