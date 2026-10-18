import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { calculateParticipantDuration } from "./duration.service";

export interface MeetParticipantSession {
  joinedAt: string;
  leftAt: string;
  durationMinutes: number;
}

export interface MeetingParticipant {
  participantId: string;
  email: string | null;
  displayName: string | null;
  joinedAt: string;
  leftAt: string | null;
  durationMinutes: number;
  sessions: MeetParticipantSession[];
  isStillInCall?: boolean;
}

export interface CalendarAttendeeInput {
  email?: string | null;
  displayName?: string | null;
}

/**
 * Extracts Google Meet code or space name from a Meet URL or conference ID string.
 * Example: "https://meet.google.com/abc-defg-hij" -> "abc-defg-hij"
 */
export function extractMeetingCode(meetLinkOrCode: string | null): string | null {
  if (!meetLinkOrCode) return null;
  
  // Clean trailing slashes or URL query params
  const clean = meetLinkOrCode.split("?")[0].trim().replace(/\/+$/, "");
  const parts = clean.split("/");
  const code = parts[parts.length - 1];

  // Meet codes typically have format abc-defg-hij or abcdefghij
  if (code && code.replace(/-/g, "").length >= 9) {
    return code;
  }
  return null;
}

/**
 * Calculates a match score between a participant's displayName/identity and a candidate attendee.
 * Handles discriminators for similar names (e.g. "suraj Dantrao" vs "personal suraj" vs "Suraj WhiteCode").
 */
export function scoreAttendeeMatch(
  displayName: string | null,
  attendee: CalendarAttendeeInput
): number {
  if (!displayName) return 0;

  const attEmail = (attendee.email || "").toLowerCase();
  const attPrefix = attEmail.split("@")[0] || "";
  const attName = (attendee.displayName || "").toLowerCase();
  const dispLower = displayName.toLowerCase().trim();
  const dispClean = dispLower.replace(/[^a-z0-9]/g, "");

  // 1. Exact email match
  if (dispLower.includes("@") && attEmail && dispLower === attEmail) {
    return 10000;
  }

  // 2. Exact display name match
  if (attName && dispLower === attName) {
    return 5000;
  }

  // 3. Compact string match (e.g. "surajdantrao" matches "surajdantrao123")
  const attClean = attName.replace(/[^a-z0-9]/g, "");
  const prefixClean = attPrefix.replace(/[^a-z0-9]/g, "");
  if (dispClean.length >= 4) {
    if (prefixClean === dispClean || attClean === dispClean) {
      return 4500;
    }
    if (prefixClean.startsWith(dispClean) || dispClean.startsWith(prefixClean)) {
      return 4000;
    }
  }

  // 4. Token-level analysis with dynamic discriminator scoring
  const tokens = dispLower.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return 0;

  const attTokens = `${attPrefix} ${attName}`.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

  let score = 0;
  let matchesCount = 0;

  for (const token of tokens) {
    // Check if token matches or prefix-matches any token in attendee identity
    const exactMatch = attTokens.some((at) => at === token);
    const substringMatch = !exactMatch && (attPrefix.includes(token) || attName.includes(token));

    if (exactMatch) {
      matchesCount++;
      // Distinctive token (>= 5 chars or numbers included) gets higher confidence
      const isDistinctive = token.length >= 5 || /[0-9]/.test(token);
      score += isDistinctive ? 2000 : 500;
    } else if (substringMatch) {
      matchesCount++;
      score += token.length >= 4 ? 400 : 200;
    } else {
      // If token is distinctive (>= 5 chars) and completely absent, apply penalty
      if (token.length >= 5) {
        score -= 1000;
      } else if (token.length >= 4) {
        score -= 300;
      }
    }
  }

  // Bonus when all tokens in display name match the attendee
  if (matchesCount === tokens.length && tokens.length > 1) {
    score += 1000;
  }

  return score;
}

/**
 * Maps Google Meet participant identity to Calendar attendee email using a flexible mapping layer.
 */
