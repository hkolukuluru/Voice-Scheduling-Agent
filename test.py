from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/calendar"]

flow = InstalledAppFlow.from_client_secrets_file(
    "client_secret_2.json",
    scopes=SCOPES,
)

creds = flow.run_local_server(port=8080, access_type="offline", prompt="consent")

print("ACCESS TOKEN:", creds.token)
print("REFRESH TOKEN:", creds.refresh_token)