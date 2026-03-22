import { z } from "zod";

const azureOpenAISchema = z.object({
  AZURE_OPENAI_API_KEY: z.string().min(1, "Missing AZURE_OPENAI_API_KEY."),
  AZURE_OPENAI_DEPLOYMENT_NAME: z
    .string()
    .trim()
    .min(1, "Missing AZURE_OPENAI_DEPLOYMENT_NAME.")
    .default("gpt-realtime"),
  AZURE_OPENAI_ENDPOINT: z.string().trim().url("AZURE_OPENAI_ENDPOINT must be a valid URL."),
});

const googleCalendarSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().min(1, "Missing GOOGLE_CLIENT_ID."),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "Missing GOOGLE_CLIENT_SECRET."),
  GOOGLE_REFRESH_TOKEN: z.string().min(1, "Missing GOOGLE_REFRESH_TOKEN."),
  GOOGLE_CALENDAR_ID: z.string().optional().default("primary"),
});

const appConfigSchema = z.object({
  NEXT_PUBLIC_DEFAULT_TIMEZONE: z.string().optional().default("America/New_York"),
});

let cachedAzureOpenAIEnv: z.infer<typeof azureOpenAISchema> | null = null;
let cachedGoogleCalendarEnv: z.infer<typeof googleCalendarSchema> | null = null;
let cachedAppConfig: z.infer<typeof appConfigSchema> | null = null;

export function getAzureOpenAIEnv() {
  cachedAzureOpenAIEnv ??= azureOpenAISchema.parse(process.env);

  return {
    ...cachedAzureOpenAIEnv,
    AZURE_OPENAI_ENDPOINT: cachedAzureOpenAIEnv.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, ""),
  };
}

export function getGoogleCalendarEnv() {
  cachedGoogleCalendarEnv ??= googleCalendarSchema.parse(process.env);
  return cachedGoogleCalendarEnv;
}

export function getAppConfig() {
  cachedAppConfig ??= appConfigSchema.parse(process.env);
  return cachedAppConfig;
}
