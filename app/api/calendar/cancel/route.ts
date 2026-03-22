import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { cancelCalendarEvent } from "@/lib/google-calendar";
import { cancelEventRequestSchema } from "@/lib/scheduling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = cancelEventRequestSchema.parse(await request.json());
    const result = await cancelCalendarEvent(payload);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: error.issues[0]?.message ?? "Invalid request payload.",
        },
        { status: 400 },
      );
    }

    const message =
      error instanceof Error ? error.message : "Unexpected error cancelling the calendar event.";

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
