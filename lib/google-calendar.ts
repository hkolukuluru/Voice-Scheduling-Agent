import { google } from "googleapis";

import { getGoogleCalendarEnv } from "@/lib/env";
import {
  type AlternativeSlot,
  type AvailabilityCheckResult,
  type CancelEventRequest,
  type CheckAvailabilityRequest,
  type CreateEventRequest,
  type DayAgendaItem,
  type NormalizedMeetingRequest,
  type RescheduleEventRequest,
  generateCandidateStartTimes,
  formatAlternativeSlot,
  normalizeMeetingRequest,
  overlapsWithBusyWindow,
} from "@/lib/scheduling";

export type CreateCalendarEventInput = CreateEventRequest;
export type CancelCalendarEventInput = CancelEventRequest;
export type RescheduleCalendarEventInput = RescheduleEventRequest;

export type CalendarEventResult = {
  attendeeEmails: string[];
  attendeeName: string;
  id: string;
  htmlLink: string;
  summary: string;
  startIso: string;
  endIso: string;
  timezone: string;
  durationMinutes: number;
};

export type CancelCalendarEventResult = {
  eventId: string;
  notifiedAttendees: boolean;
  status: "cancelled";
  summary: string;
};

export async function checkCalendarAvailability(
  input: CheckAvailabilityRequest,
  options?: {
    ignoreEventId?: string;
  },
): Promise<AvailabilityCheckResult> {
  const normalized = normalizeMeetingRequest(input);
  const calendar = getCalendarClient();
  const normalizedStart = new Date(normalized.startIso);
  const normalizedEnd = new Date(normalized.endIso);
  const busyWindows = await fetchBusyWindows({
    calendar,
    ignoreEventId: options?.ignoreEventId,
    timeMax: normalizedEnd.toISOString(),
    timeMin: normalizedStart.toISOString(),
  });
  const agendaBusyWindows = await fetchBusyWindows({
    calendar,
    ignoreEventId: options?.ignoreEventId,
    ...getDayRange(normalized.startIso),
  });

  if (!busyWindows.length) {
    return {
      alternatives: [],
      dayAgenda: buildDayAgenda({
        busyWindows: agendaBusyWindows,
        normalized,
      }),
      normalizedRequest: normalized,
      status: "free",
    };
  }

  const alternatives = await findAlternativeSlots(calendar, normalized, options);

  return {
    alternatives,
    dayAgenda: buildDayAgenda({
      alternatives,
      busyWindows: agendaBusyWindows,
      normalized,
    }),
    normalizedRequest: normalized,
    status: "busy",
  };
}

export async function createCalendarEvent(
  input: CreateCalendarEventInput,
): Promise<CalendarEventResult> {
  const normalized = normalizeMeetingRequest(input);

  if (input.bookingFingerprint !== normalized.bookingFingerprint) {
    throw new Error("The booking fingerprint did not match the normalized meeting details.");
  }

  const availability = await checkCalendarAvailability(input);

  if (availability.status !== "free") {
    const suggestionText = availability.alternatives.length
      ? ` Try one of these alternatives instead: ${availability.alternatives
          .map((alternative) => alternative.displayText)
          .join(" | ")}`
      : "";

    throw new Error(`The requested time is no longer available.${suggestionText}`);
  }

  const calendar = getCalendarClient();
  const summary = normalized.meetingTitle || `Meeting with ${normalized.attendeeName}`;
  const attendeeEmails = normalized.attendeeEmails;

  const response = await calendar.events.insert({
    calendarId: getGoogleCalendarEnv().GOOGLE_CALENDAR_ID,
    sendUpdates: attendeeEmails.length ? "all" : "none",
    requestBody: {
      summary,
      description: buildEventDescription(normalized),
      start: {
        dateTime: normalized.startIso,
        timeZone: normalized.timezone,
      },
      end: {
        dateTime: normalized.endIso,
        timeZone: normalized.timezone,
      },
      attendees: buildEventAttendees(attendeeEmails),
    },
  });

  return mapCalendarEventResult(response.data, normalized, summary);
}

