import http from "node:http";
import process from "node:process";

import { google } from "googleapis";

const redirectUri =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1:3456/oauth2callback";
const defaultScope = process.env.GOOGLE_OAUTH_SCOPE || "https://www.googleapis.com/auth/calendar";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env.local");
  process.exit(1);
}

const redirectUrl = new URL(redirectUri);
const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  include_granted_scopes: true,
  prompt: "consent",
  scope: [defaultScope],
});

console.log("");
console.log("Google Calendar refresh-token helper");
console.log("");
console.log("Before continuing:");
console.log(`1. Add this redirect URI to the same OAuth client: ${redirectUri}`);
console.log("2. Make sure you sign into the Google account whose calendar you want to use.");
console.log("3. If your OAuth consent screen is in Testing, add that Google account as a test user.");
console.log("");
console.log("Open this URL in your browser:");
console.log(authUrl);
console.log("");
console.log(
  `Waiting for the OAuth callback on ${redirectUri}. Press Ctrl+C to cancel.`,
);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", redirectUri);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");

    if (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`Google returned an error: ${error}`);
      console.error(`Google returned an error: ${error}`);
      server.close(() => process.exit(1));
      return;
    }

    if (!code) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Missing authorization code.");
      return;
    }

    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });

    if (!refreshToken) {
      response.end(
        "No refresh token was returned. Revoke the app access, then rerun the script so Google prompts for consent again.",
      );
      console.error("");
      console.error("No refresh token was returned.");
      console.error(
        "Revoke the app in your Google Account permissions, then rerun this command so Google shows the consent screen again.",
      );
      server.close(() => process.exit(1));
      return;
    }

    response.end("Success. You can return to the terminal.");
    console.log("");
    console.log("New GOOGLE_REFRESH_TOKEN:");
    console.log(refreshToken);
    console.log("");
    console.log("Next steps:");
    console.log("1. Paste that value into .env.local as GOOGLE_REFRESH_TOKEN");
    console.log("2. Run: npm run calendar:verify");
    console.log("3. Restart your Next.js dev server");
    server.close(() => process.exit(0));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Token exchange failed.");
    console.error("");
    console.error("Token exchange failed.");
    console.error(formatGoogleError(error));
    server.close(() => process.exit(1));
  }
});

server.listen(Number(redirectUrl.port), redirectUrl.hostname);

function formatGoogleError(error) {
  if (typeof error === "object" && error && "response" in error) {
    const response = error.response;

    if (response && typeof response === "object" && "data" in response) {
      return JSON.stringify(response.data, null, 2);
    }
  }

  return error instanceof Error ? error.message : String(error);
}
