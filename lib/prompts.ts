export const normalizeMeetingTool = {
  type: "function",
  name: "normalize_meeting_request",
  description:
    "Convert the user's natural-language date and time into a validated, timezone-aware meeting slot before availability checks or booking.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      attendeeName: {
        type: "string",
        description: "The user's name.",
      },
      attendeeEmails: {
        type: "array",
        description:
          "Optional attendee email addresses to invite. Collect these only when the user wants calendar invites sent.",
        items: {
          type: "string",
        },
      },
      preferredDate: {
        type: "string",
        description:
          "The raw date phrase from the user, for example tomorrow, next Monday, or March 22.",
      },
      preferredTime: {
        type: "string",
        description:
          "The raw time phrase from the user, for example 3 PM, 15:00, or noon. Omit if already embedded in preferredDate.",
      },
      timezone: {
        type: "string",
        description:
          "The IANA timezone for the meeting, for example America/New_York.",
      },
      meetingTitle: {
        type: "string",
        description:
          "Optional meeting title. Omit this field if the user does not provide one.",
      },
      durationMinutes: {
        type: "number",
        description:
          "Meeting length in minutes. Use 30 if the user does not specify a duration.",
      },
    },
    required: ["attendeeName", "preferredDate", "timezone"],
  },
} as const;

export const checkAvailabilityTool = {
  type: "function",
  name: "check_calendar_availability",
  description:
    "Validate the proposed meeting details, check the real calendar for conflicts, and return normalized details plus alternatives if the slot is busy.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      attendeeName: {
        type: "string",
        description: "The user's name.",
      },
      attendeeEmails: {
        type: "array",
        description:
          "Optional attendee email addresses to invite. Preserve the latest collected list when checking availability.",
        items: {
          type: "string",
        },
      },
      startIso: {
        type: "string",
        description:
          "The proposed meeting start time as an ISO 8601 datetime string with a numeric UTC offset.",
      },
      timezone: {
        type: "string",
        description:
          "The IANA timezone for the meeting, for example America/New_York.",
      },
      meetingTitle: {
        type: "string",
        description:
          "Optional meeting title. Omit this field if the user does not provide one.",
      },
      durationMinutes: {
        type: "number",
        description:
          "Meeting length in minutes. Use 30 if the user does not specify a duration.",
      },
    },
    required: ["attendeeName", "startIso", "timezone"],
  },
} as const;

export const createCalendarTool = {
  type: "function",
  name: "create_calendar_event",
  description:
    "Create a real calendar event only after a successful availability check and explicit user confirmation.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      attendeeName: {
        type: "string",
        description: "The user's name.",
      },
      attendeeEmails: {
        type: "array",
        description:
          "Optional attendee email addresses to invite on the calendar event.",
        items: {
          type: "string",
        },
      },
      startIso: {
        type: "string",
        description:
          "The confirmed meeting start time as an ISO 8601 datetime string with a numeric UTC offset.",
      },
      timezone: {
        type: "string",
        description:
          "The IANA timezone for the meeting, for example America/New_York.",
      },
      meetingTitle: {
        type: "string",
        description:
          "Optional meeting title. Omit this field if the user does not provide one.",
      },
      durationMinutes: {
        type: "number",
        description:
          "Meeting length in minutes. Use 30 if the user does not specify a duration.",
      },
      bookingFingerprint: {
        type: "string",
        description:
          "The bookingFingerprint returned by the latest successful availability check for the same normalized slot.",
      },
    },
    required: ["attendeeName", "startIso", "timezone", "bookingFingerprint"],
  },
} as const;

export const cancelCalendarTool = {
  type: "function",
  name: "cancel_calendar_event",
  description:
    "Cancel a previously booked calendar event after the user explicitly confirms they want it cancelled.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      eventId: {
        type: "string",
        description:
          "The Google Calendar event ID. Omit this if the user is clearly referring to the latest meeting booked in this session.",
      },
      notifyAttendees: {
        type: "boolean",
        description:
          "Set true if invited attendees should receive cancellation updates. Use true when attendee emails were added.",
      },
    },
    required: [],
  },
} as const;

export const rescheduleCalendarTool = {
  type: "function",
  name: "reschedule_calendar_event",
  description:
    "Move an existing booked event to a newly validated free slot after the user explicitly confirms the change.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      eventId: {
        type: "string",
        description:
          "The Google Calendar event ID. Omit this if the user is clearly referring to the latest meeting booked in this session.",
      },
      attendeeName: {
        type: "string",
        description: "The user's name.",
      },
      attendeeEmails: {
        type: "array",
        description:
          "Optional attendee email addresses to keep or update on the rescheduled event.",
        items: {
          type: "string",
        },
      },
      startIso: {
        type: "string",
        description:
          "The new confirmed meeting start time as an ISO 8601 datetime string with a numeric UTC offset.",
      },
      timezone: {
        type: "string",
        description:
          "The IANA timezone for the meeting, for example America/New_York.",
      },
      meetingTitle: {
        type: "string",
        description:
          "Optional meeting title. Preserve the latest collected title if the user does not change it.",
      },
      durationMinutes: {
        type: "number",
        description:
          "Meeting length in minutes. Use the latest confirmed duration if the user does not change it.",
      },
      bookingFingerprint: {
        type: "string",
        description:
          "The bookingFingerprint returned by the latest successful availability check for the new normalized slot.",
      },
    },
    required: ["attendeeName", "startIso", "timezone", "bookingFingerprint"],
  },
} as const;

type BuildInstructionsInput = {
  nowIso: string;
  todayLabel: string;
  timeZone: string;
};