export async function cancelCalendarEvent(
  input: CancelCalendarEventInput,
): Promise<CancelCalendarEventResult> {
  const calendar = getCalendarClient();
  const existingEvent = await calendar.events.get({
    calendarId: getGoogleCalendarEnv().GOOGLE_CALENDAR_ID,
    eventId: input.eventId,
  });

  await calendar.events.delete({
    calendarId: getGoogleCalendarEnv().GOOGLE_CALENDAR_ID,
    eventId: input.eventId,
    sendUpdates: input.notifyAttendees ? "all" : "none",
  });

  return {
    eventId: input.eventId,
    notifiedAttendees: input.notifyAttendees,
    status: "cancelled",
    summary: existingEvent.data.summary ?? "Calendar event",
  };
}

export async function rescheduleCalendarEvent(
  input: RescheduleCalendarEventInput,
): Promise<CalendarEventResult> {
  const normalized = normalizeMeetingRequest(input);

  if (input.bookingFingerprint !== normalized.bookingFingerprint) {
    throw new Error("The booking fingerprint did not match the normalized meeting details.");
  }

  const availability = await checkCalendarAvailability(input, {
    ignoreEventId: input.eventId,
  });

  if (availability.status !== "free") {
    const suggestionText = availability.alternatives.length
      ? ` Try one of these alternatives instead: ${availability.alternatives
          .map((alternative) => alternative.displayText)
          .join(" | ")}`
      : "";

    throw new Error(`The requested rescheduled time is not available.${suggestionText}`);
  }

  const calendar = getCalendarClient();
  const summary = normalized.meetingTitle || `Meeting with ${normalized.attendeeName}`;

  const response = await calendar.events.patch({
    calendarId: getGoogleCalendarEnv().GOOGLE_CALENDAR_ID,
    eventId: input.eventId,
    sendUpdates: normalized.attendeeEmails.length ? "all" : "none",
    requestBody: {
      summary,
      description: buildEventDescription(normalized),
      start: {
        dateTime: normalized.startIso,
        timeZone: normalized.timezone,
      },
      end: {
        dateTime: normalized.endIso,
        timeZone: normalized.timezone,
      },
      attendees: buildEventAttendees(normalized.attendeeEmails),
    },
  });

  return mapCalendarEventResult(response.data, normalized, summary);
}

function getCalendarClient() {
  const env = getGoogleCalendarEnv();
  const auth = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);

  auth.setCredentials({
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
  });

  return google.calendar({
    version: "v3",
    auth,
  });
}

