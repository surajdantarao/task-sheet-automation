export interface ProjectIdentificationResult {
  projectId: string | null;
  projectName: string | null;
  confidence: number;
  reason: string;
}

export interface ProjectDefinition {
  projectId: string;
  projectName: string;
  description?: string;
  keywords: string[];
}

export interface MeetingInputForProject {
  title: string;
  description?: string | null;
}

export const DEMO_PROJECTS: ProjectDefinition[] = [
  {
    projectId: "project-001",
    projectName: "AI Utility Project",
    description: "AI Intern Given Project review",
    keywords: ["AI", "Utility", "Intern", "Automation"],
  }
];

/**
 * Identifies the project associated with a meeting based on title and description metadata.
 * Uses deterministic keyword matching with confidence scoring.
 * 
 * Designed to allow future AI-based fallback services to be integrated seamlessly.
 */
export function identifyProject(
  meeting: MeetingInputForProject,
  projectsList: ProjectDefinition[] = DEMO_PROJECTS
): ProjectIdentificationResult {
  const title = (meeting.title || "").trim();
  const description = (meeting.description || "").trim();

  const titleLower = title.toLowerCase();
  const descLower = description.toLowerCase();

  // 1. First priority: Check Title for matches
  for (const project of projectsList) {
    // Check exact project name or primary keywords in title
    for (const keyword of project.keywords) {
      if (titleLower.includes(keyword.toLowerCase())) {
        return {
          projectId: project.projectId,
          projectName: project.projectName,
          confidence: 0.95,
          reason: `Meeting title contains the project name ("${keyword}").`,
        };
      }
    }
  }

  // 2. Second priority: Check Description for matches
  if (descLower.length > 0) {
    for (const project of projectsList) {
      for (const keyword of project.keywords) {
        if (descLower.includes(keyword.toLowerCase())) {
          return {
            projectId: project.projectId,
            projectName: project.projectName,
            confidence: 0.80,
            reason: `Meeting description contains the project name ("${keyword}").`,
          };
        }
      }
    }
  }

  // 3. Fallback: No confident match found
  return {
    projectId: null,
    projectName: null,
    confidence: 0,
    reason: "No matching project found.",
  };
}
