import Database from "better-sqlite3";
import { AIClassificationResult } from "./ai-classification.service";
import { calculateParticipantDuration } from "./duration.service";
import { pushTasksheetEntryToExternal } from "./external-sync.service";

export interface DemoEmployee {
  employeeId: string;
  name: string;
  email: string;
  active: number;
}

export interface DemoProject {
  projectId: string;
  projectName: string;
  description: string;
  active: number;
  keywords?: string[];
}

export interface TasksheetEntry {
  id?: number;
  employeeId: string;
  meetingId?: number | null;
  projectId: string;
  projectName?: string;
  date: string;
  taskCategory: string;
  taskDetails: string;
  totalEfforts: string; // Formatted H:MM e.g. "1:30"
  effortMinutes: number;
  comments: string;
  source: string;
  createdAt?: string;
}

export const INITIAL_DEMO_EMPLOYEES: DemoEmployee[] = [
  { employeeId: "EMP001", name: "Monika Isave", email: "monikaisave@gmail.com", active: 1 },
  { employeeId: "EMP002", name: "Arin Palsuledesai", email: "palsuledesaiarin@gmail.com", active: 1 },
  { employeeId: "EMP003", name: "Suraj Personal", email: "personalsuraj412@gmail.com", active: 1 },
  { employeeId: "EMP004", name: "Pramod Umate", email: "pramod.umate@whitecode.co.in", active: 1 },
  { employeeId: "EMP005", name: "Suraj Dantarao", email: "surajdantrao123@gmail.com", active: 1 },
  { employeeId: "EMP006", name: "Vedant Adhav", email: "vedant00adhav@gmail.com", active: 1 },
  { employeeId: "EMP007", name: "Suraj WhiteCode", email: "suraj@whitecodelabs.com", active: 1 },
];

export const INITIAL_DEMO_PROJECTS: DemoProject[] = [
  {
    projectId: "project-001",
    projectName: "AI Utility Project",
    description: "AI Intern Given Project review",
    active: 1,
    keywords: ["AI", "Utility", "Intern", "Automation"],
  },
];

/**
 * Converts minutes (integer) to readable effort string with hours and minutes.
 * Examples: 15 -> "15 mins", 60 -> "1 hr", 75 -> "1 hr 15 mins", 90 -> "1 hr 30 mins"
 */
export function formatMinutesToEffortString(minutes: number): string {
  if (isNaN(minutes) || minutes <= 0) return "0 mins";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  
  if (hours === 0) {
    return `${mins} mins`;
  }
  if (mins === 0) {
    return `${hours} hr${hours > 1 ? "s" : ""}`;
  }
  return `${hours} hr${hours > 1 ? "s" : ""} ${mins} mins`;
}

/**
 * Converts effort string "H:MM" to minutes (integer).
 */
export function parseEffortStringToMinutes(effortStr: string): number {
  if (!effortStr || !effortStr.includes(":")) return 0;
  const parts = effortStr.split(":");
  const hours = parseInt(parts[0], 10) || 0;
  const mins = parseInt(parts[1], 10) || 0;
  return hours * 60 + mins;
}

/**
 * Calculates a match score between a participant's identity and an employee record.
 * Uses discriminators to avoid confusing similar names (e.g. "suraj Dantrao" vs "personal suraj" vs "Suraj WhiteCode").
 */
