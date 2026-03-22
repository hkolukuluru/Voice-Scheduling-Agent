import { createHash } from "crypto";

import * as chrono from "chrono-node";
import { z } from "zod";

import { getAppConfig } from "@/lib/env";

const attendeeEmailListSchema = z
  .array(z.string().trim().email("Each attendee email must be valid."))
  .optional()
  .default([]);

const durationMinutesSchema = z.coerce.number().int().min(15).max(180).optional();

const normalizedMeetingSchema = z.object({
  attendeeName: z.string().trim().min(1, "attendeeName is required."),
  attendeeEmails: attendeeEmailListSchema,
  startIso: z.string().trim().min(1, "startIso is required."),
  timezone: z.string().trim().optional(),
  meetingTitle: z.string().trim().optional(),
  durationMinutes: durationMinutesSchema,
});

export const normalizeMeetingRequestSchema = z.object({
  attendeeName: z.string().trim().min(1, "attendeeName is required."),
  attendeeEmails: attendeeEmailListSchema,
  preferredDate: z.string().trim().min(1, "preferredDate is required."),
  preferredTime: z.string().trim().optional(),
  timezone: z.string().trim().optional(),
  meetingTitle: z.string().trim().optional(),
  durationMinutes: durationMinutesSchema,
});

export const checkAvailabilityRequestSchema = normalizedMeetingSchema;

export const createEventRequestSchema = normalizedMeetingSchema.extend({
  bookingFingerprint: z.string().trim().min(8, "bookingFingerprint is required."),
});

export const cancelEventRequestSchema = z.object({
  eventId: z.string().trim().min(1, "eventId is required."),
  notifyAttendees: z.boolean().optional().default(false),
});

export const rescheduleEventRequestSchema = normalizedMeetingSchema.extend({
  bookingFingerprint: z.string().trim().min(8, "bookingFingerprint is required."),
  eventId: z.string().trim().min(1, "eventId is required."),
});

export type NormalizeMeetingRequest = z.infer<typeof normalizeMeetingRequestSchema>;
export type CheckAvailabilityRequest = z.infer<typeof checkAvailabilityRequestSchema>;
export type CreateEventRequest = z.infer<typeof createEventRequestSchema>;
export type CancelEventRequest = z.infer<typeof cancelEventRequestSchema>;
export type RescheduleEventRequest = z.infer<typeof rescheduleEventRequestSchema>;

export type AvailabilityStatus = "free" | "busy";

export type AlternativeSlot = {
  displayText: string;
  endIso: string;
  startIso: string;
  timezone: string;
};

export type DayAgendaItem = {
  endIso: string;
  label: string;
  startIso: string;
  status: "alternative" | "busy" | "selected";
};

export type NormalizedMeetingRequest = {
  attendeeName: string;
  attendeeEmails: string[];
  bookingFingerprint: string;
  durationMinutes: number;
  endIso: string;
  localDateLabel: string;
  localTimeLabel: string;
  meetingTitle?: string;
  parsedDateTimeText: string;
  preferredDate: string;
  preferredTime?: string;
  startIso: string;
  summaryLine: string;
  timezone: string;
  warnings: string[];
};

export type MeetingNormalizationResult = {
  normalizedRequest: NormalizedMeetingRequest;
  rawInput: {
    combinedDateTimeText: string;
    preferredDate: string;
    preferredTime?: string;
  };
};

export type AvailabilityCheckResult = {
  alternatives: AlternativeSlot[];
  dayAgenda: DayAgendaItem[];
  normalizedRequest: NormalizedMeetingRequest;
  status: AvailabilityStatus;
};