async function fetchBusyWindows({
  calendar,
  ignoreEventId,
  timeMax,
  timeMin,
}: {
  calendar: ReturnType<typeof google.calendar>;
  ignoreEventId?: string;
  timeMax: string;
  timeMin: string;
}) {
  const env = getGoogleCalendarEnv();
  const busyWindows: Array<{ end: Date; start: Date }> = [];
  let pageToken: string | undefined;

  do {
    const response = await calendar.events.list({
      calendarId: env.GOOGLE_CALENDAR_ID,
      maxResults: 250,
      orderBy: "startTime",
      pageToken,
      showDeleted: false,
      singleEvents: true,
      timeMax,
      timeMin,
    });

    for (const event of response.data.items ?? []) {
      if (event.status === "cancelled" || !event.id || event.id === ignoreEventId) {
        continue;
      }

      const start = parseGoogleEventDate(event.start);
      const end = parseGoogleEventDate(event.end);

      if (!start || !end) {
        continue;
      }

      busyWindows.push({
        end,
        start,
      });
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return busyWindows;
}

async function findAlternativeSlots(
  calendar: ReturnType<typeof google.calendar>,
  normalized: ReturnType<typeof normalizeMeetingRequest>,
  options?: {
    ignoreEventId?: string;
  },
) {
  const requestedStart = new Date(normalized.startIso);
  const candidateStarts = generateCandidateStartTimes(normalized);

  if (!candidateStarts.length) {
    return [];
  }

  const finalCandidate = candidateStarts[candidateStarts.length - 1];
  const searchWindowEnd = new Date(
    finalCandidate.getTime() + normalized.durationMinutes * 60 * 1000,
  );
  const busyWindows = await fetchBusyWindows({
    calendar,
    ignoreEventId: options?.ignoreEventId,
    timeMax: searchWindowEnd.toISOString(),
    timeMin: requestedStart.toISOString(),
  });

  const alternatives: AlternativeSlot[] = [];

  for (const candidateStart of candidateStarts) {
    const candidateEnd = new Date(
      candidateStart.getTime() + normalized.durationMinutes * 60 * 1000,
    );

    if (overlapsWithBusyWindow(candidateStart, candidateEnd, busyWindows)) {
      continue;
    }

    alternatives.push(
      formatAlternativeSlot(candidateStart, normalized.durationMinutes, normalized.timezone),
    );

    if (alternatives.length >= 3) {
      break;
    }
  }

  return alternatives;
}

function buildEventAttendees(attendeeEmails: string[]) {
  return attendeeEmails.length
    ? attendeeEmails.map((email) => ({
        email,
      }))
    : undefined;
}

function buildEventDescription(normalized: NormalizedMeetingRequest) {
  const inviteLine = normalized.attendeeEmails.length
    ? `Invited attendees: ${normalized.attendeeEmails.join(", ")}.`
    : "Invited attendees: none.";

  return [
    "Scheduled by the Voice Scheduling Agent take-home assignment.",
    `Attendee: ${normalized.attendeeName}.`,
    inviteLine,
    `Duration: ${normalized.durationMinutes} minutes.`,
    `Booking fingerprint: ${normalized.bookingFingerprint}.`,
  ].join("\n");
}

function mapCalendarEventResult(
  event: {
    htmlLink?: string | null;
    id?: string | null;
    summary?: string | null;
  },
  normalized: NormalizedMeetingRequest,
  fallbackSummary: string,
): CalendarEventResult {
  return {
    attendeeEmails: normalized.attendeeEmails,
    attendeeName: normalized.attendeeName,
    durationMinutes: normalized.durationMinutes,
    endIso: new Date(normalized.endIso).toISOString(),
    htmlLink: event.htmlLink ?? "",
    id: event.id ?? "",
    startIso: new Date(normalized.startIso).toISOString(),
    summary: event.summary ?? fallbackSummary,
    timezone: normalized.timezone,
  };
}

function parseGoogleEventDate(
  value:
    | {
        date?: string | null;
        dateTime?: string | null;
      }
    | null
    | undefined,
) {
  if (value?.dateTime) {
    const parsed = new Date(value.dateTime);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (value?.date) {
    const parsed = new Date(`${value.date}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function buildDayAgenda(input: {
  alternatives?: AlternativeSlot[];
  busyWindows: Array<{ end: Date; start: Date }>;
  normalized: NormalizedMeetingRequest;
}) {
  const items: DayAgendaItem[] = [
    ...input.busyWindows.map((busyWindow) => ({
      endIso: busyWindow.end.toISOString(),
      label: buildAgendaLabel(busyWindow.start, busyWindow.end, input.normalized.timezone, "Busy"),
      startIso: busyWindow.start.toISOString(),
      status: "busy" as const,
    })),
    {
      endIso: new Date(input.normalized.endIso).toISOString(),
      label: buildAgendaLabel(
        new Date(input.normalized.startIso),
        new Date(input.normalized.endIso),
        input.normalized.timezone,
        "Selected",
      ),
      startIso: new Date(input.normalized.startIso).toISOString(),
      status: "selected" as const,
    },
    ...(input.alternatives ?? []).map((alternative) => ({
      endIso: new Date(alternative.endIso).toISOString(),
      label: buildAgendaLabel(
        new Date(alternative.startIso),
        new Date(alternative.endIso),
        alternative.timezone,
        "Alternative",
      ),
      startIso: new Date(alternative.startIso).toISOString(),
      status: "alternative" as const,
    })),
  ];

  return items
    .sort((left, right) => new Date(left.startIso).getTime() - new Date(right.startIso).getTime())
    .filter((item, index, array) => {
      const duplicateIndex = array.findIndex(
        (entry) => entry.startIso === item.startIso && entry.endIso === item.endIso && entry.status === item.status,
      );

      return duplicateIndex === index;
    });
}

function buildAgendaLabel(start: Date, end: Date, timeZone: string, prefix: string) {
  const startLabel = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(start);
  const endLabel = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(end);

  return `${prefix}: ${startLabel} - ${endLabel}`;
}

function getDayRange(startIso: string) {
  const [datePart, timePartWithOffset] = startIso.split("T");
  const offset = timePartWithOffset?.slice(8) ?? "Z";

  return {
    timeMax: new Date(`${datePart}T23:59:59${offset}`).toISOString(),
    timeMin: new Date(`${datePart}T00:00:00${offset}`).toISOString(),
  };
}