export function scoreEmployeeMatch(
  email: string | null,
  displayName: string | null,
  emp: any
): number {
  const empEmail = (emp.email || "").toLowerCase();
  const empPrefix = empEmail.split("@")[0] || "";
  const empName = (emp.name || "").toLowerCase();

  // 1. Exact email match
  if (email && empEmail && email.toLowerCase() === empEmail) {
    return 10000;
  }

  // 2. If displayName is an email and matches empEmail
  if (displayName && displayName.includes("@") && displayName.toLowerCase() === empEmail) {
    return 9000;
  }

  // 3. Exact name match
  if (displayName && empName && displayName.toLowerCase().trim() === empName) {
    return 5000;
  }

  // 4. Compact string match (e.g. "surajdantrao" matches "surajdantrao123")
  const dispClean = (displayName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const empClean = empName.replace(/[^a-z0-9]/g, "");
  const prefixClean = empPrefix.replace(/[^a-z0-9]/g, "");
  if (dispClean.length >= 4) {
    if (prefixClean === dispClean || empClean === dispClean) {
      return 4500;
    }
    if (prefixClean.startsWith(dispClean) || dispClean.startsWith(prefixClean)) {
      return 4000;
    }
  }

  // 5. Token-level analysis with dynamic discriminator scoring
  const tokens = (displayName || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return 0;

  const empTokens = `${empPrefix} ${empName}`.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

  let score = 0;
  let matchesCount = 0;

  for (const token of tokens) {
    const exactMatch = empTokens.some((et) => et === token);
    const substringMatch = !exactMatch && (empPrefix.includes(token) || empName.includes(token));

    if (exactMatch) {
      matchesCount++;
      const isDistinctive = token.length >= 5 || /[0-9]/.test(token);
      score += isDistinctive ? 2000 : 500;
    } else if (substringMatch) {
      matchesCount++;
      score += token.length >= 4 ? 400 : 200;
    } else {
      if (token.length >= 5) {
        score -= 1000;
      } else if (token.length >= 4) {
        score -= 300;
      }
    }
  }

  if (matchesCount === tokens.length && tokens.length > 1) {
    score += 1000;
  }

  return score;
}

/**
 * Finds the best matching active employee for a given participant email and/or displayName.
 */
export function findBestMatchingEmployee(
  db: Database.Database,
  email: string | null,
  displayName: string | null
): any | null {
  // 0. Direct check in employee_email_aliases table
  if (email) {
    try {
      const aliasMatch = db.prepare(`
        SELECT e.*
        FROM employee_email_aliases a
        JOIN employees e ON a.employee_id = e.employee_id
        WHERE LOWER(a.alias_email) = ?
      `).get(email.toLowerCase().trim()) as any;
      if (aliasMatch) return aliasMatch;
    } catch {}
  }
  if (displayName && displayName.includes("@")) {
    try {
      const aliasMatch = db.prepare(`
        SELECT e.*
        FROM employee_email_aliases a
        JOIN employees e ON a.employee_id = e.employee_id
        WHERE LOWER(a.alias_email) = ?
      `).get(displayName.toLowerCase().trim()) as any;
      if (aliasMatch) return aliasMatch;
    } catch {}
  }

  // 1. Direct exact email match
  if (email) {
    const directByEmail = db.prepare("SELECT * FROM employees WHERE LOWER(email) = ?").get(email.toLowerCase());
    if (directByEmail) return directByEmail;
  }

  // 2. Score all active employees in database
  const allEmployees = db.prepare("SELECT * FROM employees WHERE active = 1").all() as any[];
  let bestEmp: any = null;
  let bestScore = 0;

  for (const emp of allEmployees) {
    const score = scoreEmployeeMatch(email, displayName, emp);
    if (score > bestScore) {
      bestScore = score;
      bestEmp = emp;
    }
  }

  if (bestEmp && bestScore > 50) {
    return bestEmp;
  }

  return null;
}

/**
 * Seeds demo database tables with initial employees, projects, and employee-project assignments.
 * Uses upsert (INSERT ... ON CONFLICT) and INSERT OR IGNORE to guarantee that auto-registered
 * projects, custom employees, and user tasksheet entries are NEVER wiped on server restart.
 */
export function seedTasksheetDemoData(db: Database.Database): void {
  // 1. Sync initial demo employees without deleting existing ones
  const insEmp = db.prepare(`
    INSERT INTO employees (employee_id, name, email, active) 
    VALUES (?, ?, ?, ?)
    ON CONFLICT(employee_id) DO UPDATE SET 
      name = excluded.name, 
      email = excluded.email, 
      active = excluded.active
  `);
  for (const e of INITIAL_DEMO_EMPLOYEES) {
    insEmp.run(e.employeeId, e.name, e.email, e.active);
  }
  console.log(`[SEED] ${INITIAL_DEMO_EMPLOYEES.length} Test Employees synced to database.`);

  // 2. Ensure initial demo projects exist without deleting existing auto-registered projects
  const insProj = db.prepare(`
    INSERT INTO projects (project_id, project_name, description, active) 
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET 
      project_name = excluded.project_name, 
      description = excluded.description, 
      active = excluded.active
  `);
  for (const p of INITIAL_DEMO_PROJECTS) {
    insProj.run(p.projectId, p.projectName, p.description, p.active);
  }
  // Keep Untitled Meeting in projects table for Scenario 3
  db.prepare("INSERT OR IGNORE INTO projects (project_id, project_name, description, active) VALUES ('PROJECT-UNTITLED', 'Untitled Meeting', 'Untitled Meeting', 1)").run();

  console.log("[SEED] Project database updated: initial projects synced.");

  // 3. Seed Employee Project Assignments for default projects without deleting existing assignments
  const insEmpProj = db.prepare("INSERT OR IGNORE INTO employee_projects (employee_id, project_id, active) VALUES (?, ?, 1)");
  for (const e of INITIAL_DEMO_EMPLOYEES) {
    for (const p of INITIAL_DEMO_PROJECTS) {
      insEmpProj.run(e.employeeId, p.projectId);
    }
    insEmpProj.run(e.employeeId, "PROJECT-UNTITLED");
  }
  console.log("[SEED] Employee project assignments updated.");

  // 4. Ensure employee_email_aliases table exists and seed default aliases
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

  const insAlias = db.prepare(`
    INSERT OR IGNORE INTO employee_email_aliases (employee_id, alias_email, alias_name)
    VALUES (?, ?, ?)
  `);
  insAlias.run("EMP005", "suraj.dantarao@whitecode.in", "Suraj Dantarao");
  insAlias.run("EMP005", "surajdantrao123@gmail.com", "Suraj Dantrao");
  insAlias.run("EMP003", "personalsuraj412@gmail.com", "Suraj Personal");
  insAlias.run("EMP007", "suraj@whitecodelabs.com", "Suraj WhiteCode");
  insAlias.run("EMP004", "pramod.umate@whitecode.co.in", "Pramod Umate");
  insAlias.run("EMP001", "monikaisave@gmail.com", "Monika Isave");
  insAlias.run("EMP006", "vedant00adhav@gmail.com", "Vedant Adhav");
  insAlias.run("EMP002", "palsuledesaiarin@gmail.com", "Arin Palsuledesai");
}

/**
 * Validates AI project & employee assignments, then creates separate Tasksheet entries
 * for each actual participant in their OWN Tasksheet.
 */
export function validateAndCreateTasksheetEntries(
  db: Database.Database,
  meeting: any,
  actualParticipants: Array<{
    email: string | null;
    displayName: string | null;
    durationMinutes: number;
    joinedAt?: string | null;
    leftAt?: string | null;
    sessions?: any[];
    isStillInCall?: boolean;
  }>,
  aiResult: AIClassificationResult
): {
  createdCount: number;
  processedParticipants: Array<{
    employeeId: string;
    name: string;
    durationMinutes: number;
    effortString: string;
    tasksheetUpdated: boolean;
    reason?: string;
  }>;
  status: "PROCESSED" | "REVIEW_REQUIRED" | "FAILED";
} {
  console.log(`[VALIDATION] Validating AI classification result: ${aiResult.projectId} ("${aiResult.projectName}")`);

  // Check confidence thresholds
  const CONFIDENCE_MIN_AUTO = 0.85;
  const CONFIDENCE_MIN_REVIEW = 0.60;

  if (aiResult.confidence < CONFIDENCE_MIN_REVIEW) {
    console.warn(`[VALIDATION] Confidence too low (${aiResult.confidence} < 0.60). Tasksheet entry rejected.`);
    return { createdCount: 0, processedParticipants: [], status: "FAILED" };
  }

  const isReviewRequired = aiResult.confidence < CONFIDENCE_MIN_AUTO;

  if (aiResult.isUnknownProject && !aiResult.isNewProject) {
    console.warn(`[VALIDATION] AI classified project '${aiResult.projectName}' marked REVIEW_REQUIRED (0 tasksheet entries created).`);
    return { createdCount: 0, processedParticipants: [], status: "REVIEW_REQUIRED" };
  }

  // Validate or Auto-Register Project in SQLite
  let projectRow = db.prepare("SELECT * FROM projects WHERE project_id = ? OR project_name = ?").get(
    aiResult.projectId, aiResult.projectName
  ) as any;

  if (!projectRow) {
    // Attempt case-insensitive search
    projectRow = db.prepare("SELECT * FROM projects WHERE LOWER(project_name) LIKE ?").get(
      `%${aiResult.projectName.toLowerCase()}%`
    );
  }

  if (!projectRow) {
    // Scenario 2: Auto-register new project specified in meeting data
    console.log(`[PROJECT] Auto-registering new project '${aiResult.projectName}' (${aiResult.projectId}) in SQLite projects table.`);
    db.prepare("INSERT INTO projects (project_id, project_name, description, active) VALUES (?, ?, ?, 1)").run(
      aiResult.projectId,
      aiResult.projectName,
      `Project auto-registered from meeting '${meeting.title}'`
    );
    projectRow = { project_id: aiResult.projectId, project_name: aiResult.projectName };
  }

  const validatedProjectId = projectRow.project_id;
  const validatedProjectName = projectRow.project_name;

  // Clean up any 0-minute tasksheet entries and ensure task_category is "Meeting" for meeting entries
  db.prepare("DELETE FROM tasksheet_entries WHERE effort_minutes <= 0").run();
  db.prepare("UPDATE tasksheet_entries SET task_category = 'Meeting' WHERE source = 'MEETING_AUTOMATION'").run();
  const processedParticipants = [];
  let createdCount = 0;

  const dateStr = meeting.date || new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const checkDuplicateStmt = db.prepare("SELECT id, effort_minutes FROM tasksheet_entries WHERE meeting_id = ? AND employee_id = ? AND date = ?");
  const insTasksheetStmt = db.prepare(`
    INSERT INTO tasksheet_entries (
      employee_id, meeting_id, project_id, date, task_category, task_details, effort_minutes, comments, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 1. Group actual participants by employee to merge overlapping multi-device or reconnect sessions
  const employeeMap = new Map<string, {
    empRow: any;
    sessions: any[];
    maxRawMinutes: number;
    isStillInCall: boolean;
    earliestJoinedAt?: string | null;
  }>();

  for (const part of actualParticipants) {
    // Map email/name to WhiteCode Employee with accurate disambiguation
    let empRow = findBestMatchingEmployee(db, part.email, part.displayName);

    // Fallback: Check if meeting organizer matches an active employee
    if (!empRow && meeting?.organizer) {
      empRow = findBestMatchingEmployee(db, meeting.organizer, null);
    }

    if (!empRow) {
      console.warn(`[UNMAPPED_PARTICIPANT] Could not map participant identity (email: ${part.email}, name: ${part.displayName}) to WhiteCode employee.`);
      processedParticipants.push({
        employeeId: "UNMAPPED_PARTICIPANT",
        name: part.displayName || "Unknown Participant",
        durationMinutes: part.durationMinutes,
        effortString: formatMinutesToEffortString(part.durationMinutes),
        tasksheetUpdated: false,
        reason: "Participant email/identity could not be mapped to an active WhiteCode employee.",
      });
      continue;
    }

    const empId = empRow.employee_id;
    const isParticipantStillInCall = Boolean(part.isStillInCall || !part.leftAt || (part.sessions && part.sessions.some((s: any) => !s.leftAt)));

    const partSessions = (part.sessions && part.sessions.length > 0)
      ? part.sessions.filter((s: any) => Boolean(s.leftAt))
      : (part.joinedAt && part.leftAt ? [{ joinedAt: part.joinedAt, leftAt: part.leftAt }] : []);

    const existing = employeeMap.get(empId);
    if (existing) {
      existing.sessions.push(...partSessions);
      existing.maxRawMinutes = Math.max(existing.maxRawMinutes, part.durationMinutes || 0);
      existing.isStillInCall = existing.isStillInCall || isParticipantStillInCall;
      if (!existing.earliestJoinedAt && part.joinedAt) {
        existing.earliestJoinedAt = part.joinedAt;
      }
    } else {
      employeeMap.set(empId, {
        empRow,
        sessions: [...partSessions],
        maxRawMinutes: part.durationMinutes || 0,
        isStillInCall: isParticipantStillInCall,
        earliestJoinedAt: part.joinedAt || (partSessions[0]?.joinedAt || null),
      });
    }
  }

  for (const [employeeId, { empRow, sessions, maxRawMinutes, isStillInCall, earliestJoinedAt }] of employeeMap.entries()) {
    const employeeName = empRow.name;

    // CRITICAL: If employee is still in the call, DO NOT create a tasksheet entry yet!
    if (isStillInCall) {
      console.log(`[TASKSHEET] Participant ${employeeName} is CURRENTLY STILL IN CALL (meeting ongoing). Tasksheet entry will be created when ${employeeName} leaves.`);
      processedParticipants.push({
        employeeId,
        name: employeeName,
        durationMinutes: 0,
        effortString: "0 mins",
        tasksheetUpdated: false,
        reason: "Participant is currently active in the meeting. Waiting until they leave call.",
      });
      continue;
    }

    // Merge overlapping intervals to get TRUE active participation duration (prevent double-counting concurrent devices)
    let totalDurationMinutes = calculateParticipantDuration(sessions);
    if (totalDurationMinutes === 0 && maxRawMinutes > 0) {
      totalDurationMinutes = maxRawMinutes;
    }

    // Validate / Assign Employee Project Assignment
    let isAssigned = db.prepare(`
      SELECT id FROM employee_projects
      WHERE employee_id = ? AND project_id = ?
    `).get(employeeId, validatedProjectId);

    if (!isAssigned) {
      db.prepare("INSERT OR IGNORE INTO employee_projects (employee_id, project_id, active) VALUES (?, ?, 1)").run(
        employeeId, validatedProjectId
      );
      console.log(`[ASSIGNMENT] Auto-assigned employee ${employeeName} (${employeeId}) to project ${validatedProjectName}.`);
      isAssigned = true;
    }

    // CRITICAL: Do NOT create tasksheet entries for 0 minutes duration
    if (!totalDurationMinutes || totalDurationMinutes <= 0) {
      console.log(`[TASKSHEET] Participant ${employeeName} has 0 minutes duration recorded. Skipping entry.`);
      processedParticipants.push({
        employeeId,
        name: employeeName,
        durationMinutes: 0,
        effortString: "0 mins",
        tasksheetUpdated: false,
        reason: "0 minutes duration. Tasksheet entry will be created after participant leaves meeting with recorded duration.",
      });
      continue;
    }

    // Format effort string (e.g. 90m -> "1 hr 30 mins")
    const effortString = formatMinutesToEffortString(totalDurationMinutes);

    // Determine the date for this participant session (enables multi-day recurring meeting support)
    const sessionDate = earliestJoinedAt
      ? new Date(earliestJoinedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
      : dateStr;

    // Combine corporate task details with bulleted discussion topics so it fills what was actually discussed
    const commentsContent = (aiResult.topicsDiscussed && aiResult.topicsDiscussed.length > 0)
      ? aiResult.topicsDiscussed.join("; ")
      : "Meeting";

    let fullTaskDetails = aiResult.taskDetails;
    if (aiResult.topicsDiscussed && aiResult.topicsDiscussed.length > 0) {
      const topicBullets = aiResult.topicsDiscussed.map((t) => `• ${t}`).join("\n");
      if (!fullTaskDetails.includes("•")) {
        fullTaskDetails = `${aiResult.taskDetails}\n\nTopics Discussed:\n${topicBullets}`;
      }
    }

    const existingEntry = checkDuplicateStmt.get(meeting.id, employeeId, sessionDate) as any;
    if (existingEntry) {
      // Protect manually edited entries (if employee customized comments or source)
      const isCustomized = existingEntry.comments && existingEntry.comments !== "Meeting" && existingEntry.source !== "MEETING_AUTOMATION";
      if (!isCustomized) {
        db.prepare(`
          UPDATE tasksheet_entries 
          SET project_id = ?,
              effort_minutes = ?, 
              task_details = ?,
              comments = ?,
              sync_status = 'PENDING', 
              updated_at = CURRENT_TIMESTAMP 
          WHERE id = ?
        `).run(validatedProjectId, totalDurationMinutes, fullTaskDetails, commentsContent, existingEntry.id);
        createdCount++;
        console.log(`[TASKSHEET] Updated ${employeeName}'s Tasksheet entry with discussion topics -> ${effortString} (${totalDurationMinutes}m) for ${sessionDate}`);
        void pushTasksheetEntryToExternal(db, existingEntry.id).catch(() => {});
      } else if (isCustomized) {
        console.log(`[USER_PROTECT] Preserved custom tasksheet entry for ${employeeName} on ${sessionDate}. Skipping overwrite.`);
      } else {
        console.log(`[DUPLICATE_PREVENTION] Tasksheet entry for meeting ${meeting.id}, employee ${employeeId} & date ${sessionDate} already exists. Skipping.`);
      }
      processedParticipants.push({
        employeeId,
        name: employeeName,
        durationMinutes: totalDurationMinutes,
        effortString,
        tasksheetUpdated: true,
        reason: `Present in employee tasksheet for ${sessionDate}.`,
      });
      continue;
    }

    // Create entry in this employee's OWN Tasksheet with Task Category set to "Meeting"
    const insRes = insTasksheetStmt.run(
      employeeId,
      meeting.id,
      validatedProjectId,
      sessionDate,
      "Meeting",
      fullTaskDetails,
      totalDurationMinutes,
      commentsContent,
      "MEETING_AUTOMATION"
    );

    createdCount++;
    const newEntryId = Number(insRes.lastInsertRowid);
    void pushTasksheetEntryToExternal(db, newEntryId).catch(() => {});
    console.log(`[TASKSHEET] Created entry in ${employeeName}'s Tasksheet -> Project: ${validatedProjectName}, Effort: ${effortString} (${totalDurationMinutes}m) [Date: ${sessionDate}]`);

    processedParticipants.push({
      employeeId,
      name: employeeName,
      durationMinutes: totalDurationMinutes,
      effortString,
      tasksheetUpdated: true,
    });
  }

  return {
    createdCount,
    processedParticipants,
    status: isReviewRequired ? "REVIEW_REQUIRED" : "PROCESSED",
  };
}
