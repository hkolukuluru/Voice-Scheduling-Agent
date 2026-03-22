import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { rescheduleCalendarEvent } from "@/lib/google-calendar";
import { rescheduleEventRequestSchema } from "@/lib/scheduling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = rescheduleEventRequestSchema.parse(await request.json());
    const event = await rescheduleCalendarEvent(payload);

    return NextResponse.json({ event });
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
      error instanceof Error ? error.message : "Unexpected error rescheduling the calendar event.";

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
