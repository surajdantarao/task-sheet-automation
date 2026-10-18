import Database from "better-sqlite3";
import { formatMinutesToEffortString } from "./tasksheet.service";

export interface ExternalSyncConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  employeesEndpoint: string;
  projectsEndpoint: string;
  tasksheetEndpoint: string;
}

export function getExternalSyncConfig(): ExternalSyncConfig {
  return {
    enabled: process.env.EXTERNAL_SYNC_ENABLED === "true",
    baseUrl: (process.env.EXTERNAL_TASKSHEET_API_BASE_URL || "https://api.whitecodelabs.com").replace(/\/+$/, ""),
    apiKey: process.env.EXTERNAL_TASKSHEET_API_KEY || "",
    employeesEndpoint: process.env.EXTERNAL_EMPLOYEES_ENDPOINT || "/api/employees",
    projectsEndpoint: process.env.EXTERNAL_PROJECTS_ENDPOINT || "/api/projects",
    tasksheetEndpoint: process.env.EXTERNAL_TASKSHEET_ENDPOINT || "/api/tasksheet/entries",
  };
}

export function ensureSyncTablesExist(db: Database.Database): void {
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
}

/**
 * Syncs employees from the external WhiteCode Tasksheet / HR REST API into SQLite.
 */
export async function syncEmployeesFromExternal(
  db: Database.Database,
  overrideConfig?: Partial<ExternalSyncConfig>
): Promise<{ syncedCount: number; error?: string }> {
  ensureSyncTablesExist(db);
  const config = { ...getExternalSyncConfig(), ...overrideConfig };

  if (!config.enabled) {
    console.log("[EXTERNAL_SYNC] External sync is disabled (EXTERNAL_SYNC_ENABLED=false). Using local database.");
    return { syncedCount: 0, error: "External sync is disabled." };
  }

  const url = `${config.baseUrl}${config.employeesEndpoint.startsWith("/") ? "" : "/"}${config.employeesEndpoint}`;
  console.log(`[EXTERNAL_SYNC] Fetching employees from external API: ${url}`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
        "x-api-key": config.apiKey,
      },
    });

    if (!response.ok) {
      const msg = `External API returned status ${response.status}: ${response.statusText}`;
      console.error(`[EXTERNAL_SYNC] Failed to fetch employees: ${msg}`);
      return { syncedCount: 0, error: msg };
    }

    const data: any = await response.json();
    const employeesList: any[] = Array.isArray(data) ? data : (data.employees || data.data || []);

    if (!Array.isArray(employeesList)) {
      return { syncedCount: 0, error: "Unexpected API response format: expected array of employees." };
    }

    const upsertStmt = db.prepare(`
      INSERT INTO employees (employee_id, name, email, active)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(employee_id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        active = excluded.active,
        updated_at = CURRENT_TIMESTAMP
    `);

    let count = 0;
    const insertTransaction = db.transaction((list: any[]) => {
      for (const emp of list) {
        const empId = emp.employeeId || emp.employee_id || emp.id;
        const name = emp.name || emp.displayName || emp.full_name;
        const email = (emp.email || "").toLowerCase().trim();
        const active = emp.active === undefined || emp.active === true || emp.active === 1 ? 1 : 0;

        if (empId && name && email) {
          upsertStmt.run(String(empId), name, email, active);
          count++;

          // Auto-register aliases if provided in employee payload
          if (Array.isArray(emp.aliases)) {
            for (const alias of emp.aliases) {
              addEmployeeEmailAlias(db, String(empId), alias);
            }
          }
        }
      }
    });

    insertTransaction(employeesList);
    console.log(`[EXTERNAL_SYNC] Successfully synced ${count} employees from external WhiteCode API.`);
    return { syncedCount: count };
  } catch (err: any) {
    console.error(`[EXTERNAL_SYNC] Network or parsing error syncing employees: ${err?.message || err}`);
    return { syncedCount: 0, error: err?.message || String(err) };
  }
}

/**
 * Syncs projects from the external WhiteCode Tasksheet REST API into SQLite.
 */
