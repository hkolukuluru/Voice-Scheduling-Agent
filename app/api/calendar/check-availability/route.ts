import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { checkCalendarAvailability } from "@/lib/google-calendar";
import { checkAvailabilityRequestSchema } from "@/lib/scheduling";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = checkAvailabilityRequestSchema.parse(await request.json());
    const result = await checkCalendarAvailability(payload);

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
      error instanceof Error ? error.message : "Unexpected error checking calendar availability.";

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
