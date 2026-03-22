import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const logId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
    const logsDir =
      process.env.VOICE_AGENT_LOG_DIR ||
      path.join(tmpdir(), "voice-scheduling-agent", "voice-agent");
    const filePath = path.join(logsDir, `${logId}.json`);

    await mkdir(logsDir, {
      recursive: true,
    });
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");

    return NextResponse.json({
      logId,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected error writing the session log.";

    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