export function mapParticipantToAttendee(
  displayName: string | null,
  userRef: string | null,
  calendarAttendees: CalendarAttendeeInput[]
): { email: string | null; displayName: string | null } {
  if (!calendarAttendees || calendarAttendees.length === 0) {
    return { email: null, displayName };
  }

  // 1. Exact match on email if displayName is an email
  if (displayName && displayName.includes("@")) {
    const matched = calendarAttendees.find(
      (a) => a.email?.toLowerCase() === displayName.toLowerCase()
    );
    if (matched) {
      return { email: matched.email || null, displayName: matched.displayName || displayName };
    }
  }

  // 2. Exact match on Display Name
  if (displayName) {
    const matchedByName = calendarAttendees.find(
      (a) =>
        (a.displayName && a.displayName.toLowerCase() === displayName.toLowerCase()) ||
        (a.email && a.email.split("@")[0].toLowerCase() === displayName.toLowerCase())
    );
    if (matchedByName) {
      return { email: matchedByName.email || null, displayName: matchedByName.displayName || displayName };
    }
  }

  // 3. Ranked specificity scoring across all calendar attendees
  let bestAttendee: CalendarAttendeeInput | null = null;
  let bestScore = 0;

  for (const att of calendarAttendees) {
    const score = scoreAttendeeMatch(displayName, att);
    if (score > bestScore) {
      bestScore = score;
      bestAttendee = att;
    }
  }

  if (bestAttendee && bestScore > 50) {
    return {
      email: bestAttendee.email || null,
      displayName: bestAttendee.displayName || displayName,
    };
  }

  return { email: null, displayName };
}

/**
 * Fetches actual Google Meet conference records, participants, and participant sessions using Google Meet REST API v2.
 */