export async function syncProjectsFromExternal(
  db: Database.Database,
  overrideConfig?: Partial<ExternalSyncConfig>
): Promise<{ syncedCount: number; error?: string }> {
  const config = { ...getExternalSyncConfig(), ...overrideConfig };

  if (!config.enabled) {
    return { syncedCount: 0, error: "External sync is disabled." };
  }

  const url = `${config.baseUrl}${config.projectsEndpoint.startsWith("/") ? "" : "/"}${config.projectsEndpoint}`;
  console.log(`[EXTERNAL_SYNC] Fetching projects from external API: ${url}`);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
        "x-api-key": config.apiKey,
      },
    });

    if (!response.ok) {
      const msg = `External API returned status ${response.status}: ${response.statusText}`;
      console.error(`[EXTERNAL_SYNC] Failed to fetch projects: ${msg}`);
      return { syncedCount: 0, error: msg };
    }

    const data: any = await response.json();
    const projectsList: any[] = Array.isArray(data) ? data : (data.projects || data.data || []);

    if (!Array.isArray(projectsList)) {
      return { syncedCount: 0, error: "Unexpected API response format: expected array of projects." };
    }

    const upsertStmt = db.prepare(`
      INSERT INTO projects (project_id, project_name, description, active)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        project_name = excluded.project_name,
        description = excluded.description,
        active = excluded.active,
        updated_at = CURRENT_TIMESTAMP
    `);

    let count = 0;
    const insertTransaction = db.transaction((list: any[]) => {
      for (const proj of list) {
        const projId = proj.projectId || proj.project_id || proj.id;
        const name = proj.projectName || proj.project_name || proj.name;
        const desc = proj.description || "";
        const active = proj.active === undefined || proj.active === true || proj.active === 1 ? 1 : 0;

        if (projId && name) {
          upsertStmt.run(String(projId), name, desc, active);
          count++;
        }
      }
    });

    insertTransaction(projectsList);
    console.log(`[EXTERNAL_SYNC] Successfully synced ${count} projects from external WhiteCode API.`);
    return { syncedCount: count };
  } catch (err: any) {
    console.error(`[EXTERNAL_SYNC] Error syncing projects from external API: ${err?.message || err}`);
    return { syncedCount: 0, error: err?.message || String(err) };
  }
}

/**
 * Pushes a finalized Tasksheet entry to the external WhiteCode Tasksheet REST API.
 */