export function normalizeNaturalLanguageMeetingRequest(
  input: NormalizeMeetingRequest,
): MeetingNormalizationResult {
  const { NEXT_PUBLIC_DEFAULT_TIMEZONE } = getAppConfig();
  const timezone = normalizeTimeZone(input.timezone?.trim() || NEXT_PUBLIC_DEFAULT_TIMEZONE);
  const preferredDate = input.preferredDate.trim();
  const preferredTime = input.preferredTime?.trim() || undefined;
  const combinedDateTimeText = buildCombinedDateTimeText(preferredDate, preferredTime);

  if (preferredTime && looksAmbiguousClockTime(preferredTime)) {
    throw new Error("Please specify the meeting time with AM/PM or a 24-hour time.");
  }

  const referenceInstant = new Date();
  const parsedResults = chrono.parse(
    combinedDateTimeText,
    {
      instant: referenceInstant,
      timezone: getTimeZoneOffsetMinutes(referenceInstant, timezone),
    },
    {
      forwardDate: true,
    },
  );
  const parsedResult = parsedResults[0];

  if (!parsedResult) {
    throw new Error("I could not parse the requested meeting date and time.");
  }

  if (!parsedResult.start.isCertain("hour")) {
    throw new Error("Please provide a specific meeting time.");
  }

  const year = parsedResult.start.get("year");
  const month = parsedResult.start.get("month");
  const day = parsedResult.start.get("day");
  const hour = parsedResult.start.get("hour");
  const minute = parsedResult.start.get("minute") ?? 0;
  const second = parsedResult.start.get("second") ?? 0;

  if (
    year === null ||
    month === null ||
    day === null ||
    hour === null ||
    minute === null ||
    second === null
  ) {
    throw new Error("I could not determine the full meeting date and time.");
  }

  const start = zonedDateTimeToUtc(
    {
      day,
      hour,
      minute,
      month,
      second,
      year,
    },
    timezone,
  );

  const normalizedRequest = buildNormalizedMeetingRequest({
    attendeeName: normalizeAttendeeName(input.attendeeName),
    attendeeEmails: input.attendeeEmails ?? [],
    durationMinutes: clampDuration(input.durationMinutes ?? 30),
    meetingTitle: input.meetingTitle?.trim() || undefined,
    parsedDateTimeText: parsedResult.text,
    preferredDate,
    preferredTime,
    start,
    timezone,
  });

  return {
    normalizedRequest,
    rawInput: {
      combinedDateTimeText,
      preferredDate,
      preferredTime,
    },
  };
}

export function normalizeMeetingRequest(
  input: CheckAvailabilityRequest | CreateEventRequest,
): NormalizedMeetingRequest {
  const { NEXT_PUBLIC_DEFAULT_TIMEZONE } = getAppConfig();
  const timezone = normalizeTimeZone(input.timezone?.trim() || NEXT_PUBLIC_DEFAULT_TIMEZONE);
  const start = new Date(input.startIso);

  if (Number.isNaN(start.getTime())) {
    throw new Error("startIso must be a valid ISO 8601 datetime string.");
  }

  return buildNormalizedMeetingRequest({
    attendeeName: normalizeAttendeeName(input.attendeeName),
    attendeeEmails: input.attendeeEmails ?? [],
    durationMinutes: clampDuration(input.durationMinutes ?? 30),
    meetingTitle: input.meetingTitle?.trim() || undefined,
    parsedDateTimeText: input.startIso,
    start,
    timezone,
  });
}

export function generateCandidateStartTimes(
  normalized: NormalizedMeetingRequest,
  options?: {
    maxCandidates?: number;
    searchWindowDays?: number;
  },
) {
  const start = new Date(normalized.startIso);
  const candidates: Date[] = [];
  const maxCandidates = options?.maxCandidates ?? 80;
  const searchWindowDays = options?.searchWindowDays ?? 5;
  const now = Date.now();
  let cursor = start.getTime() + 30 * 60 * 1000;
  const endBoundary = start.getTime() + searchWindowDays * 24 * 60 * 60 * 1000;

  while (cursor <= endBoundary && candidates.length < maxCandidates) {
    const candidateStart = new Date(cursor);
    const candidateEnd = new Date(cursor + normalized.durationMinutes * 60 * 1000);

    if (
      candidateStart.getTime() >= now + 5 * 60 * 1000 &&
      isWithinBusinessHours(candidateStart, candidateEnd, normalized.timezone)
    ) {
      candidates.push(candidateStart);
    }

    cursor += 30 * 60 * 1000;
  }

  return candidates;
}

export function formatAlternativeSlot(
  start: Date,
  durationMinutes: number,
  timezone: string,
): AlternativeSlot {
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const displayText = `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone,
  }).format(start)} for ${durationMinutes} minutes`;

  return {
    displayText,
    endIso: formatIsoWithOffset(end, timezone),
    startIso: formatIsoWithOffset(start, timezone),
    timezone,
  };
}

export function overlapsWithBusyWindow(
  start: Date,
  end: Date,
  busyWindows: Array<{ end: Date; start: Date }>,
) {
  return busyWindows.some((busyWindow) => start < busyWindow.end && end > busyWindow.start);
}

