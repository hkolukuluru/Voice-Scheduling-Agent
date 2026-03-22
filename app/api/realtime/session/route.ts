import { NextResponse } from "next/server";

import { getAzureOpenAIEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const offer = await request.text();

  if (!offer) {
    return NextResponse.json(
      {
        error: "Expected an SDP offer in the request body.",
      },
      { status: 400 },
    );
  }

  const {
    AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_DEPLOYMENT_NAME,
    AZURE_OPENAI_ENDPOINT,
  } = getAzureOpenAIEnv();

  const sessionConfig = {
    session: {
      type: "realtime",
      model: AZURE_OPENAI_DEPLOYMENT_NAME,
      output_modalities: ["audio"],
      audio: {
        output: {
          voice: "marin",
        },
      },
    },
  };

  const clientSecretsResponse = await fetch(
    `${AZURE_OPENAI_ENDPOINT}/openai/v1/realtime/client_secrets`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": AZURE_OPENAI_API_KEY,
      },
      body: JSON.stringify(sessionConfig),
      cache: "no-store",
    },
  );

  const clientSecretsText = await clientSecretsResponse.text();

  if (!clientSecretsResponse.ok) {
    return NextResponse.json(
      {
        error: clientSecretsText || "Failed to create the Azure OpenAI ephemeral token.",
      },
      { status: clientSecretsResponse.status },
    );
  }

  let ephemeralToken = "";

  try {
    const payload = JSON.parse(clientSecretsText) as { value?: string };
    ephemeralToken = payload.value ?? "";
  } catch {
    ephemeralToken = "";
  }

  if (!ephemeralToken) {
    return NextResponse.json(
      {
        error: "Azure OpenAI returned an invalid ephemeral token response.",
      },
      { status: 500 },
    );
  }

  const response = await fetch(`${AZURE_OPENAI_ENDPOINT}/openai/v1/realtime/calls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ephemeralToken}`,
      "Content-Type": "application/sdp",
    },
    body: offer,
    cache: "no-store",
  });

  const answer = await response.text();

  if (!response.ok) {
    return NextResponse.json(
      {
        error: answer || "Failed to create the realtime session.",
      },
      { status: response.status },
    );
  }

  return new Response(answer, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/sdp",
    },
  });
}
