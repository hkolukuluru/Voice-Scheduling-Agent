import process from "node:process";

import { google } from "googleapis";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

if (!clientId || !clientSecret || !refreshToken) {
  console.error(
    "Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN in .env.local",
  );
  process.exit(1);
}

const auth = new google.auth.OAuth2(clientId, clientSecret);
auth.setCredentials({
  refresh_token: refreshToken,
});

const calendar = google.calendar({
  version: "v3",
  auth,
});

try {
  const calendarInfo = await calendar.calendarList.get({
    calendarId,
  });
  const now = new Date();
  const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const upcomingEvents = await calendar.events.list({
    calendarId,
    maxResults: 5,
    orderBy: "startTime",
    singleEvents: true,
    timeMax: inSevenDays.toISOString(),
    timeMin: now.toISOString(),
  });

  console.log("");
  console.log("Google Calendar connection looks healthy.");
  console.log("");
  console.log(
    JSON.stringify(
      {
        accessRole: calendarInfo.data.accessRole,
        calendarId: calendarInfo.data.id,
        calendarSummary: calendarInfo.data.summary,
        primary: calendarInfo.data.primary,
        timeZone: calendarInfo.data.timeZone,
        upcomingEvents: (upcomingEvents.data.items || []).map((event) => ({
          end: event.end,
          htmlLink: event.htmlLink,
          id: event.id,
          start: event.start,
          status: event.status,
          summary: event.summary,
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("");
  console.error("Google Calendar verification failed.");
  console.error(formatGoogleError(error));
  process.exit(1);
}

function formatGoogleError(error) {
  if (typeof error === "object" && error && "response" in error) {
    const response = error.response;

    if (response && typeof response === "object" && "data" in response) {
      return JSON.stringify(response.data, null, 2);
    }
  }

  return error instanceof Error ? error.message : String(error);
}
