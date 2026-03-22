import { VoiceScheduler } from "@/components/voice-scheduler";
import { getAppConfig } from "@/lib/env";

export default function Home() {
  const { NEXT_PUBLIC_DEFAULT_TIMEZONE } = getAppConfig();
  const realtimeModel = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "gpt-realtime";

  return (
    <main className="page-shell">
      <section className="app-shell">
        <header className="brand-hero">
          <div>
            <p className="app-name">PingMe</p>
            <h1>Talk. Book. Done.</h1>
            <p className="lede">Just say what you need. I&apos;ll handle the rest.</p>
          </div>
          <div className="brand-note">
            <span>{NEXT_PUBLIC_DEFAULT_TIMEZONE}</span>
            <p>TIME ZONE</p>
          </div>
        </header>

        <VoiceScheduler
          defaultTimeZone={NEXT_PUBLIC_DEFAULT_TIMEZONE}
          realtimeModel={realtimeModel}
        />
      </section>
    </main>
  );
}
