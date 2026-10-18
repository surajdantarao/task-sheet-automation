import { classifyMeetingWithGemini } from "./gemini.service";

export interface AIClassificationResult {
  projectId: string;
  projectName: string;
  taskCategory: string;
  taskDetails: string;
  confidence: number;
  reason: string;
  isNewProject?: boolean;
  isUnknownProject?: boolean;
  topicsDiscussed?: string[];
  activeParticipants?: string[];
}

export interface MeetingMetadataForAI {
  title: string;
  description?: string | null;
  transcript?: string | null;
}

export interface AvailableProjectInfo {
  projectId: string;
  projectName: string;
  description?: string;
  keywords?: string[];
}

/**
 * Classifies a Google Meet meeting using Google Gemini (gemini-3.6-flash).
 * Determines the target WhiteCode project, task category, concise task details description,
 * extracts specific discussion topics in English and Marathi, and returns confidence score.
 *
 * Includes a deterministic fallback engine if GEMINI_API_KEY is not configured or on network error.
 */
export async function classifyMeetingWithAI(
  meeting: MeetingMetadataForAI,
  availableProjects: AvailableProjectInfo[]
): Promise<AIClassificationResult> {
  // 1. Prioritize Google Gemini 3.6 Flash if GEMINI_API_KEY is configured
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      return await classifyMeetingWithGemini(meeting, availableProjects);
    } catch (geminiErr: any) {
      console.warn(`[GEMINI] Gemini classification error (${geminiErr?.message || geminiErr}). Falling back to local classifier engine.`);
    }
  } else {
    console.log(`[AI] GEMINI_API_KEY not configured. Using local deterministic classifier engine.`);
  }

  // Fallback Classifier Engine (used when GEMINI_API_KEY is omitted or on API error)
  console.log(`[AI] Running local classification engine for: "${meeting.title}"`);
  const rawTitle = (meeting.title || "").trim();
  const titleLower = rawTitle.toLowerCase();
  const descLower = (meeting.description || "").toLowerCase();
  const transcriptLower = (meeting.transcript || "").toLowerCase();

  // Extract key topics from transcript in fallback mode
  const extractedTopics: string[] = [];
  if (meeting.transcript) {
    const lines = meeting.transcript.split("\n").map(l => l.replace(/^\[.*?\]:\s*/, "").trim()).filter(Boolean);
    for (const line of lines) {
      if (/api|integration|webhook/i.test(line)) extractedTopics.push("API integration & webhook workflow");
      if (/retry|sqlite|database|schema/i.test(line)) extractedTopics.push("Database schema & retry logic");
      if (/speech|recognition|audio|marathi/i.test(line)) extractedTopics.push("Marathi speech recognition & Gemini audio pipeline");
      if (/ui|tasksheet|frontend|display/i.test(line)) extractedTopics.push("Tasksheet UI & automated timesheet sync");
      if (/support|information|client|customer/i.test(line)) extractedTopics.push("Client information & support requirements");
      if (/automatic|auto|data\s*entry/i.test(line)) extractedTopics.push("Automated data entry & processing workflow");
    }

    // If specific keywords didn't match, extract the first 2-3 spoken lines as discussion topics
    if (extractedTopics.length === 0 && lines.length > 0) {
      for (const line of lines.slice(0, 3)) {
        if (line.length > 5) {
          extractedTopics.push(line.slice(0, 100));
        }
      }
    }
  }
  const uniqueTopics = Array.from(new Set(extractedTopics));
  const fallbackTopicSummary = uniqueTopics.length > 0
    ? `Attended project meeting to discuss ${uniqueTopics.join(", ").toLowerCase()}.`
    : null;

  const isUntitled = !rawTitle || titleLower === "untitled meeting" || titleLower === "untitled" || titleLower === "meeting";

  // 1. Check if meeting transcript, description or title matches an existing project
  for (const proj of availableProjects) {
    let keywords = proj.keywords || [proj.projectName];
    if (proj.projectId === "project-001" || proj.projectId === "PROJECT-001") {
      keywords = [...keywords, "AI", "Utility", "Intern", "Automation", "AI Utility Project"];
    }
    
    let matchedKeyword = keywords.find((k) =>
      (!isUntitled && titleLower.includes(k.toLowerCase())) ||
      descLower.includes(k.toLowerCase()) ||
      transcriptLower.includes(k.toLowerCase())
    );

    if (matchedKeyword) {
      const taskDetailsDesc = fallbackTopicSummary || (meeting.description
        ? `Attended project meeting to discuss ${meeting.description.toLowerCase().replace(/\.$/, "")}.`
        : `Attended project meeting to discuss ${proj.projectName} development and workflow sync.`);

      return {
        projectId: proj.projectId,
        projectName: proj.projectName,
        taskCategory: "Development",
        taskDetails: taskDetailsDesc,
        topicsDiscussed: uniqueTopics.length > 0 ? uniqueTopics : [proj.projectName + " review"],
        confidence: 0.94,
        reason: `Meeting title, transcript, and description match existing project '${proj.projectName}'.`,
        isNewProject: false,
        isUnknownProject: false,
      };
    }
  }

  // 2. If meeting is Untitled and no existing project matched in description:
  if (isUntitled) {
    const untitledProj = availableProjects.find((p) => p.projectId === "PROJECT-UNTITLED" || p.projectName.toLowerCase() === "untitled meeting");
    return {
      projectId: untitledProj?.projectId || "PROJECT-UNTITLED",
      projectName: untitledProj?.projectName || "Untitled Meeting",
      taskCategory: "Meeting",
      taskDetails: fallbackTopicSummary || (meeting.description
        ? `Attended meeting: ${meeting.description.toLowerCase().replace(/\.$/, "")}.`
        : "Attended meeting."),
      topicsDiscussed: uniqueTopics.length > 0 ? uniqueTopics : ["General team discussion"],
      confidence: 0.90,
      reason: "Untitled meeting recorded as 'Untitled Meeting'.",
      isNewProject: false,
      isUnknownProject: !untitledProj,
    };
  }

  // 3. Dynamic project fallback for meeting titles not in availableProjects
  const cleanedTitle = rawTitle;
  const newSlug = "PROJECT-" + cleanedTitle.toUpperCase().replace(/[^A-Z0-9]/g, "-").slice(0, 15);

  return {
    projectId: newSlug,
    projectName: cleanedTitle,
    taskCategory: "Development",
    taskDetails: fallbackTopicSummary || `Attended project meeting to discuss ${cleanedTitle}.`,
    topicsDiscussed: uniqueTopics.length > 0 ? uniqueTopics : [`${cleanedTitle} discussion`],
    confidence: 0.90,
    reason: `Project "${cleanedTitle}" is not in SQLite projects table.`,
    isNewProject: true,
    isUnknownProject: true,
  };
}
