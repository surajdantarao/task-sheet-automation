export interface ParticipantSessionInput {
  joinedAt: string;
  leftAt: string;
}

/**
 * Calculates total participation duration in minutes for a list of sessions.
 * Overlapping session intervals are merged to avoid double-counting.
 *
 * @param sessions Array of session objects containing joinedAt and leftAt timestamps
 * @returns Total participation duration in minutes
 */
export function calculateParticipantDuration(
  sessions: ParticipantSessionInput[]
): number {
  if (!sessions || sessions.length === 0) {
    return 0;
  }

  // Convert sessions to timestamp intervals [startMs, endMs]
  const intervals: Array<[number, number]> = [];

  for (const session of sessions) {
    const start = new Date(session.joinedAt).getTime();
    const end = new Date(session.leftAt).getTime();

    if (isNaN(start) || isNaN(end) || start >= end) {
      continue;
    }

    intervals.push([start, end]);
  }

  if (intervals.length === 0) {
    return 0;
  }

  // Sort intervals by start time
  intervals.sort((a, b) => a[0] - b[0]);

  // Merge overlapping intervals
  const merged: Array<[number, number]> = [intervals[0]];

  for (let i = 1; i < intervals.length; i++) {
    const current = intervals[i];
    const lastMerged = merged[merged.length - 1];

    if (current[0] <= lastMerged[1]) {
      // Overlap found, merge by updating end time
      lastMerged[1] = Math.max(lastMerged[1], current[1]);
    } else {
      // No overlap, push new interval
      merged.push(current);
    }
  }

  // Sum merged interval durations in minutes
  let totalMs = 0;
  for (const [start, end] of merged) {
    totalMs += end - start;
  }

  return Math.round(totalMs / 60000);
}
