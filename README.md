# Voice Scheduling Agent

A real-time, conflict-aware voice assistant that starts the conversation, collects scheduling details, validates a normalized slot, checks real calendar availability, proposes alternatives on conflicts, creates a real Google Calendar event only after explicit confirmation, and can optionally manage that event inside the same live session.

## What this App Does

- Initiates the conversation first
- Asks for the user's name
- Collects a preferred date and time
- Optionally captures a meeting title
- Supports optional 15 / 30 / 60 minute duration capture
- Supports optional attendee email invites
- Normalizes and validates the requested slot on the backend
- Checks real Google Calendar availability before booking
- Suggests alternative times when the requested slot is busy
- Requires an availability-derived fingerprint before event creation
- Creates a real Google Calendar event after explicit confirmation
- Can reschedule or cancel the session's booked event
- Uses session memory so follow-ups like `move it to 4 PM` can reuse the latest event context
- Shows transcript, structured slot state, tool audit logs, session memory, and live metrics
- Surfaces clarification signals when speech or inputs look ambiguous
- Exports a JSON session trace for debugging and evaluation

## Tech stack

- Next.js App Router
- Azure OpenAI Realtime API over WebRTC
- Input transcription via `gpt-4o-mini-transcribe`
- `chrono-node` for deterministic natural-language datetime normalization
- Google Calendar API with OAuth refresh-token auth
- TypeScript
- Zod for server-side validation

## Deployed demo

- Hosted URL: `ADD_YOUR_DEPLOYED_URL_HERE`
- Loom / demo video: `ADD_YOUR_LOOM_URL_HERE`

## How to test the deployed app

1. Open the hosted URL in Chrome.
2. Allow microphone access.
3. Click `Start Voice Agent`.
4. Wait for the assistant to greet you first.
5. Say your name, preferred date, preferred time, and optionally a meeting title, duration, or attendee emails.
6. If the time is busy, listen for alternative suggestions and pick one.
7. Confirm the exact normalized details when the assistant reads them back.
8. Verify that the event appears in the connected Google Calendar.
9. Optionally say `move it to 4 PM` or `cancel the meeting` after booking to test the stretch flow.
10. Optionally click `Export Session Trace` to inspect the structured audit log.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Copy the environment template:

```bash
cp .env.example .env.local
```

3. Fill in the required values in `.env.local`:

```bash
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-realtime
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_CALENDAR_ID=primary
NEXT_PUBLIC_DEFAULT_TIMEZONE=America/New_York
```

If Google Calendar writes fail with `unauthorized_client` or `invalid_grant`, regenerate the refresh token with the same OAuth client:

```bash
npm run calendar:token
```

Then verify the connection before starting the voice app:

```bash
npm run calendar:verify
```

4. Start the app:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000).

## Architecture

The app separates realtime conversation from scheduling safety checks:

1. The browser opens a WebRTC session to Azure OpenAI Realtime through the app's `/api/realtime/session` route.
2. The assistant runs the spoken conversation in real time.
3. Once enough raw details are collected, the model calls `normalize_meeting_request`.
4. The client forwards that call to `/api/scheduling/normalize`.
5. The backend uses `chrono-node` plus timezone-aware validation to turn phrases like `tomorrow at 3 PM` into a deterministic slot.
6. The assistant then calls `check_calendar_availability`.
7. The client forwards that call to `/api/calendar/check-availability`.
8. The backend validates the normalized slot, checks Google Calendar free/busy, and returns either:
   - a free normalized slot, or
   - a busy result with alternative suggestions.
9. The assistant reads back the normalized details and asks for explicit confirmation.
10. Only then does the model call `create_calendar_event`, including the `bookingFingerprint` from the last successful availability check.
11. `/api/calendar/create` re-validates the slot, verifies the fingerprint, re-checks availability, and inserts the real calendar event with optional attendee invites.
12. If the user later says `move it` or `cancel it`, the client reuses the latest session event as explicit session memory for `/api/calendar/reschedule` or `/api/calendar/cancel`.
13. The result is sent back into the Realtime conversation so the assistant can confirm success out loud.