function buildNormalizedMeetingRequest(input: {
  attendeeName: string;
  attendeeEmails: string[];
  durationMinutes: number;
  meetingTitle?: string;
  parsedDateTimeText: string;
  preferredDate?: string;
  preferredTime?: string;
  start: Date;
  timezone: string;
}) {
  if (input.start.getTime() < Date.now() + 5 * 60 * 1000) {
    throw new Error("The requested meeting time must be at least 5 minutes in the future.");
  }

  const end = new Date(input.start.getTime() + input.durationMinutes * 60 * 1000);
  const warnings: string[] = [];

  if (!isWithinBusinessHours(input.start, end, input.timezone)) {
    warnings.push(
      "The requested time falls outside the demo's preferred 8:00 AM to 6:00 PM local working hours.",
    );
  }

  const localDateLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeZone: input.timezone,
  }).format(input.start);

  const startTime = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: input.timezone,
  }).format(input.start);

  const endTime = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: input.timezone,
  }).format(end);

  const startIso = formatIsoWithOffset(input.start, input.timezone);
  const endIso = formatIsoWithOffset(end, input.timezone);
  const attendeeEmails = dedupeEmails(input.attendeeEmails);
  const inviteSummary = attendeeEmails.length
    ? ` with ${attendeeEmails.length} invited attendee${attendeeEmails.length === 1 ? "" : "s"}`
    : "";

  return {
    attendeeName: input.attendeeName,
    attendeeEmails,
    bookingFingerprint: createBookingFingerprint({
      attendeeName: input.attendeeName,
      attendeeEmails,
      durationMinutes: input.durationMinutes,
      meetingTitle: input.meetingTitle,
      startIso,
      timezone: input.timezone,
    }),
    durationMinutes: input.durationMinutes,
    endIso,
    localDateLabel,
    localTimeLabel: `${startTime} to ${endTime}`,
    meetingTitle: input.meetingTitle,
    parsedDateTimeText: input.parsedDateTimeText,
    preferredDate: input.preferredDate ?? localDateLabel,
    preferredTime: input.preferredTime,
    startIso,
    summaryLine: `${input.meetingTitle || `Meeting with ${input.attendeeName}`} on ${localDateLabel} at ${startTime} (${input.timezone}) for ${input.durationMinutes} minutes${inviteSummary}`,
    timezone: input.timezone,
    warnings,
  };
}

function buildCombinedDateTimeText(preferredDate: string, preferredTime?: string) {
  return preferredTime ? `${preferredDate} ${preferredTime}` : preferredDate;
}

function createBookingFingerprint(input: {
  attendeeName: string;
  attendeeEmails: string[];
  durationMinutes: number;
  meetingTitle?: string;
  startIso: string;
  timezone: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 18);
}

function clampDuration(value: number) {
  return Math.min(180, Math.max(15, Math.round(value)));
}

function normalizeAttendeeName(value: string) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  const cleaned = trimmed.replace(/^[\s"'`.,;:!?()_-]+|[\s"'`.,;:!?()_-]+$/g, "");

  return cleaned || trimmed;
}

function dedupeEmails(emails: string[]) {
  return Array.from(
    new Set(
      emails
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function formatIsoWithOffset(date: Date, timeZone: string) {
  const parts = getDateTimeParts(date, timeZone);
  const offsetMinutes = getTimeZoneOffsetMinutes(date, timeZone);
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const offsetMins = String(absoluteOffset % 60).padStart(2, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetSign}${offsetHours}:${offsetMins}`;
}

function getDateTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });

  const parts = formatter.formatToParts(date);

  return {
    day: parts.find((part) => part.type === "day")?.value ?? "01",
    hour: parts.find((part) => part.type === "hour")?.value ?? "00",
    minute: parts.find((part) => part.type === "minute")?.value ?? "00",
    month: parts.find((part) => part.type === "month")?.value ?? "01",
    second: parts.find((part) => part.type === "second")?.value ?? "00",
    year: parts.find((part) => part.type === "year")?.value ?? "1970",
  };
}

function getLocalHourAndMinute(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  });

  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

  return { hour, minute };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const parts = getDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return Math.round((asUtc - date.getTime()) / 60000);
}

function isWithinBusinessHours(start: Date, end: Date, timeZone: string) {
  const localStart = getLocalHourAndMinute(start, timeZone);
  const localEnd = getLocalHourAndMinute(end, timeZone);
  const startMinutes = localStart.hour * 60 + localStart.minute;
  const endMinutes = localEnd.hour * 60 + localEnd.minute;

  return startMinutes >= 8 * 60 && endMinutes <= 18 * 60;
}

function looksAmbiguousClockTime(value: string) {
  return /^\s*\d{1,2}(:\d{2})?\s*$/.test(value);
}

function normalizeTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone,
    }).format(new Date());
    return timeZone;
  } catch {
    throw new Error("Please provide a valid IANA timezone, for example America/New_York.");
  }
}

function zonedDateTimeToUtc(
  input: {
    day: number;
    hour: number;
    minute: number;
    month: number;
    second: number;
    year: number;
  },
  timeZone: string,
) {
  let timestamp = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const guessDate = new Date(timestamp);
    const offsetMinutes = getTimeZoneOffsetMinutes(guessDate, timeZone);
    const nextTimestamp =
      Date.UTC(
        input.year,
        input.month - 1,
        input.day,
        input.hour,
        input.minute,
        input.second,
      ) -
      offsetMinutes * 60 * 1000;

    if (nextTimestamp === timestamp) {
      break;
    }

    timestamp = nextTimestamp;
  }

  return new Date(timestamp);
}