export async function getActualMeetParticipants(
  oauth2Client: OAuth2Client,
  meetLink: string | null,
  calendarAttendees: CalendarAttendeeInput[] = [],
  silent: boolean = false
): Promise<{ conferenceRecordId: string | null; participants: MeetingParticipant[]; isEnded: boolean }> {
  if (!silent) console.log(`[MEET] Finding conference for Meet link: ${meetLink ?? "N/A"}`);

  const meetingCode = extractMeetingCode(meetLink);
  if (!meetingCode) {
    if (!silent) console.log("[MEET] No valid Google Meet code could be extracted.");
    return { conferenceRecordId: null, participants: [], isEnded: false };
  }

  const meet = google.meet({ version: "v2", auth: oauth2Client });

  try {
    // Search conference records matching the space
    let conferenceRecordName: string | null = null;
    let isConferenceEnded = false;

    if (!silent) console.log(`[MEET] Querying conference records for meeting code: ${meetingCode}`);
    
    // 1. Query conference records by the Meet code. This is the stable API filter
    // for links such as https://meet.google.com/abc-defg-hij.
    let listRes = await meet.conferenceRecords.list({
      filter: `space.meeting_code = "${meetingCode}"`,
    }).catch(() => null);

    let records = listRes?.data?.conferenceRecords || [];

    // 2. Fallback: try the resource-name filter for older API responses.
    if (records.length === 0) {
      listRes = await meet.conferenceRecords.list({
        filter: `space.name = "spaces/${meetingCode}"`,
      }).catch(() => null);
      records = listRes?.data?.conferenceRecords || [];
    }

    // 3. Fallback: try code without dashes
    if (records.length === 0 && meetingCode.includes("-")) {
      const codeNoDash = meetingCode.replace(/-/g, "");
      listRes = await meet.conferenceRecords.list({
        filter: `space.meeting_code = "${codeNoDash}"`,
      }).catch(() => null);
      records = listRes?.data?.conferenceRecords || [];
    }

    if (records.length > 0) {
      // Prioritize active (ongoing, no endTime) conference records first, then newest startTime
      records.sort((a: any, b: any) => {
        const aOngoing = !a.endTime;
        const bOngoing = !b.endTime;
        if (aOngoing && !bOngoing) return -1;
        if (!aOngoing && bOngoing) return 1;
        const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
        const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
        return bTime - aTime;
      });

      // Pick the most relevant conference record matching this space
      conferenceRecordName = records[0].name || null;
      isConferenceEnded = !!records[0].endTime;
      if (!silent) console.log(`[MEET] Conference found for code ${meetingCode}: ${conferenceRecordName} (Call Ended: ${isConferenceEnded})`);
    }

    if (!conferenceRecordName) {
      if (!silent) console.log(`[MEET] No conference record found for meeting code '${meetingCode}'. (Call not started or no session recorded yet).`);
      return { conferenceRecordId: null, participants: [], isEnded: false };
    }

    // Retrieve actual participants for this conference record with pagination handling
    if (!silent) console.log(`[MEET] Fetching participants for conference: ${conferenceRecordName}`);
    
    let rawParticipants: any[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const participantsRes: any = await meet.conferenceRecords.participants.list({
        parent: conferenceRecordName,
        pageToken,
      });
      const pageParts = participantsRes.data?.participants || [];
      rawParticipants.push(...pageParts);
      pageToken = participantsRes.data?.nextPageToken || undefined;
    } while (pageToken);

    if (!silent) console.log(`[MEET] Actual participants found: ${rawParticipants.length}`);

    const resultParticipants: MeetingParticipant[] = [];

    for (const rawP of rawParticipants) {
      const participantId = rawP.name || `participant-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

      // Extract display name & identity reference
      let displayName: string | null = null;
      let userRef: string | null = null;

      if (rawP.signedinUser) {
        displayName = rawP.signedinUser.displayName || null;
        userRef = rawP.signedinUser.user || null;
      } else if (rawP.anonymousUser) {
        displayName = rawP.anonymousUser.displayName || "Anonymous User";
      } else if (rawP.phoneUser) {
        displayName = rawP.phoneUser.displayName || "Phone User";
      }

      // Map participant identity to email/calendar attendees
      const mappedIdentity = mapParticipantToAttendee(displayName, userRef, calendarAttendees);

      // Fetch participant sessions with pagination handling
      let rawSessions: any[] = [];
      let sessPageToken: string | undefined = undefined;

      try {
        do {
          const sessionsRes: any = await meet.conferenceRecords.participants.participantSessions.list({
            parent: rawP.name!,
            pageToken: sessPageToken,
          });
          const pageSess = sessionsRes.data?.participantSessions || [];
          rawSessions.push(...pageSess);
          sessPageToken = sessionsRes.data?.nextPageToken || undefined;
        } while (sessPageToken);
      } catch (sessErr: any) {
        if (!silent) console.log(`[MEET] Participant session unavailable for ${rawP.name}: ${sessErr?.message}`);
      }

      // Determine if this participant is STILL CURRENTLY in the call
      const hasOngoingSession = rawSessions.length > 0 && rawSessions.some((s: any) => !s.endTime);
      const isStillInCall = hasOngoingSession || (!rawP.latestEndTime && !isConferenceEnded);

      const sessions: MeetParticipantSession[] = [];
      let overallEarliest: string | null = rawP.earliestStartTime || records[0]?.startTime || null;
      let overallLatest: string | null = rawP.latestEndTime || records[0]?.endTime || null;

      for (const s of rawSessions) {
        const joinedAt = s.startTime || overallEarliest;
        // Only consider leftAt if session actually ended (s.endTime exists or participant left)
        const leftAt = s.endTime || (isConferenceEnded ? rawP.latestEndTime || records[0]?.endTime : null);

        if (joinedAt && leftAt) {
          const startMs = new Date(joinedAt).getTime();
          const endMs = new Date(leftAt).getTime();
          const durationMinutes = Math.max(0, Math.round((endMs - startMs) / 60000));

          if (durationMinutes > 0) {
            sessions.push({
              joinedAt,
              leftAt,
              durationMinutes,
            });
          }

          if (!overallEarliest || startMs < new Date(overallEarliest).getTime()) {
            overallEarliest = joinedAt;
          }
          if (!overallLatest || endMs > new Date(overallLatest).getTime()) {
            overallLatest = leftAt;
          }
        }
      }

      // If no discrete sessions returned but participant has completed and left call
      if (sessions.length === 0 && !isStillInCall && overallEarliest && overallLatest) {
        const startMs = new Date(overallEarliest).getTime();
        const endMs = new Date(overallLatest).getTime();
        const durationMinutes = Math.max(0, Math.round((endMs - startMs) / 60000));
        if (durationMinutes > 0) {
          sessions.push({
            joinedAt: overallEarliest,
            leftAt: overallLatest,
            durationMinutes,
          });
        }
      }

      // If participant is still in the call, their duration is NOT finalized yet (set to 0 mins until they leave)
      const totalDurationMinutes = isStillInCall ? 0 : calculateParticipantDuration(sessions);
      const joinedAt = sessions[0]?.joinedAt || overallEarliest || new Date().toISOString();
      const leftAt = isStillInCall ? null : (sessions[sessions.length - 1]?.leftAt || overallLatest || null);

      resultParticipants.push({
        participantId,
        email: mappedIdentity.email,
        displayName: mappedIdentity.displayName || displayName,
        joinedAt,
        leftAt,
        durationMinutes: totalDurationMinutes,
        sessions,
        isStillInCall,
      });

      if (isStillInCall) {
        if (!silent) console.log(`[PARTICIPANT] ${mappedIdentity.displayName || displayName || "Unknown"} is STILL IN CALL (active). Tasksheet will be created when they leave.`);
      } else {
        if (!silent) console.log(`[PARTICIPANT] ${mappedIdentity.displayName || displayName || "Unknown"} has LEFT CALL -> ${totalDurationMinutes} minutes`);
      }
    }

    return {
      conferenceRecordId: conferenceRecordName,
      participants: resultParticipants,
      isEnded: isConferenceEnded,
    };
  } catch (error: any) {
    console.error(`[MEET] Google Meet API error: ${error?.message || error}`);
    return { conferenceRecordId: null, participants: [], isEnded: false };
  }
}