export async function pushTasksheetEntryToExternal(
  db: Database.Database,
  entryId: number,
  overrideConfig?: Partial<ExternalSyncConfig>
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  ensureSyncTablesExist(db);
  const config = { ...getExternalSyncConfig(), ...overrideConfig };

  const entry = db.prepare(`
    SELECT 
      te.*,
      e.email AS employee_email,
      e.name AS employee_name,
      p.project_name
    FROM tasksheet_entries te
    JOIN employees e ON te.employee_id = e.employee_id
    JOIN projects p ON te.project_id = p.project_id
    WHERE te.id = ?
  `).get(entryId) as any;

  if (!entry) {
    return { success: false, error: `Tasksheet entry #${entryId} not found.` };
  }

  // If external sync is not enabled, mark as LOCAL_SAVED
  if (!config.enabled) {
    db.prepare(`
      UPDATE tasksheet_entries 
      SET sync_status = 'LOCAL_SAVED', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(entryId);
    return { success: true, externalId: `local-${entryId}` };
  }

  const url = `${config.baseUrl}${config.tasksheetEndpoint.startsWith("/") ? "" : "/"}${config.tasksheetEndpoint}`;

  const payload = {
    employeeId: entry.employee_id,
    employeeName: entry.employee_name,
    employeeEmail: entry.employee_email,
    projectId: entry.project_id,
    projectName: entry.project_name,
    date: entry.date,
    taskCategory: entry.task_category || "Meeting",
    taskDetails: entry.task_details,
    effortMinutes: entry.effort_minutes,
    totalEfforts: formatMinutesToEffortString(entry.effort_minutes),
    comments: entry.comments || "Meeting",
    meetingId: entry.meeting_id,
    source: entry.source || "MEETING_AUTOMATION",
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const msg = `External push failed with HTTP ${response.status}: ${errText || response.statusText}`;
      console.warn(`[EXTERNAL_SYNC] Push failed for entry #${entryId}: ${msg}`);
      db.prepare(`
        UPDATE tasksheet_entries 
        SET sync_status = 'FAILED', updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(entryId);
      return { success: false, error: msg };
    }

    let externalId: string = `ext-${Date.now()}`;
    try {
      const resJson: any = await response.json();
      externalId = resJson.id || resJson.entryId || resJson.entry_id || externalId;
    } catch {}

    db.prepare(`
      UPDATE tasksheet_entries
      SET sync_status = 'SYNCED',
          external_entry_id = ?,
          synced_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(String(externalId), entryId);

    console.log(`[EXTERNAL_SYNC] Tasksheet entry #${entryId} pushed to WhiteCode API successfully. (External ID: ${externalId})`);
    return { success: true, externalId };
  } catch (err: any) {
    const msg = `Network error pushing entry #${entryId}: ${err?.message || err}`;
    console.error(`[EXTERNAL_SYNC] ${msg}`);
    db.prepare(`
      UPDATE tasksheet_entries 
      SET sync_status = 'FAILED', updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(entryId);
    return { success: false, error: msg };
  }
}

/**
 * Retries all PENDING or FAILED tasksheet entries.
 */
export async function retryPendingTasksheetSyncs(
  db: Database.Database,
  overrideConfig?: Partial<ExternalSyncConfig>
): Promise<{ processedCount: number; successCount: number }> {
  const pendingEntries = db.prepare(`
    SELECT id FROM tasksheet_entries
    WHERE sync_status IN ('PENDING', 'FAILED')
    ORDER BY id ASC
    LIMIT 50
  `).all() as any[];

  if (pendingEntries.length === 0) {
    return { processedCount: 0, successCount: 0 };
  }

  console.log(`[EXTERNAL_SYNC] Retrying ${pendingEntries.length} pending/failed tasksheet entries...`);
  let successCount = 0;

  for (const item of pendingEntries) {
    const res = await pushTasksheetEntryToExternal(db, item.id, overrideConfig);
    if (res.success) {
      successCount++;
    }
  }

  return { processedCount: pendingEntries.length, successCount };
}

// ---------------------------------------------------------------------------
// Employee Personal Email Alias Management (Mapping personal Gmails to Official emails)
// ---------------------------------------------------------------------------

/**
 * Adds or updates an email alias linking a personal Google/Gmail account to an official WhiteCode employee.
 */
export function addEmployeeEmailAlias(
  db: Database.Database,
  employeeId: string,
  aliasEmail: string,
  aliasName?: string | null
): boolean {
  ensureSyncTablesExist(db);
  if (!employeeId || !aliasEmail) return false;
  const cleanAlias = aliasEmail.toLowerCase().trim();

  // Verify employee exists
  const emp = db.prepare("SELECT employee_id FROM employees WHERE employee_id = ?").get(employeeId);
  if (!emp) {
    console.warn(`[ALIAS] Cannot add alias '${aliasEmail}': Employee '${employeeId}' does not exist.`);
    return false;
  }

  db.prepare(`
    INSERT INTO employee_email_aliases (employee_id, alias_email, alias_name)
    VALUES (?, ?, ?)
    ON CONFLICT(alias_email) DO UPDATE SET
      employee_id = excluded.employee_id,
      alias_name = excluded.alias_name
  `).run(employeeId, cleanAlias, aliasName || null);

  console.log(`[ALIAS] Mapped personal Google email '${cleanAlias}' -> WhiteCode Employee '${employeeId}'`);
  return true;
}

/**
 * Removes an email alias.
 */
export function removeEmployeeEmailAlias(
  db: Database.Database,
  aliasEmail: string
): boolean {
  const res = db.prepare("DELETE FROM employee_email_aliases WHERE alias_email = ?").run(aliasEmail.toLowerCase().trim());
  return res.changes > 0;
}

/**
 * Retrieves all registered email aliases, optionally filtered by employee ID.
 */
export function getEmployeeEmailAliases(
  db: Database.Database,
  employeeId?: string
): any[] {
  if (employeeId) {
    return db.prepare(`
      SELECT a.*, e.name AS employee_name, e.email AS official_email
      FROM employee_email_aliases a
      JOIN employees e ON a.employee_id = e.employee_id
      WHERE a.employee_id = ?
      ORDER BY a.created_at DESC
    `).all(employeeId);
  }

  return db.prepare(`
    SELECT a.*, e.name AS employee_name, e.email AS official_email
    FROM employee_email_aliases a
    JOIN employees e ON a.employee_id = e.employee_id
    ORDER BY a.employee_id ASC, a.created_at DESC
  `).all();
}

/**
 * Finds an employee by searching both official email and personal Google aliases.
 */
export function findEmployeeByAlias(
  db: Database.Database,
  email: string | null
): any | null {
  if (!email) return null;
  const clean = email.toLowerCase().trim();

  const aliasRecord = db.prepare(`
    SELECT e.*
    FROM employee_email_aliases a
    JOIN employees e ON a.employee_id = e.employee_id
    WHERE LOWER(a.alias_email) = ?
  `).get(clean) as any;

  return aliasRecord || null;
}