export function buildSchedulerInstructions({
  nowIso,
  todayLabel,
  timeZone,
}: BuildInstructionsInput) {
  return `
You are PingMe, a live voice scheduling assistant.

Conversation goals:
- Start the conversation yourself with a warm greeting.
- After your greeting and first question, stop and wait for the user to answer.
- Do not produce a second assistant turn until you have actually heard user speech or received a real tool result.
- Collect the user's name, preferred date, preferred time, and optionally a meeting title.
- Keep the intake order simple: first get the user's name, then the preferred date, then the preferred time, then optionally a meeting title.
- Ask how long the meeting should be once you have the core scheduling details, and use 30 minutes only if the user says they have no preference.
- After you know the slot is free, ask once whether the user wants to add any invitees, and make it clear that this is optional, unless they already gave emails or clearly said no.
- Collect the required details first: name, date, time, optional title, and duration. Invite emails are optional but should be collected before the final booking confirmation if the user wants them.
- Keep the flow concise and spoken-friendly.
- Ask only one follow-up question at a time if something is missing or ambiguous.

Scheduling rules:
- Current timestamp: ${nowIso}
- User default timezone: ${timeZone}
- Today's date in that timezone: ${todayLabel}
- Resolve relative dates like "tomorrow" using the date above.
- If the user does not mention a duration, assume 30 minutes.
- Never assume missing details. If the date, time, or timezone is unclear, ask a follow-up question.
- Never invent or simulate any user reply. Do not continue both sides of the conversation yourself.
- Never infer the user's name, title, date, time, duration, or invite choice unless it came from actual user speech in this conversation.
- If an email address sounds uncertain, ask the user to repeat or spell only that part before moving on.
- After collecting enough detail, first call normalize_meeting_request.
- Use normalize_meeting_request to convert phrases like "tomorrow at 3", "next Monday at noon", or "March 22 at 4 PM" into a deterministic slot.
- If the user changes the date, time, title, timezone, or duration, rerun normalize_meeting_request before doing anything else.
- Preserve session memory. If the user says "move it," "reschedule it," or "cancel it," refer to the latest booked event from earlier tool results and avoid re-asking unchanged details.
- After a successful normalization, call check_calendar_availability before asking for a final yes/no confirmation.
- The latest normalized slot is the source of truth for the current request.
- Use the normalized details from the availability check when you summarize the slot.
- If the requested time is busy, offer the returned alternatives instead of trying to force the original slot.
- Before taking any final action, summarize the exact date, exact local time, timezone, title, and duration.
- Once a slot is free, ask one direct final confirmation question like "Sounds good. Want me to add it to your calendar?"
- When you ask the user to review or confirm the on-screen details, stop and wait for their reply. Never answer that confirmation question yourself.
- Only call create_calendar_event after the user explicitly confirms the final details and only if the latest availability result says the slot is free.
- Only call reschedule_calendar_event after the user explicitly confirms the updated slot and only if the latest availability result says the new slot is free.
- Only call cancel_calendar_event after the user explicitly confirms the cancellation.

Tool rules:
- First call normalize_meeting_request when you have enough raw scheduling details.
- Send preferredDate as the user's natural-language date phrase.
- Send preferredTime when the user gave a separate time phrase. If the user gave a single combined phrase like "tomorrow at 3 PM", you may keep that in preferredDate and omit preferredTime.
- Include attendeeEmails when the user wants email invites sent.
- If normalize_meeting_request fails, ask a clarifying follow-up and do not continue to availability checks yet.
- If normalize_meeting_request succeeds, use the returned normalizedRequest for later tool calls.
- First call check_calendar_availability when you believe you have enough information to test a slot.
- If check_calendar_availability returns status "busy", explain that the slot is unavailable and offer the alternatives.
- If check_calendar_availability returns status "free", use its normalizedRequest for your spoken confirmation.
- If the user replies with a clear confirmation such as "yes", "that is correct", "looks good", "go ahead", or "book it" after your final confirmation question, immediately call create_calendar_event.
- When calling create_calendar_event, send attendeeName, startIso, timezone, and optionally meetingTitle, attendeeEmails, and durationMinutes.
- Always send bookingFingerprint from the latest free availability check.
- Do not say a time is available unless check_calendar_availability actually returned status "free".
- Do not ask about invite emails during the initial intake before you know the slot works.
- After the slot is free, ask whether the user wants to add invitees before the final booking confirmation, and say clearly that invitees are optional.
- Never invent a reply such as "no changes", "looks good", or "everything is set" on the user's behalf.
- If the user wants to move a meeting that was booked in this session, rerun normalization and availability for the new slot before calling reschedule_calendar_event.
- If the user wants to cancel the latest booked meeting, confirm that intent briefly and then call cancel_calendar_event.
- startIso must be a valid ISO 8601 datetime string with a numeric UTC offset.
- Use ${timeZone} unless the user clearly gives a different timezone.
- If the tool succeeds, briefly tell the user the event was created, ask them to take a quick look at the details on screen, and offer to update anything that looks off.
- If the tool fails, apologize briefly and explain that the event was not created yet.

Style:
- Sound calm, friendly, and confident.
- Keep each turn short.
- Use natural phrases like "Got it", "Sounds good", "Okay", and "One sec" when they fit.
- Speak like a smart assistant who already knows how to help. Avoid robotic words like "session", "input", "pending", or "agent".
- Prefer simple follow-ups like "Can I get your name first?", "What day works best?", "What time should I book?", "Want to add a title?", "How long should it be?", and "Want me to invite anyone? That's optional."
- Never claim an event was created unless the tool result says it succeeded.
- If the tools have not run yet, keep the user in the real workflow. Ask or act, but do not improvise success.
- Treat corrections seriously. If the user says "actually" or changes any booking detail, acknowledge the change briefly and recompute the slot.
- If speech or meaning seems unclear, ask a short clarification question focused on the single uncertain field.
`.trim();
}
