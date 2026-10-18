import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import fs from "fs";
import path from "path";
import os from "os";
import { AIClassificationResult, AvailableProjectInfo, MeetingMetadataForAI } from "./ai-classification.service";

/**
 * Executes a Gemini API call with automatic retry on transient errors (503 high demand, 429 rate limit).
 */
function isTransientGeminiError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /503|high demand|429|quota|rate limit|temporar/i.test(message);
}

async function callWithGeminiRetry<T>(
  actionName: string,
  fn: () => Promise<T>,
  maxRetries: number = 2
): Promise<T> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      if (isTransientGeminiError(err) && attempt <= maxRetries) {
        const delayMs = attempt * 1500;
        console.warn(`[GEMINI] ${actionName} received transient demand spike (${err?.message || err}). Retrying in ${delayMs}ms (Attempt ${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`[GEMINI] ${actionName} failed after ${maxRetries} retries.`);
}

/**
 * Transcribes an audio chunk using Gemini 3.6 Flash, falling back to 2.5 Flash for transient errors.
 * Accurately transcribes Marathi (मराठी), English, and mixed "Mar-glish" code-switching.
 */
export async function transcribeAudioChunkWithGemini(
  audioBuffer: Buffer,
  mimeType: string = "audio/webm"
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in .env");
  }

  const cleanMime = (mimeType.split(";")[0] || "audio/webm").trim();
  const ext = cleanMime.includes("webm") ? ".webm" : cleanMime.includes("wav") ? ".wav" : ".mp3";
  const tempPath = path.join(os.tmpdir(), `meet-chunk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);

  fs.writeFileSync(tempPath, audioBuffer);

  try {
    const fileManager = new GoogleAIFileManager(apiKey);
    const genAI = new GoogleGenerativeAI(apiKey);

    console.log(`[GEMINI] Uploading audio chunk (${audioBuffer.length} bytes, mime: ${cleanMime}) to Google AI Files API...`);
    const uploadResult = await fileManager.uploadFile(tempPath, {
      mimeType: cleanMime,
      displayName: `meeting-chunk-${Date.now()}`,
    });

    const prompt = `
You are an expert, highly accurate audio transcription system specializing in Indian workplace and engineering conversations.
Transcribe the speech in this audio recording with 100% verbatim accuracy.

Language & Vocabulary Guidelines:
1. The conversation may be in Marathi (मराठी), English, or natural bilingual Marathi-English ("Mar-glish") code-switching.
2. For spoken Marathi words, transcribe accurately in Marathi Devanagari script (मराठी लिपी).
3. For spoken English words and tech/engineering terms, transcribe in standard English Latin script.
   Common workplace terms include: API, backend, frontend, database, SQLite, server, UI, tasksheet, automation, feature, bug, testing, deploy, verify, code, review, notification, image, block, users, secure, data, approval, screen, F5, button, meeting, etc.
4. Maintain natural code-switching: do NOT force Roman/Latin script onto Marathi words, and do NOT transliterate standard English tech words into Devanagari (e.g., write "आपण हे notification system साठी use करू शकतो", NOT "aapan he use karu shakto").

Strict Verbatim & Quality Rules:
1. Transcribe ONLY what was actually spoken by human voices. Do not omit words, add words, or paraphrase.
2. If there are ambient noises, microphone hum, breathing, keyboard typing, or silence, do NOT hallucinate or fabricate words.
3. Do NOT repeat phrases in loops.
4. If there is no intelligible human speech, output an empty string "".
5. Output ONLY the raw transcribed text. Do NOT include markdown quotes, speaker prefixes, timestamps, or conversational commentary.
`;

    const generateTranscription = (modelName: string) => {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: 0.0,
          topP: 0.1,
        },
      });

      return callWithGeminiRetry(`Audio Transcription (${modelName})`, () =>
        model.generateContent([
          prompt,
          {
            fileData: {
              fileUri: uploadResult.file.uri,
              mimeType: uploadResult.file.mimeType,
            },
          },
        ])
      );
    };

    let response: Awaited<ReturnType<typeof generateTranscription>>;
    try {
      console.log("[GEMINI] Transcribing audio with Gemini 3.6 Flash...");
      response = await generateTranscription("gemini-3.6-flash");
    } catch (primaryError) {
      if (!isTransientGeminiError(primaryError)) {
        throw primaryError;
      }

      console.warn("[GEMINI] Primary transcription model is temporarily unavailable; trying Gemini 2.5 Flash.");
      response = await generateTranscription("gemini-2.5-flash");
    } finally {
      try {
        await fileManager.deleteFile(uploadResult.file.name);
      } catch (cleanupError) {
        console.warn(`[GEMINI] Could not delete uploaded audio file: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`);
      }
    }

    const text = (response.response.text() || "").trim();
    console.log(`[GEMINI] Transcribed: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
    return text;
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  }
}

/**
 * Classifies a meeting and extracts discussion topics using Gemini 3.6 Flash.
 * Translates Marathi discussions into clear, professional corporate English tasksheet entries.
 */
export async function classifyMeetingWithGemini(
  meeting: MeetingMetadataForAI,
  availableProjects: AvailableProjectInfo[]
): Promise<AIClassificationResult> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in .env");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-3.6-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const prompt = `
You are an expert AI Assistant at WhiteCode Labs specializing in employee meeting classification, multilingual discussion analysis (English and Marathi / Mar-glish), and corporate tasksheet spend tracking.

Input:
Meeting Title: ${meeting.title}
Meeting Description: ${meeting.description || "N/A"}
Transcript (spoken discussions in English, Marathi, or mixed):
${meeting.transcript || "None provided"}

Available Projects:
${JSON.stringify(availableProjects, null, 2)}

Instructions:
1. Carefully analyze what the participants actually spoke and discussed in the transcript.
2. If discussions are in Marathi (मराठी) or mixed Marathi-English ("Mar-glish"), translate all points accurately into clean, professional corporate English.
3. Extract 2-5 specific, meaningful discussion topics (e.g. "payment gateway bug fixes", "customer feedback and support queries", "database performance tuning", "automated timesheet logging workflow").
4. Classify under one of the Available Projects by projectId and projectName, or auto-assign a project if a specific initiative is discussed.
5. In 'taskDetails', compose a clear, professional corporate summary sentence detailing the actual topics discussed:
   "Attended project meeting to discuss <actual key topics discussed>."
   Example: "Attended project meeting to discuss client information support requirements, automatic data entry workflow, and system integration."
   CRITICAL: If transcript discussion exists, DO NOT write generic phrases like 'Attended project meeting for Demo meeting'. You MUST describe the actual points discussed!
6. In 'topicsDiscussed', provide an array of 2-5 specific bullet items describing what was covered in the discussion.
7. In 'activeParticipants', identify any employees, speakers, or team members who participated in, spoke in, or were present during this meeting based on the transcript and speaker tags (e.g. Monika, Vedant, Suraj).

Return ONLY a JSON object with this EXACT schema:
{
  "projectId": "PROJECT-001",
  "projectName": "AI Utility Project",
  "taskCategory": "Development",
  "taskDetails": "Attended project meeting to discuss client information support requirements and automated data entry workflow.",
  "topicsDiscussed": [
    "Client information support requirements",
    "Automated data entry workflow",
    "System integration and testing"
  ],
  "activeParticipants": [
    "Suraj",
    "Monika",
    "Vedant"
  ],
  "confidence": 0.95,
  "reason": "Clear rationale explaining project and discussion topic identification",
  "isNewProject": false
}
`;

  console.log(`[GEMINI] Invoking Gemini 3.6 Flash for meeting classification & topic extraction...`);
  const result = await callWithGeminiRetry("Meeting Classification", () => model.generateContent(prompt));
  const rawText = result.response.text();
  const parsed: AIClassificationResult = JSON.parse(rawText);

  if (parsed.projectId && parsed.projectName) {
    const existsInDb = availableProjects.some(
      (p) => p.projectId.toLowerCase() === parsed.projectId.toLowerCase() || p.projectName.toLowerCase() === parsed.projectName.toLowerCase()
    );
    if (!existsInDb) {
      parsed.isUnknownProject = true;
    }
  }

  console.log(`[GEMINI] Classification successful: ${parsed.projectName} (${parsed.projectId}) - Topics: ${parsed.topicsDiscussed?.length || 0}`);
  if (parsed.topicsDiscussed && parsed.topicsDiscussed.length > 0) {
    console.log(`[GEMINI] Extracted Discussion Topics:`, parsed.topicsDiscussed);
  }
  return parsed;
}