## Calendar integration

The app writes to Google Calendar from server-side routes:

- The frontend never receives Google credentials.
- The browser uses WebRTC with Azure OpenAI Realtime, but tool execution stays in the app.
- Availability checks, event creation, rescheduling, and cancellation all happen on the backend through `googleapis`.
- OAuth refresh-token auth lets the app write to a real calendar without putting secrets in the browser.
- The backend can reject invalid or stale booking attempts before an event is created.
- Invited attendees can be added via `attendees[]`, and Google update notifications can be sent when relevant.

### Google setup notes

To run this against a real calendar, you need:

1. A Google Cloud project with the Google Calendar API enabled
2. OAuth client credentials
3. A refresh token with calendar write access
4. A target calendar ID, which can be `primary` or a dedicated demo calendar

For a clean demo, using a dedicated calendar is usually easiest because reviewers can test without touching a personal calendar.

## Availability and alternative-search strategy

Before any availability check runs, the backend normalizes natural language into a real datetime:

- `tomorrow at 3`
- `next Monday at noon`
- `March 22 at 4 PM`

The parser is intentionally server-side so the assistant does not invent timestamps on its own. The backend also rejects unclear times such as bare `3` without AM/PM or 24-hour format.

When the requested slot is busy:

- The backend queries Google Calendar free/busy for the requested window.
- It then searches forward in 30-minute increments for up to 5 days.
- It keeps only candidate slots that:
  - are still in the future
  - fit within preferred 8:00 AM to 6:00 PM local working hours
  - do not overlap any busy window
- The first 3 valid alternatives are returned to the model.

This keeps the assistant grounded in real calendar state rather than asking the model to invent alternatives.

## Observability

The UI exposes:

- Live transcript
- Structured slot state
- Raw date/time phrases and parsed datetime text
- Active session event memory
- Latest normalized payload
- Latest availability result
- Latest calendar API result
- Tool audit trail with payloads and durations
- User/assistant turn counts
- Normalization count
- Tool-call counts
- Conflict count
- Revision count after user corrections
- Reschedule count
- Cancellation count
- Clarification-signal count
- Last and average assistant response latency
- Exportable JSON trace of the full session

## Realtime configuration

The client configures the session with:

- Azure OpenAI Realtime for low-latency voice interaction
- `semantic_vad` turn detection
- `near_field` input noise reduction
- `gpt-4o-mini-transcribe` for input transcription
- Five function tools:
  - `normalize_meeting_request`
  - `check_calendar_availability`
  - `create_calendar_event`
  - `reschedule_calendar_event`
  - `cancel_calendar_event`

## Main Files 

- `app/page.tsx`: landing page and demo framing
- `components/voice-scheduler.tsx`: WebRTC session, realtime event handling, tool execution, metrics, audit logging, trace export
- `app/api/realtime/session/route.ts`: server-side Realtime session bootstrap
- `app/api/scheduling/normalize/route.ts`: natural-language date/time normalization endpoint
- `app/api/calendar/check-availability/route.ts`: availability-check endpoint
- `app/api/calendar/create/route.ts`: calendar write endpoint
- `app/api/calendar/reschedule/route.ts`: session-event reschedule endpoint
- `app/api/calendar/cancel/route.ts`: session-event cancellation endpoint
- `lib/google-calendar.ts`: Google Calendar availability + insertion logic
- `lib/scheduling.ts`: slot normalization, business-hour checks, fingerprints, alternative-slot search, attendee-email validation
- `lib/prompts.ts`: system instructions and tool schemas


## Notes

- The app defaults to a 30-minute meeting if the user does not mention duration.
- The assistant is instructed not to create an event until the user explicitly confirms the final details.
- Reschedule and cancel currently target the latest event created in the same browser session.
- The backend warns when requested times fall outside preferred working hours.
- The exported trace is useful for attaching logs or debugging artifacts to the submission.
- Chrome tends to give the smoothest WebRTC microphone experience for this kind of demo.
