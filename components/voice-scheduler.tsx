"use client";

import { startTransition, useEffect, useRef, useState, type ReactNode } from "react";

import {
  buildSchedulerInstructions,
  cancelCalendarTool,
  checkAvailabilityTool,
  createCalendarTool,
  normalizeMeetingTool,
  rescheduleCalendarTool,
} from "@/lib/prompts";

type VoiceSchedulerProps = {
  defaultTimeZone: string;
  realtimeModel: string;
};

type TranscriptRole = "assistant" | "user" | "system";
type DraftStatus =
  | "collecting"
  | "normalized"
  | "checking"
  | "free"
  | "busy"
  | "booked"
  | "cancelled"
  | "error";

type TranscriptEntry = {
  id: string;
  pending: boolean;
  role: TranscriptRole;
  text: string;
  timestamp: string;
};

type CalendarEvent = {
  attendeeEmails: string[];
  attendeeName: string;
  durationMinutes: number;
  endIso: string;
  htmlLink: string;
  id: string;
  startIso: string;
  summary: string;
  timezone: string;
};

type AlternativeSlot = {
  displayText: string;
  endIso: string;
  startIso: string;
  timezone: string;
};

type DayAgendaItem = {
  endIso: string;
  label: string;
  startIso: string;
  status: "alternative" | "busy" | "selected";
};

type NormalizedRequest = {
  attendeeEmails: string[];
  attendeeName: string;
  bookingFingerprint: string;
  durationMinutes: number;
  endIso: string;
  localDateLabel: string;
  localTimeLabel: string;
  meetingTitle?: string;
  parsedDateTimeText: string;
  preferredDate: string;
  preferredTime?: string;
  startIso: string;
  summaryLine: string;
  timezone: string;
  warnings: string[];
};

type AvailabilityResult = {
  alternatives: AlternativeSlot[];
  dayAgenda: DayAgendaItem[];
  normalizedRequest: NormalizedRequest;
  status: "free" | "busy";
};

type NormalizationResult = {
  normalizedRequest: NormalizedRequest;
  rawInput: {
    combinedDateTimeText: string;
    preferredDate: string;
    preferredTime?: string;
  };
};

type CancellationResult = {
  eventId: string;
  notifiedAttendees: boolean;
  status: "cancelled";
  summary: string;
};

type ScheduleDraft = {
  alternatives: AlternativeSlot[];
  attendeeEmails: string[];
  attendeeName?: string;
  bookingFingerprint?: string;
  durationMinutes?: number;
  endIso?: string;
  localDateLabel?: string;
  localTimeLabel?: string;
  meetingTitle?: string;
  parsedDateTimeText?: string;
  preferredDate?: string;
  preferredTime?: string;
  revisionCount: number;
  startIso?: string;
  status: DraftStatus;
  summaryLine?: string;
  timezone?: string;
  warnings: string[];
};

type ClarificationSignal = {
  id: string;
  reason: string;
  source: "tool" | "transcript";
  timestamp: string;
};

type SessionMemory = {
  activeEvent: CalendarEvent | null;
  clarificationSignals: ClarificationSignal[];
  lastAvailability: AvailabilityResult | null;
  lastPersistedLogId: string | null;
  lastNormalization: NormalizationResult | null;
  latestToolResult: {
    name: string;
    payload: string;
  } | null;
};

type CallVisualState = "error" | "idle" | "listening" | "speaking" | "thinking";

type ManualOverrideForm = {
  attendeeEmailsText: string;
  attendeeName: string;
  durationMinutes: string;
  meetingTitle: string;
  preferredDate: string;
  preferredTime: string;
};

type ToolAuditEntry = {
  durationMs?: number;
  id: string;
  name: string;
  payload?: string;
  status: "pending" | "success" | "error";
  summary: string;
  timestamp: string;
};

type Metrics = {
  assistantTurns: number;
  availabilityChecks: number;
  averageAssistantLatencyMs: number | null;
  cancellations: number;
  clarificationSignals: number;
  conflictsFound: number;
  eventsCreated: number;
  lastAssistantLatencyMs: number | null;
  normalizations: number;
  reschedules: number;
  revisions: number;
  toolCalls: number;
  userTurns: number;
};

type RealtimeFunctionCall = {
  arguments?: string;
  call_id?: string;
  id?: string;
  name?: string;
  type?: string;
};

type RealtimeMessageItem = {
  content?: Array<{
    text?: string;
    transcript?: string;
    type?: string;
  }>;
  id?: string;
  role?: string;
  type?: string;
};

type RealtimeServerEvent = {
  code?: string;
  delta?: string;
  error?: {
    message?: string;
  };
  item?: RealtimeMessageItem;
  item_id?: string;
  response?: {
    output?: Array<RealtimeFunctionCall | RealtimeMessageItem>;
    status?: string;
    status_details?: {
      reason?: string;
    };
  };
  transcript?: string;
  type?: string;
};

const initialDraftState: ScheduleDraft = {
  alternatives: [],
  attendeeEmails: [],
  revisionCount: 0,
  status: "collecting",
  warnings: [],
};

const initialMetricsState: Metrics = {
  assistantTurns: 0,
  availabilityChecks: 0,
  averageAssistantLatencyMs: null,
  cancellations: 0,
  clarificationSignals: 0,
  conflictsFound: 0,
  eventsCreated: 0,
  lastAssistantLatencyMs: null,
  normalizations: 0,
  reschedules: 0,
  revisions: 0,
  toolCalls: 0,
  userTurns: 0,
};

const initialSessionMemory: SessionMemory = {
  activeEvent: null,
  clarificationSignals: [],
  lastAvailability: null,
  lastPersistedLogId: null,
  lastNormalization: null,
  latestToolResult: null,
};

export function VoiceScheduler({ defaultTimeZone, realtimeModel }: VoiceSchedulerProps) {
  const [connectionState, setConnectionState] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");
  const [callVisualState, setCallVisualState] = useState<CallVisualState>("idle");
  const [statusText, setStatusText] = useState(
    "Tap Start, allow mic access, and just speak naturally. I'll guide you from there.",
  );
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [createdEvent, setCreatedEvent] = useState<CalendarEvent | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(initialDraftState);
  const [auditLog, setAuditLog] = useState<ToolAuditEntry[]>([]);
  const [metrics, setMetrics] = useState<Metrics>(initialMetricsState);
  const [sessionMemory, setSessionMemory] = useState<SessionMemory>(initialSessionMemory);
  const [manualOverrideOpen, setManualOverrideOpen] = useState(false);
  const [manualOverrideState, setManualOverrideState] = useState<
    "applied" | "editing" | "idle" | "saving"
  >("idle");
  const [manualOverrideError, setManualOverrideError] = useState<string | null>(null);
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const [manualOverrideForm, setManualOverrideForm] = useState<ManualOverrideForm>({
    attendeeEmailsText: "",
    attendeeName: "",
    durationMinutes: "30",
    meetingTitle: "",
    preferredDate: "",
    preferredTime: "",
  });

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const greetedRef = useRef(false);
  const transcriptFeedRef = useRef<HTMLDivElement | null>(null);
  const handledToolCallIdsRef = useRef(new Set<string>());
  const bookingRequestInFlightRef = useRef(false);
  const countedAssistantItemIdsRef = useRef(new Set<string>());
  const countedUserItemIdsRef = useRef(new Set<string>());
  const blockedAssistantItemIdsRef = useRef(new Set<string>());
  const awaitingBookingConfirmationRef = useRef(false);
  const heardUserSinceConfirmationRef = useRef(false);
  const heardUserAudioRef = useRef(false);
  const pendingAutoBookRef = useRef<string | null>(null);
  const pendingResponseKickTimeoutRef = useRef<number | null>(null);
  const workflowRecoveryItemIdsRef = useRef(new Set<string>());
  const responseLatencyClockRef = useRef<number | null>(null);
  const latencyCapturedForTurnRef = useRef(false);
  const latencyStatsRef = useRef({
    count: 0,
    totalMs: 0,
  });
  const sessionStartedAtRef = useRef<string | null>(null);

  const timeZone =
    typeof window === "undefined"
      ? defaultTimeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || defaultTimeZone;

  useEffect(() => {
    if (manualOverrideOpen && (manualOverrideState === "editing" || manualOverrideState === "saving")) {
      return;
    }

    setManualOverrideForm({
      attendeeEmailsText: (draft.attendeeEmails.length
        ? draft.attendeeEmails
        : createdEvent?.attendeeEmails ?? []
      ).join(", "),
      attendeeName: draft.attendeeName ?? createdEvent?.attendeeName ?? "",
      durationMinutes: String(draft.durationMinutes ?? createdEvent?.durationMinutes ?? 30),
      meetingTitle: draft.meetingTitle ?? "",
      preferredDate: formatDateInputValue(draft.startIso ?? createdEvent?.startIso),
      preferredTime: formatTimeInputValue(draft.startIso ?? createdEvent?.startIso),
    });
  }, [
    createdEvent?.attendeeEmails,
    createdEvent?.attendeeName,
    createdEvent?.durationMinutes,
    createdEvent?.startIso,
    draft.attendeeEmails,
    draft.attendeeName,
    draft.durationMinutes,
    draft.meetingTitle,
    draft.startIso,
    manualOverrideOpen,
    manualOverrideState,
  ]);

  useEffect(() => {
    if (!createdEvent || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
      return;
    }

    navigator.vibrate([80, 40, 120]);
  }, [createdEvent]);

  const mergeTranscriptEntry = useEventCallback(
    (
      id: string,
      role: TranscriptRole,
      text: string,
      options?: {
        mode?: "append" | "replace";
        pending?: boolean;
      },
    ) => {
      startTransition(() => {
        setTranscript((current) => {
          const next = [...current];
          const index = next.findIndex((entry) => entry.id === id);
          const mode = options?.mode ?? "replace";
          const pending = options?.pending ?? false;

          if (index === -1) {
            next.push({
              id,
              pending,
              role,
              text,
              timestamp: timestampLabel(),
            });

            return next.slice(-24);
          }

          const existing = next[index];
          next[index] = {
            ...existing,
            pending,
            role,
            text: mode === "append" ? `${existing.text}${text}` : text,
          };

          return next;
        });
      });
    },
  );

  const addSystemNote = useEventCallback((text: string) => {
    mergeTranscriptEntry(`system-${Date.now()}-${Math.random()}`, "system", text);
  });

  const removeTranscriptEntry = useEventCallback((id: string) => {
    setTranscript((current) => current.filter((entry) => entry.id !== id));
  });

  const addAuditEntry = useEventCallback((entry: ToolAuditEntry) => {
    setAuditLog((current) => [entry, ...current].slice(0, 16));
  });

  const updateAuditEntry = useEventCallback(
    (
      id: string,
      updates: Partial<Pick<ToolAuditEntry, "durationMs" | "payload" | "status" | "summary">>,
    ) => {
      setAuditLog((current) =>
        current.map((entry) => (entry.id === id ? { ...entry, ...updates } : entry)),
      );
    },
  );

  const trackLatestToolResult = useEventCallback((name: string, payload: object) => {
    setSessionMemory((current) => ({
      ...current,
      latestToolResult: {
        name,
        payload: JSON.stringify(payload, null, 2),
      },
    }));
  });

  const addClarificationSignal = useEventCallback(
    (reason: string, source: ClarificationSignal["source"]) => {
      setSessionMemory((current) => {
        const duplicate = current.clarificationSignals.some(
          (signal) => signal.reason === reason && signal.source === source,
        );

        if (duplicate) {
          return current;
        }

        return {
          ...current,
          clarificationSignals: [
            {
              id: `${source}-${Date.now()}-${Math.random()}`,
              reason,
              source,
              timestamp: timestampLabel(),
            },
            ...current.clarificationSignals,
          ].slice(0, 8),
        };
      });
      setMetrics((current) => ({
        ...current,
        clarificationSignals: current.clarificationSignals + 1,
      }));
    },
  );

  const extractItemText = useEventCallback((item?: RealtimeMessageItem) => {
    if (!item?.content) {
      return "";
    }

    return item.content
      .map((part) => part.transcript ?? part.text ?? "")
      .filter(Boolean)
      .join(" ")
      .trim();
  });

  const sendClientEvent = useEventCallback((event: Record<string, unknown>) => {
    const channel = dataChannelRef.current;

    if (!channel || channel.readyState !== "open") {
      return;
    }

    channel.send(JSON.stringify(event));
  });

  const clearPendingResponseKick = useEventCallback(() => {
    if (typeof window === "undefined" || pendingResponseKickTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(pendingResponseKickTimeoutRef.current);
    pendingResponseKickTimeoutRef.current = null;
  });

  const schedulePendingResponseKick = useEventCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    clearPendingResponseKick();
    pendingResponseKickTimeoutRef.current = window.setTimeout(() => {
      pendingResponseKickTimeoutRef.current = null;

      if (connectionState !== "connected") {
        return;
      }

      if (callVisualState === "speaking" || callVisualState === "thinking") {
        return;
      }

      setCallVisualState("thinking");
      setStatusText("Working on that...");
      sendClientEvent({
        type: "response.create",
        response: {
          instructions:
            "The user has finished speaking. Respond to what they just said based on the audio you heard. If any required scheduling detail is still missing, ask only for the next missing detail. Do not claim anything is booked until the real calendar tools succeed.",
        },
      });
    }, 900);
  });

  const resetSessionState = useEventCallback(() => {
    greetedRef.current = false;
    handledToolCallIdsRef.current.clear();
    countedAssistantItemIdsRef.current.clear();
    countedUserItemIdsRef.current.clear();
    blockedAssistantItemIdsRef.current.clear();
    heardUserAudioRef.current = false;
    workflowRecoveryItemIdsRef.current.clear();
    responseLatencyClockRef.current = null;
    latencyCapturedForTurnRef.current = false;
    latencyStatsRef.current = {
      count: 0,
      totalMs: 0,
    };
    sessionStartedAtRef.current = null;

    setCallVisualState("idle");
    setCreatedEvent(null);
    setDraft(initialDraftState);
    setAuditLog([]);
    setMetrics(initialMetricsState);
    setManualOverrideOpen(false);
    setManualOverrideState("idle");
    setManualOverrideError(null);
    setSessionMemory(initialSessionMemory);
    setShowFullTranscript(false);
    setTranscript([]);
    awaitingBookingConfirmationRef.current = false;
    heardUserSinceConfirmationRef.current = false;
    bookingRequestInFlightRef.current = false;
    pendingAutoBookRef.current = null;
    clearPendingResponseKick();
  });

  const cleanupSession = useEventCallback(() => {
    clearPendingResponseKick();
    heardUserAudioRef.current = false;
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current = null;
    }

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
  });

  const announceKickoff = useEventCallback(() => {
    if (greetedRef.current) {
      return;
    }

    greetedRef.current = true;
    setCallVisualState("thinking");
    setStatusText("I'm here. Tell me what you'd like to schedule.");
    addSystemNote("Realtime session is ready. The assistant is opening the conversation.");
    sendClientEvent({
      type: "response.create",
      response: {
        instructions:
          "Start the conversation now. Greet the user briefly in a calm, friendly way, ask what they would like to schedule, and then stop so the user can answer. Do not produce a second assistant turn until you have actually heard user speech or received a tool result. Do not simulate the user's side of the conversation, do not invent meeting details, and do not claim anything is booked until the real calendar tool succeeds.",
      },
    });
  });

  const configureSession = useEventCallback(() => {
    const now = new Date();
    const todayLabel = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeZone,
    }).format(now);

    sendClientEvent({
      type: "session.update",
      session: {
        type: "realtime",
        model: realtimeModel,
        output_modalities: ["audio"],
        max_output_tokens: 320,
        instructions: buildSchedulerInstructions({
          nowIso: now.toISOString(),
          todayLabel,
          timeZone,
        }),
        audio: {
          input: {
            noise_reduction: {
              type: "near_field",
            },
            transcription: {
              language: "en",
              model: "gpt-4o-mini-transcribe",
            },
            turn_detection: {
              type: "semantic_vad",
              create_response: true,
              interrupt_response: true,
              eagerness: "medium",
            },
          },
          output: {
            voice: "marin",
          },
        },
        tools: [
          normalizeMeetingTool,
          checkAvailabilityTool,
          createCalendarTool,
          rescheduleCalendarTool,
          cancelCalendarTool,
        ],
        tool_choice: "auto",
      },
    });
  });

  const sendFunctionOutput = useEventCallback(
    (callId: string, output: object, responseInstructions?: string) => {
    sendClientEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    });
    sendClientEvent({
      type: "response.create",
      response: responseInstructions
        ? {
            instructions: responseInstructions,
          }
        : undefined,
    });
    },
  );

  const registerUserTranscript = useEventCallback((itemId: string, transcriptText: string) => {
    if (!transcriptText) {
      return;
    }

    clearPendingResponseKick();
    heardUserAudioRef.current = true;

    if (awaitingBookingConfirmationRef.current) {
      heardUserSinceConfirmationRef.current = true;
    }

    mergeTranscriptEntry(itemId, "user", transcriptText, {
      pending: false,
    });

    if (!countedUserItemIdsRef.current.has(itemId)) {
      countedUserItemIdsRef.current.add(itemId);
      setMetrics((current) => ({
        ...current,
        userTurns: current.userTurns + 1,
      }));
    }

    const clarificationReason = detectClarificationSignal(transcriptText);

    if (clarificationReason) {
      addClarificationSignal(clarificationReason, "transcript");
    }

    const normalizedTranscript = normalizeSpeechText(transcriptText);
    const shouldQueueAutoBook =
      !createdEvent &&
      (isExplicitBookingConfirmation(normalizedTranscript) ||
        (awaitingBookingConfirmationRef.current && isSimpleAffirmation(normalizedTranscript)));
    const shouldAutoBook =
      draft.status === "free" &&
      !createdEvent &&
      shouldAutoBookFreeSlotReply(normalizedTranscript, awaitingBookingConfirmationRef.current);

    if (shouldQueueAutoBook) {
      queueAutoBook(transcriptText);
    }

    if (shouldAutoBook) {
      void autoBookConfirmedMeeting(transcriptText);
    }

    setCallVisualState("thinking");
    responseLatencyClockRef.current = Date.now();
    latencyCapturedForTurnRef.current = false;
  });

  const buildSessionTrace = useEventCallback(
    (reason: string, extra?: Record<string, unknown>) => ({
      auditLog,
      connectionState,
      createdEvent,
      draft,
      errorText,
      exportedAt: new Date().toISOString(),
      metrics,
      reason,
      sessionMemory,
      sessionStartedAt: sessionStartedAtRef.current,
      statusText,
      transcript,
      ...extra,
    }),
  );

  const persistSessionLog = useEventCallback(
    async (reason: string, extra?: Record<string, unknown>) => {
      try {
        const response = await fetch("/api/logs/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildSessionTrace(reason, extra)),
          keepalive: true,
        });

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as { logId?: string };

        if (!data.logId) {
          return;
        }

        setSessionMemory((current) => ({
          ...current,
          lastPersistedLogId: data.logId ?? current.lastPersistedLogId,
        }));
      } catch {
        // Logging should never block the user flow.
      }
    },
  );

  const recordLatency = useEventCallback(() => {
    if (latencyCapturedForTurnRef.current || responseLatencyClockRef.current === null) {
      return;
    }

    const latencyMs = Date.now() - responseLatencyClockRef.current;
    latencyCapturedForTurnRef.current = true;
    latencyStatsRef.current = {
      count: latencyStatsRef.current.count + 1,
      totalMs: latencyStatsRef.current.totalMs + latencyMs,
    };

    setMetrics((current) => ({
      ...current,
      averageAssistantLatencyMs: Math.round(
        latencyStatsRef.current.totalMs / latencyStatsRef.current.count,
      ),
      lastAssistantLatencyMs: latencyMs,
    }));
  });

  const preflightBookingIfNeeded = useEventCallback(
    async (
      resolvedArgs: Record<string, unknown>,
      options?: {
        allowMissingFingerprint?: boolean;
      },
    ) => {
      const existingFingerprint = readString(resolvedArgs.bookingFingerprint);

      if (existingFingerprint || options?.allowMissingFingerprint === false) {
        return resolvedArgs;
      }

      const availabilityPayload = {
        attendeeEmails: normalizeStringArray(resolvedArgs.attendeeEmails) ?? [],
        attendeeName: readString(resolvedArgs.attendeeName),
        durationMinutes: readNumber(resolvedArgs.durationMinutes) ?? 30,
        meetingTitle: readString(resolvedArgs.meetingTitle),
        startIso: readString(resolvedArgs.startIso),
        timezone: readString(resolvedArgs.timezone) ?? draft.timezone ?? timeZone,
      };

      const availabilityResponse = await fetch("/api/calendar/check-availability", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(availabilityPayload),
      });
      const availabilityData = (await availabilityResponse.json()) as AvailabilityResult & {
        error?: string;
      };

      if (!availabilityResponse.ok || !availabilityData.normalizedRequest) {
        throw new Error(
          availabilityData.error ?? "Unable to verify the requested time before booking.",
        );
      }

      setDraft((current) => ({
        ...current,
        alternatives: availabilityData.alternatives,
        attendeeEmails: availabilityData.normalizedRequest.attendeeEmails,
        attendeeName: availabilityData.normalizedRequest.attendeeName,
        bookingFingerprint: availabilityData.normalizedRequest.bookingFingerprint,
        durationMinutes: availabilityData.normalizedRequest.durationMinutes,
        endIso: availabilityData.normalizedRequest.endIso,
        localDateLabel: availabilityData.normalizedRequest.localDateLabel,
        localTimeLabel: availabilityData.normalizedRequest.localTimeLabel,
        meetingTitle: availabilityData.normalizedRequest.meetingTitle,
        parsedDateTimeText: availabilityData.normalizedRequest.parsedDateTimeText,
        preferredDate: availabilityData.normalizedRequest.preferredDate,
        preferredTime: availabilityData.normalizedRequest.preferredTime,
        startIso: availabilityData.normalizedRequest.startIso,
        status: availabilityData.status,
        summaryLine: availabilityData.normalizedRequest.summaryLine,
        timezone: availabilityData.normalizedRequest.timezone,
        warnings: availabilityData.normalizedRequest.warnings,
      }));
      setSessionMemory((current) => ({
        ...current,
        lastAvailability: availabilityData,
      }));
      setMetrics((current) => ({
        ...current,
        availabilityChecks: current.availabilityChecks + 1,
        conflictsFound:
          availabilityData.status === "busy"
            ? current.conflictsFound + 1
            : current.conflictsFound,
      }));

      if (availabilityData.status !== "free") {
        throw new Error(
          availabilityData.alternatives.length
            ? `That time is busy. Try ${availabilityData.alternatives
                .map((alternative) => alternative.displayText)
                .join(" | ")}`
            : "That time is busy. Please choose another slot.",
        );
      }

      return {
        ...resolvedArgs,
        attendeeEmails: availabilityData.normalizedRequest.attendeeEmails,
        attendeeName: availabilityData.normalizedRequest.attendeeName,
        bookingFingerprint: availabilityData.normalizedRequest.bookingFingerprint,
        durationMinutes: availabilityData.normalizedRequest.durationMinutes,
        meetingTitle: availabilityData.normalizedRequest.meetingTitle,
        startIso: availabilityData.normalizedRequest.startIso,
        timezone: availabilityData.normalizedRequest.timezone,
      };
    },
  );

  const applyBookedEvent = useEventCallback(
    (
      event: CalendarEvent,
      options?: {
        logReason?: string;
        logSummary?: string;
        metricIncrement?: boolean;
      },
    ) => {
      setCreatedEvent(event);
      setDraft((current) => ({
        ...current,
        attendeeEmails: event.attendeeEmails,
        attendeeName: event.attendeeName,
        endIso: event.endIso,
        startIso: event.startIso,
        status: "booked",
        timezone: event.timezone,
      }));
      setSessionMemory((current) => ({
        ...current,
        activeEvent: event,
      }));
      setErrorText(null);
      setStatusText("Done. It's on your calendar. Take a quick look at the details below.");
      addSystemNote("The calendar event was created successfully.");
      awaitingBookingConfirmationRef.current = false;
      heardUserSinceConfirmationRef.current = false;

      if (options?.metricIncrement ?? true) {
        setMetrics((current) => ({
          ...current,
          eventsCreated: current.eventsCreated + 1,
        }));
      }

      if (options?.logReason) {
        void persistSessionLog(options.logReason, {
          event,
          summary: options.logSummary,
        });
      }
    },
  );

  const autoBookConfirmedMeeting = useEventCallback(async (confirmationText: string) => {
    if (
      bookingRequestInFlightRef.current ||
      createdEvent ||
      draft.status !== "free" ||
      !draft.attendeeName ||
      !draft.startIso
    ) {
      return false;
    }

    bookingRequestInFlightRef.current = true;
    awaitingBookingConfirmationRef.current = false;
    setCallVisualState("thinking");
    setErrorText(null);
    setStatusText("One sec, I'm adding it to your calendar.");

    try {
      const bookingArgs = await preflightBookingIfNeeded({
        attendeeEmails: draft.attendeeEmails,
        attendeeName: draft.attendeeName,
        bookingFingerprint: draft.bookingFingerprint,
        durationMinutes: draft.durationMinutes ?? 30,
        meetingTitle: draft.meetingTitle,
        startIso: draft.startIso,
        timezone: draft.timezone ?? timeZone,
      });

      const response = await fetch("/api/calendar/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bookingArgs),
      });
      const data = (await response.json()) as {
        error?: string;
        event?: CalendarEvent;
      };

      if (!response.ok || !data.event) {
        throw new Error(data.error ?? "Failed to create the calendar event.");
      }

      applyBookedEvent(data.event, {
        logReason: "voice_confirmation_booked",
        logSummary: confirmationText,
      });

      sendClientEvent({
        type: "response.create",
        response: {
          instructions:
            "A calendar event was just created successfully after the user confirmed the details. Say one short sentence confirming that the meeting has been added to the calendar, using the meeting title if available. Do not mention any links, do not mention viewing it anywhere, and do not ask for confirmation again.",
        },
      });

      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create the calendar event.";

      setErrorText(message);
      setCallVisualState("error");
      setDraft((current) => ({
        ...current,
        status: "error",
      }));
      setStatusText(message);
      addSystemNote(`Auto-booking failed: ${message}`);
      void persistSessionLog("voice_confirmation_booking_failed", {
        confirmationText,
        error: message,
      });
      return false;
    } finally {
      bookingRequestInFlightRef.current = false;
    }
  });

  const queueAutoBook = useEventCallback((confirmationText: string) => {
    pendingAutoBookRef.current = confirmationText;
  });

  const requestWorkflowRecovery = useEventCallback(
    (
      assistantText: string,
      mode: "check" | "book",
      assistantItemId?: string,
    ) => {
      if (!assistantItemId || workflowRecoveryItemIdsRef.current.has(assistantItemId)) {
        return;
      }

      workflowRecoveryItemIdsRef.current.add(assistantItemId);
      setCallVisualState("thinking");
      setErrorText(null);
      setStatusText(
        mode === "book"
          ? "One sec, I'm saving that for real."
          : "One sec, I'm checking that for real.",
      );
      addSystemNote("PingMe is finishing the real calendar workflow before confirming it.");
      void persistSessionLog("workflow_recovery_requested", {
        assistantItemId,
        assistantText,
        draftStatus: draft.status,
        hasCreatedEvent: Boolean(createdEvent),
        mode,
      });

      sendClientEvent({
        type: "response.create",
        response: {
          instructions:
            mode === "book"
              ? heardUserSinceConfirmationRef.current
                ? "You spoke as if the meeting is already booked before the real booking completed. Do not claim success yet. If the latest availability result says the slot is free and the user has just confirmed, immediately call create_calendar_event. Only after create_calendar_event succeeds may you say it is on the calendar or ask about invite emails."
                : "You moved into booking or invite language before the user confirmed the on-screen details. Do not claim success. Ask the user to review the details on screen and tell you if they look right, then stop and wait. Do not ask about invite emails and do not call create_calendar_event until the user responds."
              : "You just moved into calendar-checking or final-confirmation language before the real scheduling workflow finished. Use the details already collected in this conversation to call normalize_meeting_request now, then call check_calendar_availability. Do not invent any user replies, do not continue both sides of the conversation yourself, and do not say the meeting is booked until create_calendar_event succeeds.",
        },
      });
    },
  );

  const executeToolCall = useEventCallback(async (item: RealtimeFunctionCall) => {
    if (!item.call_id || !item.name || handledToolCallIdsRef.current.has(item.call_id)) {
      return;
    }

    handledToolCallIdsRef.current.add(item.call_id);
    const auditId = `tool-${item.call_id}`;
    const startedAt = Date.now();
    const parsedArgs = item.arguments ? (JSON.parse(item.arguments) as Record<string, unknown>) : {};
    const resolvedArgs = resolveToolPayload({
      activeEvent: createdEvent,
      defaultTimeZone: timeZone,
      draft,
      name: item.name,
      payload: parsedArgs,
    });

    setMetrics((current) => ({
      ...current,
      availabilityChecks:
        item.name === "check_calendar_availability"
          ? current.availabilityChecks + 1
          : current.availabilityChecks,
      normalizations:
        item.name === "normalize_meeting_request"
          ? current.normalizations + 1
          : current.normalizations,
      toolCalls: current.toolCalls + 1,
    }));

    addAuditEntry({
      id: auditId,
      name: item.name,
      payload: JSON.stringify(resolvedArgs, null, 2),
      status: "pending",
      summary: describeToolCall(item.name),
      timestamp: timestampLabel(),
    });

    try {
      if (!heardUserAudioRef.current && countedUserItemIdsRef.current.size === 0) {
        setCallVisualState("listening");
        setStatusText("I'm listening. Tell me what you'd like to schedule.");
        updateAuditEntry(auditId, {
          durationMs: Date.now() - startedAt,
          status: "error",
          summary: "Waiting for real user speech before using tools.",
        });
        addSystemNote("Waiting for the user to speak before I use any scheduling tools.");

        sendFunctionOutput(
          item.call_id,
          {
            success: false,
            requiresUserInput: true,
            error: "Wait for actual user input before using tools.",
          },
          "You have not received any real user speech yet. Do not assume details, do not use tools, and do not continue the conversation on the user's behalf. Ask one short question at most, then wait silently for the user to answer.",
        );
        return;
      }

      if (item.name === "normalize_meeting_request") {
        setCallVisualState("thinking");
        const response = await fetch("/api/scheduling/normalize", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(resolvedArgs),
        });
        const data = (await response.json()) as NormalizationResult & { error?: string };

        if (!response.ok || !data.normalizedRequest) {
          throw new Error(data.error ?? "Failed to normalize the meeting request.");
        }

        const normalizedRequest = data.normalizedRequest;
        const isRevision =
          Boolean(draft.startIso) &&
          (draft.startIso !== normalizedRequest.startIso ||
            draft.meetingTitle !== normalizedRequest.meetingTitle ||
            draft.attendeeName !== normalizedRequest.attendeeName ||
            draft.durationMinutes !== normalizedRequest.durationMinutes ||
            draft.timezone !== normalizedRequest.timezone ||
            !areEmailListsEqual(draft.attendeeEmails, normalizedRequest.attendeeEmails));

        setDraft((current) => ({
          alternatives: [],
          attendeeEmails: normalizedRequest.attendeeEmails,
          attendeeName: normalizedRequest.attendeeName,
          bookingFingerprint: normalizedRequest.bookingFingerprint,
          durationMinutes: normalizedRequest.durationMinutes,
          endIso: normalizedRequest.endIso,
          localDateLabel: normalizedRequest.localDateLabel,
          localTimeLabel: normalizedRequest.localTimeLabel,
          meetingTitle: normalizedRequest.meetingTitle,
          parsedDateTimeText: normalizedRequest.parsedDateTimeText,
          preferredDate: data.rawInput.preferredDate,
          preferredTime: data.rawInput.preferredTime,
          revisionCount: isRevision ? current.revisionCount + 1 : current.revisionCount,
          startIso: normalizedRequest.startIso,
          status: "normalized",
          summaryLine: normalizedRequest.summaryLine,
          timezone: normalizedRequest.timezone,
          warnings: normalizedRequest.warnings,
        }));
        setSessionMemory((current) => ({
          ...current,
          lastNormalization: data,
        }));
        trackLatestToolResult(item.name, data);
        setErrorText(null);

        if (isRevision) {
          setMetrics((current) => ({
            ...current,
            revisions: current.revisions + 1,
          }));
        }

        updateAuditEntry(auditId, {
          durationMs: Date.now() - startedAt,
          status: "success",
          summary: `Normalized slot: ${normalizedRequest.summaryLine}`,
        });

        setStatusText("Got it. Let me check that time.");

        sendFunctionOutput(
          item.call_id,
          {
            success: true,
            ...data,
          },
          "The meeting details are normalized. Briefly tell the user you're checking the calendar now, then immediately call check_calendar_availability using the latest normalized slot. Do not ask another question yet, do not ask about invite emails, and do not say the meeting is booked.",
        );

        return;
      }

      if (item.name === "check_calendar_availability") {
        setCallVisualState("thinking");
        setDraft((current) => ({
          ...current,
          attendeeEmails:
            normalizeStringArray(resolvedArgs.attendeeEmails) ?? current.attendeeEmails,
          attendeeName:
            typeof resolvedArgs.attendeeName === "string"
              ? resolvedArgs.attendeeName
              : current.attendeeName,
          durationMinutes:
            typeof resolvedArgs.durationMinutes === "number"
              ? resolvedArgs.durationMinutes
              : current.durationMinutes,
          meetingTitle:
            typeof resolvedArgs.meetingTitle === "string"
              ? resolvedArgs.meetingTitle
              : current.meetingTitle,
          startIso:
            typeof resolvedArgs.startIso === "string" ? resolvedArgs.startIso : current.startIso,
          status: "checking",
          timezone:
            typeof resolvedArgs.timezone === "string" ? resolvedArgs.timezone : current.timezone,
        }));

        const response = await fetch("/api/calendar/check-availability", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(resolvedArgs),
        });
        const data = (await response.json()) as AvailabilityResult & { error?: string };

        if (!response.ok || !data.normalizedRequest) {
          throw new Error(data.error ?? "Failed to check calendar availability.");
        }

        setDraft((current) => ({
          ...current,
          alternatives: data.alternatives,
          attendeeEmails: data.normalizedRequest.attendeeEmails,
          attendeeName: data.normalizedRequest.attendeeName,
          bookingFingerprint: data.normalizedRequest.bookingFingerprint,
          durationMinutes: data.normalizedRequest.durationMinutes,
          endIso: data.normalizedRequest.endIso,
          localDateLabel: data.normalizedRequest.localDateLabel,
          localTimeLabel: data.normalizedRequest.localTimeLabel,
          meetingTitle: data.normalizedRequest.meetingTitle,
          parsedDateTimeText: data.normalizedRequest.parsedDateTimeText,
          preferredDate: data.normalizedRequest.preferredDate,
          preferredTime: data.normalizedRequest.preferredTime,
          startIso: data.normalizedRequest.startIso,
          status: data.status,
          summaryLine: data.normalizedRequest.summaryLine,
          timezone: data.normalizedRequest.timezone,
          warnings: data.normalizedRequest.warnings,
        }));
        setSessionMemory((current) => ({
          ...current,
          lastAvailability: data,
        }));
        trackLatestToolResult(item.name, data);
        setErrorText(null);

        if (data.status === "busy") {
          setMetrics((current) => ({
            ...current,
            conflictsFound: current.conflictsFound + 1,
          }));
        }

        updateAuditEntry(auditId, {
          durationMs: Date.now() - startedAt,
          status: "success",
          summary:
            data.status === "free"
              ? `Slot is free. ${data.normalizedRequest.summaryLine}`
              : `Slot is busy. Returned ${data.alternatives.length} alternative option(s).`,
        });

        setStatusText(
          data.status === "free"
            ? "That time works. I'll confirm it before I book."
            : "That time is taken. I'll help you pick another one.",
        );
        awaitingBookingConfirmationRef.current = data.status === "free";
        heardUserSinceConfirmationRef.current = false;

        sendFunctionOutput(
          item.call_id,
          {
            success: true,
            ...data,
          },
          data.status === "free"
            ? "The slot is free. If the duration has not been explicitly confirmed yet, ask how long the meeting should be. If the user has not already given invite emails or clearly declined invitees, ask whether they want to invite anyone and say clearly that this is optional. Once those optional details are settled, summarize the details on screen and ask if everything looks right. Stop after that confirmation question and do not call create_calendar_event until the user responds."
            : "The slot is busy. Briefly explain that it is unavailable, offer the alternative times that were returned, and stop so the user can choose one.",
        );

        return;
      }

      if (item.name === "create_calendar_event") {
        if (createdEvent) {
          updateAuditEntry(auditId, {
            durationMs: Date.now() - startedAt,
            status: "success",
            summary: `Already booked. ${createdEvent.summary} is already on the calendar.`,
          });

          sendFunctionOutput(item.call_id, {
            alreadyBooked: true,
            event: createdEvent,
            success: true,
          });
          return;
        }

        if (awaitingBookingConfirmationRef.current && !heardUserSinceConfirmationRef.current) {
          updateAuditEntry(auditId, {
            durationMs: Date.now() - startedAt,
            status: "success",
            summary: "Waiting for the user's confirmation before booking.",
          });
          setStatusText("Take a quick look at the details, then tell me if it looks right.");

          sendFunctionOutput(
            item.call_id,
            {
              success: false,
              requiresConfirmation: true,
              message: "Wait for the user's confirmation before booking.",
            },
            "You tried to book before the user confirmed the on-screen details. Do not say the meeting is booked. Ask them to review the details on screen and tell you if they look right, then stop and wait.",
          );
          return;
        }

        setCallVisualState("thinking");
        setStatusText("One sec, I'm adding it to your calendar.");
        const bookingArgs = await preflightBookingIfNeeded(resolvedArgs);

        const response = await fetch("/api/calendar/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(bookingArgs),
        });
        const data = (await response.json()) as {
          error?: string;
          event?: CalendarEvent;
        };

        if (!response.ok || !data.event) {
          throw new Error(data.error ?? "Failed to create the calendar event.");
        }

        const event = data.event;

        trackLatestToolResult(item.name, data);
        applyBookedEvent(event, {
          logReason: "event_created",
        });

        updateAuditEntry(auditId, {
          durationMs: Date.now() - startedAt,
          status: "success",
          summary: `Booked successfully. ${event.summary} created in Google Calendar.`,
        });

        sendFunctionOutput(item.call_id, {
          success: true,
          event: {
            attendeeEmails: event.attendeeEmails,
            attendeeName: event.attendeeName,
            durationMinutes: event.durationMinutes,
            endIso: event.endIso,
            id: event.id,
            startIso: event.startIso,
            summary: event.summary,
            timezone: event.timezone,
          },
        });

        return;
      }

      if (item.name === "reschedule_calendar_event") {
        setCallVisualState("thinking");
        setStatusText("One sec, I'm moving it.");

        const response = await fetch("/api/calendar/reschedule", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(resolvedArgs),
        });
        const data = (await response.json()) as {
          error?: string;
          event?: CalendarEvent;
        };

        if (!response.ok || !data.event) {
          throw new Error(data.error ?? "Failed to reschedule the calendar event.");
        }

        const event = data.event;

        setCreatedEvent(event);
        setDraft((current) => ({
          ...current,
          attendeeEmails: event.attendeeEmails,
          attendeeName: event.attendeeName,
          endIso: event.endIso,
          startIso: event.startIso,
          status: "booked",
          timezone: event.timezone,
        }));
        setSessionMemory((current) => ({
          ...current,
          activeEvent: event,
        }));
        trackLatestToolResult(item.name, data);
        setErrorText(null);
        setMetrics((current) => ({
          ...current,
          reschedules: current.reschedules + 1,
        }));
        setStatusText("Done. I moved it.");
        addSystemNote("The calendar event was rescheduled successfully.");
        void persistSessionLog("event_rescheduled", {
          event,
        });

        updateAuditEntry(auditId, {
          durationMs: Date.now() - startedAt,
          status: "success",
          summary: `Rescheduled successfully. ${event.summary} was moved to the updated slot.`,
        });

        sendFunctionOutput(item.call_id, {
          success: true,
          event,
        });

        return;
      }

      if (item.name === "cancel_calendar_event") {
        setCallVisualState("thinking");
        setStatusText("One sec, I'm cancelling it.");

        const response = await fetch("/api/calendar/cancel", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(resolvedArgs),
        });
        const data = (await response.json()) as CancellationResult & { error?: string };

        if (!response.ok || data.status !== "cancelled") {
          throw new Error(data.error ?? "Failed to cancel the calendar event.");
        }

        setCreatedEvent(null);
        setDraft((current) => ({
          ...current,
          bookingFingerprint: undefined,
          status: "cancelled",
        }));
        setSessionMemory((current) => ({
          ...current,
          activeEvent: null,
        }));
        trackLatestToolResult(item.name, data);
        setErrorText(null);
        setMetrics((current) => ({
          ...current,
          cancellations: current.cancellations + 1,
        }));
        setStatusText("Done. It's been cancelled.");
        addSystemNote("The calendar event was cancelled successfully.");
        void persistSessionLog("event_cancelled", {
          cancellation: data,
        });

        updateAuditEntry(auditId, {
          durationMs: Date.now() - startedAt,
          status: "success",
          summary: `Cancelled successfully. ${data.summary} was removed from Google Calendar.`,
        });

        sendFunctionOutput(item.call_id, {
          success: true,
          ...data,
        });

        return;
      }

      throw new Error(`Unhandled tool: ${item.name}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected error executing tool call.";

      setErrorText(message);
      setCallVisualState("error");
      setStatusText(message);
      setDraft((current) => ({
        ...current,
        status: "error",
      }));
      trackLatestToolResult(item.name, {
        error: message,
      });
      addSystemNote(`Tool execution failed: ${message}`);
      void persistSessionLog("tool_error", {
        error: message,
        toolName: item.name,
      });

      const clarificationReason = looksLikeClarificationIssue(message);

      if (clarificationReason) {
        addClarificationSignal(clarificationReason, "tool");
      }

      updateAuditEntry(auditId, {
        durationMs: Date.now() - startedAt,
        status: "error",
        summary: message,
      });

      sendFunctionOutput(item.call_id, {
        success: false,
        error: message,
      });
    }
  });

  const handleServerEvent = useEventCallback((serverEvent: RealtimeServerEvent) => {
    if (!serverEvent.type) {
      return;
    }

    if (serverEvent.type === "session.created") {
      addSystemNote("Connected to Azure OpenAI Realtime. Applying session instructions.");
      configureSession();
      return;
    }

    if (serverEvent.type === "session.updated") {
      announceKickoff();
      return;
    }

    if (
      serverEvent.type === "conversation.item.input_audio_transcription.completed" ||
      serverEvent.type === "conversation.item.audio_transcription.completed"
    ) {
      const transcriptText = typeof serverEvent.transcript === "string" ? serverEvent.transcript : "";

      if (transcriptText && serverEvent.item_id) {
        registerUserTranscript(serverEvent.item_id, transcriptText);
      }

      return;
    }

    if (serverEvent.type === "input_audio_buffer.speech_started") {
      clearPendingResponseKick();
      heardUserAudioRef.current = true;

      if (awaitingBookingConfirmationRef.current) {
        heardUserSinceConfirmationRef.current = true;
      }

      return;
    }

    if (serverEvent.type === "input_audio_buffer.speech_stopped") {
      schedulePendingResponseKick();
      return;
    }

    if (serverEvent.type === "conversation.item.done") {
      const role = serverEvent.item?.role;
      const text = extractItemText(serverEvent.item);

      if (serverEvent.item?.id && text && (role === "user" || role === "assistant")) {
        const isAssistantContinuingWithoutUser =
          role === "assistant" &&
          !heardUserAudioRef.current &&
          countedUserItemIdsRef.current.size === 0 &&
          countedAssistantItemIdsRef.current.size >= 1 &&
          !countedAssistantItemIdsRef.current.has(serverEvent.item.id);

        if (isAssistantContinuingWithoutUser) {
          blockedAssistantItemIdsRef.current.add(serverEvent.item.id);
          setCallVisualState("listening");
          setStatusText("I'm listening. Tell me what you'd like to schedule.");
          addSystemNote("PingMe is waiting for you to answer before continuing.");
          void persistSessionLog("assistant_done_blocked_without_user", {
            assistantItemId: serverEvent.item.id,
          });
          return;
        }

        if (role === "assistant" && blockedAssistantItemIdsRef.current.has(serverEvent.item.id)) {
          removeTranscriptEntry(serverEvent.item.id);
          blockedAssistantItemIdsRef.current.delete(serverEvent.item.id);
          return;
        }

        if (role === "user") {
          registerUserTranscript(serverEvent.item.id, text);
        } else {
          mergeTranscriptEntry(serverEvent.item.id, role, text, {
            pending: false,
          });
        }

        if (role === "assistant" && !countedAssistantItemIdsRef.current.has(serverEvent.item.id)) {
          clearPendingResponseKick();
          countedAssistantItemIdsRef.current.add(serverEvent.item.id);
          setMetrics((current) => ({
            ...current,
            assistantTurns: current.assistantTurns + 1,
          }));
        }

        if (role === "assistant") {
          const normalizedAssistantText = normalizeSpeechText(text);
          const askedForInviteDetails = assistantAskedForInviteDetails(normalizedAssistantText);
          const askedForBookingConfirmation = assistantAskedForBookingConfirmation(
            normalizedAssistantText,
          );
          const claimedBooked = assistantClaimsBooked(normalizedAssistantText);
          const claimedChecking = assistantClaimsCalendarCheck(normalizedAssistantText);

          if (askedForBookingConfirmation) {
            awaitingBookingConfirmationRef.current = true;
            heardUserSinceConfirmationRef.current = false;
          } else if (createdEvent && (askedForInviteDetails || claimedBooked)) {
            awaitingBookingConfirmationRef.current = false;
            heardUserSinceConfirmationRef.current = false;
          }

          if (!createdEvent && claimedBooked) {
            if (draft.status !== "free" || !draft.attendeeName || !draft.startIso) {
              requestWorkflowRecovery(text, "book", serverEvent.item.id);
            } else if (!heardUserSinceConfirmationRef.current) {
              requestWorkflowRecovery(text, "book", serverEvent.item.id);
            }
          } else if (
            !createdEvent &&
            askedForInviteDetails &&
            draft.status !== "free"
          ) {
            requestWorkflowRecovery(text, "check", serverEvent.item.id);
          } else if (
            !createdEvent &&
            claimedChecking &&
            !draft.attendeeName &&
            !draft.startIso
          ) {
            requestWorkflowRecovery(text, "check", serverEvent.item.id);
          }
        }
      }

      return;
    }

    if (serverEvent.type === "response.output_audio_transcript.delta") {
      if (!serverEvent.item_id || typeof serverEvent.delta !== "string") {
        return;
      }

      const isAssistantContinuingWithoutUser =
        !heardUserAudioRef.current &&
        countedUserItemIdsRef.current.size === 0 &&
        countedAssistantItemIdsRef.current.size >= 1 &&
        !countedAssistantItemIdsRef.current.has(serverEvent.item_id);

      if (isAssistantContinuingWithoutUser) {
        if (!blockedAssistantItemIdsRef.current.has(serverEvent.item_id)) {
          blockedAssistantItemIdsRef.current.add(serverEvent.item_id);
          sendClientEvent({
            type: "response.cancel",
          });
          setCallVisualState("listening");
          setStatusText("I'm listening. Tell me what you'd like to schedule.");
          addSystemNote("PingMe is waiting for you to answer before continuing.");
          void persistSessionLog("assistant_continuation_cancelled", {
            assistantItemId: serverEvent.item_id,
          });
        }

        return;
      }

      if (blockedAssistantItemIdsRef.current.has(serverEvent.item_id)) {
        return;
      }

      recordLatency();
      clearPendingResponseKick();
      setCallVisualState("speaking");
      mergeTranscriptEntry(serverEvent.item_id, "assistant", serverEvent.delta, {
        mode: "append",
        pending: true,
      });
      return;
    }

    if (serverEvent.type === "response.output_audio_transcript.done") {
      if (!serverEvent.item_id) {
        return;
      }

      if (blockedAssistantItemIdsRef.current.has(serverEvent.item_id)) {
        removeTranscriptEntry(serverEvent.item_id);
        blockedAssistantItemIdsRef.current.delete(serverEvent.item_id);
        setCallVisualState("listening");
        return;
      }

      const finalText =
        typeof serverEvent.transcript === "string" ? serverEvent.transcript : undefined;

      if (finalText) {
        mergeTranscriptEntry(serverEvent.item_id, "assistant", finalText, {
          pending: false,
        });
      } else {
        mergeTranscriptEntry(serverEvent.item_id, "assistant", "", {
          mode: "append",
          pending: false,
        });
      }

      clearPendingResponseKick();
      setCallVisualState("listening");

      return;
    }

    if (serverEvent.type === "response.done") {
      clearPendingResponseKick();
      if (serverEvent.response?.status === "failed") {
        const reason =
          serverEvent.response.status_details?.reason ??
          serverEvent.error?.message ??
          "The realtime response failed.";

        setErrorText(reason);
        setCallVisualState("error");
        setConnectionState("error");
        setStatusText(reason);
        addSystemNote(`Realtime response failed: ${reason}`);
        void persistSessionLog("realtime_response_failed", {
          error: reason,
        });
        return;
      }

      for (const item of serverEvent.response?.output ?? []) {
        if ("type" in item && item.type === "function_call") {
          void executeToolCall(item as RealtimeFunctionCall);
        }
      }

      return;
    }

    if (serverEvent.type === "error" || serverEvent.code) {
      const message =
        serverEvent.error?.message ??
        (typeof serverEvent.code === "string" ? serverEvent.code : "Realtime session error.");

      setErrorText(message);
      setCallVisualState("error");
      setConnectionState("error");
      setStatusText(message);
      addSystemNote(`Realtime error: ${message}`);
      void persistSessionLog("realtime_error", {
        error: message,
      });
    }
  });

  const startSession = useEventCallback(async () => {
    try {
      cleanupSession();
      resetSessionState();
      setErrorText(null);
      setConnectionState("connecting");
      setCallVisualState("thinking");
      setStatusText("Getting everything ready...");
      sessionStartedAtRef.current = new Date().toISOString();

      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      localStreamRef.current = localStream;

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;
      remoteAudioRef.current = remoteAudio;

      peerConnection.ontrack = (event) => {
        remoteAudio.srcObject = event.streams[0] ?? null;
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === "connected") {
          setConnectionState("connected");
          setCallVisualState("thinking");
        }

        if (peerConnection.connectionState === "failed") {
          setConnectionState("error");
          setCallVisualState("error");
          setStatusText("I lost the connection.");
        }
      };

      localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;

      dataChannel.addEventListener("open", () => {
        addSystemNote("Data channel connected. Waiting for the realtime session to finish setup.");
      });

      dataChannel.addEventListener("message", (event) => {
        const parsedEvent = JSON.parse(event.data) as RealtimeServerEvent;
        handleServerEvent(parsedEvent);
      });

      dataChannel.addEventListener("close", () => {
        addSystemNote("The realtime session closed.");
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const response = await fetch("/api/realtime/session", {
        method: "POST",
        body: offer.sdp,
        headers: {
          "Content-Type": "application/sdp",
        },
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Unable to create the realtime session.");
      }

      const answer = await response.text();
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: answer,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to start the realtime session.";
      cleanupSession();
      setConnectionState("error");
      setCallVisualState("error");
      setErrorText(message);
      setStatusText("I couldn't start just yet.");
      void persistSessionLog("session_start_error", {
        error: message,
      });
    }
  });

  const stopSession = useEventCallback(() => {
    cleanupSession();
    setConnectionState("idle");
    setCallVisualState("idle");
    setErrorText(null);
    setStatusText("Stopped. Start talking again whenever you're ready.");
    void persistSessionLog("session_stopped");
  });

  const scheduleNewEvent = useEventCallback(() => {
    void persistSessionLog("schedule_new_event");
    resetSessionState();
    setStatusText("Ready for a fresh start.");
  });

  const exportTrace = useEventCallback(() => {
    const trace = buildSessionTrace("manual_export");
    const blob = new Blob([JSON.stringify(trace, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `voice-agent-trace-${new Date()
      .toISOString()
      .replaceAll(":", "-")
      .replaceAll(".", "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    void persistSessionLog("manual_export");
  });

  const openManualOverride = useEventCallback(() => {
    setManualOverrideOpen(true);
    setManualOverrideError(null);
    setManualOverrideState((current) => (current === "saving" ? current : "idle"));
  });

  const startAnotherBooking = useEventCallback(() => {
    setCreatedEvent(null);
    setDraft(initialDraftState);
    setErrorText(null);
    setManualOverrideOpen(false);
    setManualOverrideState("idle");
    setManualOverrideError(null);
    setSessionMemory(initialSessionMemory);
    setShowFullTranscript(false);
    setTranscript([]);

    if (connectionState === "connected") {
      setCallVisualState("thinking");
      setStatusText("Ready for the next one.");
      addSystemNote("Preparing a fresh scheduling flow for the next booking.");
      sendClientEvent({
        type: "response.create",
        response: {
          instructions:
            "Start a fresh scheduling flow. Greet the user briefly, ask what they would like to schedule, and keep the tone calm, concise, and human.",
        },
      });
      return;
    }

    setCallVisualState("idle");
    setStatusText("Ready for the next one whenever you are.");
  });

  const applyManualOverride = useEventCallback(async () => {
    const activeEvent = createdEvent;
    const attendeeName = manualOverrideForm.attendeeName.trim() || draft.attendeeName;
    const preferredDate = manualOverrideForm.preferredDate.trim();
    const preferredTime = manualOverrideForm.preferredTime.trim();

    if (!attendeeName) {
      setManualOverrideError("Please add a name before applying manual edits.");
      setManualOverrideState("editing");
      return;
    }

    if (!preferredDate || !preferredTime) {
      setManualOverrideError("Please choose both a date and time before updating the slot.");
      setManualOverrideState("editing");
      return;
    }

    setManualOverrideState("saving");
    setManualOverrideError(null);
    setStatusText("Got it. I'm updating that.");
    setCallVisualState("thinking");

    try {
      const normalizePayload = {
        attendeeEmails: parseEmailList(manualOverrideForm.attendeeEmailsText),
        attendeeName,
        durationMinutes: Number(manualOverrideForm.durationMinutes) || 30,
        meetingTitle: manualOverrideForm.meetingTitle.trim() || undefined,
        preferredDate,
        preferredTime,
        timezone: draft.timezone ?? timeZone,
      };

      const normalizedResponse = await fetch("/api/scheduling/normalize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(normalizePayload),
      });
      const normalizedData = (await normalizedResponse.json()) as NormalizationResult & {
        error?: string;
      };

      if (!normalizedResponse.ok || !normalizedData.normalizedRequest) {
        throw new Error(normalizedData.error ?? "Unable to normalize the updated details.");
      }

      setDraft((current) => ({
        alternatives: [],
        attendeeEmails: normalizedData.normalizedRequest.attendeeEmails,
        attendeeName: normalizedData.normalizedRequest.attendeeName,
        bookingFingerprint: normalizedData.normalizedRequest.bookingFingerprint,
        durationMinutes: normalizedData.normalizedRequest.durationMinutes,
        endIso: normalizedData.normalizedRequest.endIso,
        localDateLabel: normalizedData.normalizedRequest.localDateLabel,
        localTimeLabel: normalizedData.normalizedRequest.localTimeLabel,
        meetingTitle: normalizedData.normalizedRequest.meetingTitle,
        parsedDateTimeText: normalizedData.normalizedRequest.parsedDateTimeText,
        preferredDate: normalizedData.rawInput.preferredDate,
        preferredTime: normalizedData.rawInput.preferredTime,
        revisionCount: current.revisionCount + 1,
        startIso: normalizedData.normalizedRequest.startIso,
        status: "normalized",
        summaryLine: normalizedData.normalizedRequest.summaryLine,
        timezone: normalizedData.normalizedRequest.timezone,
        warnings: normalizedData.normalizedRequest.warnings,
      }));
      setSessionMemory((current) => ({
        ...current,
        lastNormalization: normalizedData,
      }));
      setMetrics((current) => ({
        ...current,
        normalizations: current.normalizations + 1,
        revisions: current.revisions + 1,
      }));

      const availabilityResponse = await fetch("/api/calendar/check-availability", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attendeeEmails: normalizedData.normalizedRequest.attendeeEmails,
          attendeeName: normalizedData.normalizedRequest.attendeeName,
          durationMinutes: normalizedData.normalizedRequest.durationMinutes,
          meetingTitle: normalizedData.normalizedRequest.meetingTitle,
          startIso: normalizedData.normalizedRequest.startIso,
          timezone: normalizedData.normalizedRequest.timezone,
        }),
      });
      const availabilityData = (await availabilityResponse.json()) as AvailabilityResult & {
        error?: string;
      };

      if (!availabilityResponse.ok || !availabilityData.normalizedRequest) {
        throw new Error(availabilityData.error ?? "Unable to check the updated availability.");
      }

      setDraft((current) => ({
        ...current,
        alternatives: availabilityData.alternatives,
        attendeeEmails: availabilityData.normalizedRequest.attendeeEmails,
        attendeeName: availabilityData.normalizedRequest.attendeeName,
        bookingFingerprint: availabilityData.normalizedRequest.bookingFingerprint,
        durationMinutes: availabilityData.normalizedRequest.durationMinutes,
        endIso: availabilityData.normalizedRequest.endIso,
        localDateLabel: availabilityData.normalizedRequest.localDateLabel,
        localTimeLabel: availabilityData.normalizedRequest.localTimeLabel,
        meetingTitle: availabilityData.normalizedRequest.meetingTitle,
        parsedDateTimeText: availabilityData.normalizedRequest.parsedDateTimeText,
        preferredDate: availabilityData.normalizedRequest.preferredDate,
        preferredTime: availabilityData.normalizedRequest.preferredTime,
        startIso: availabilityData.normalizedRequest.startIso,
        status: availabilityData.status,
        summaryLine: availabilityData.normalizedRequest.summaryLine,
        timezone: availabilityData.normalizedRequest.timezone,
        warnings: availabilityData.normalizedRequest.warnings,
      }));
      setSessionMemory((current) => ({
        ...current,
        lastAvailability: availabilityData,
      }));
      setMetrics((current) => ({
        ...current,
        availabilityChecks: current.availabilityChecks + 1,
        conflictsFound:
          availabilityData.status === "busy" ? current.conflictsFound + 1 : current.conflictsFound,
      }));

      if (activeEvent && availabilityData.status === "free") {
        const updatedEventResponse = await fetch("/api/calendar/reschedule", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            attendeeEmails: availabilityData.normalizedRequest.attendeeEmails,
            attendeeName: availabilityData.normalizedRequest.attendeeName,
            bookingFingerprint: availabilityData.normalizedRequest.bookingFingerprint,
            durationMinutes: availabilityData.normalizedRequest.durationMinutes,
            eventId: activeEvent.id,
            meetingTitle: availabilityData.normalizedRequest.meetingTitle,
            startIso: availabilityData.normalizedRequest.startIso,
            timezone: availabilityData.normalizedRequest.timezone,
          }),
        });
        const updatedEventData = (await updatedEventResponse.json()) as {
          error?: string;
          event?: CalendarEvent;
        };

        if (!updatedEventResponse.ok || !updatedEventData.event) {
          throw new Error(updatedEventData.error ?? "Unable to update the saved calendar event.");
        }

        const updatedEvent = updatedEventData.event;

        setCreatedEvent(updatedEvent);
        setDraft({
          alternatives: [],
          attendeeEmails: updatedEvent.attendeeEmails,
          attendeeName: updatedEvent.attendeeName,
          bookingFingerprint: availabilityData.normalizedRequest.bookingFingerprint,
          durationMinutes: updatedEvent.durationMinutes,
          endIso: updatedEvent.endIso,
          localDateLabel: availabilityData.normalizedRequest.localDateLabel,
          localTimeLabel: availabilityData.normalizedRequest.localTimeLabel,
          meetingTitle: availabilityData.normalizedRequest.meetingTitle,
          parsedDateTimeText: availabilityData.normalizedRequest.parsedDateTimeText,
          preferredDate: availabilityData.normalizedRequest.preferredDate,
          preferredTime: availabilityData.normalizedRequest.preferredTime,
          revisionCount: draft.revisionCount + 1,
          startIso: updatedEvent.startIso,
          status: "booked",
          summaryLine: availabilityData.normalizedRequest.summaryLine,
          timezone: updatedEvent.timezone,
          warnings: availabilityData.normalizedRequest.warnings,
        });
        setSessionMemory((current) => ({
          ...current,
          activeEvent: updatedEvent,
          lastAvailability: availabilityData,
        }));
        setMetrics((current) => ({
          ...current,
          reschedules:
            updatedEvent.startIso !== activeEvent.startIso
              ? current.reschedules + 1
              : current.reschedules,
          revisions: current.revisions + 1,
        }));

        setManualOverrideState("applied");
        setManualOverrideOpen(false);
        setStatusText("Your saved event has been updated.");
        setCallVisualState("listening");
        setErrorText(null);
        addSystemNote("The saved event was updated successfully.");
        void persistSessionLog("manual_override_event_updated", {
          availability: availabilityData,
          event: updatedEvent,
        });
        return;
      }

      setManualOverrideState("applied");
      setManualOverrideOpen(availabilityData.status === "busy");
      setStatusText(
        availabilityData.status === "free"
          ? "Manual edits applied. Please confirm the updated details."
          : "Manual edits applied. The chosen time is busy, so another slot is needed.",
      );
      setCallVisualState("listening");
      void persistSessionLog("manual_override_applied", {
        availability: availabilityData,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to apply the manual updates.";
      setManualOverrideError(message);
      setManualOverrideState("editing");
      setCallVisualState("error");
      void persistSessionLog("manual_override_failed", {
        error: message,
      });
    }
  });

  useEffect(() => {
    if (
      !pendingAutoBookRef.current ||
      bookingRequestInFlightRef.current ||
      createdEvent ||
      draft.status !== "free" ||
      !draft.attendeeName ||
      !draft.startIso
    ) {
      return;
    }

    const confirmationText = pendingAutoBookRef.current;
    pendingAutoBookRef.current = null;
    void autoBookConfirmedMeeting(confirmationText);
  }, [autoBookConfirmedMeeting, createdEvent, draft.attendeeName, draft.startIso, draft.status]);

  const visibleTranscript = transcript.filter((entry) => entry.role !== "system");
  const transcriptItems = showFullTranscript ? visibleTranscript : visibleTranscript.slice(-4);
  const extractedChips = buildExtractionChips(draft);
  const informationGrid = buildInformationGrid(draft, errorText, connectionState);
  const dayAgenda = sessionMemory.lastAvailability?.dayAgenda ?? [];
  const currentStep = getCurrentProgressStep(draft, createdEvent);
  const progressSteps = buildProgressSteps(currentStep);
  const missingRequiredFields = getMissingRequiredFields(draft);
  const statusTone = createdEvent
    ? "success"
    : errorText
      ? "error"
      : callVisualState === "thinking"
        ? "thinking"
        : "neutral";
  const shouldShowRetryAction = (Boolean(errorText) || connectionState === "error") && connectionState !== "connecting";

  useEffect(() => {
    const container = transcriptFeedRef.current;

    if (!container) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior: visibleTranscript.length > 1 ? "smooth" : "auto",
    });
  }, [showFullTranscript, visibleTranscript.length]);

  return (
    <section className="assistant-card">
      <div className="assistant-topbar">
        <div>
          <p className="eyebrow">PingMe</p>
          <h2>I&apos;m ready when you are</h2>
          <p>
            Tell me what you&apos;d like to schedule. I&apos;ll grab the details and get it on your calendar.
          </p>
        </div>

        <div className="status-stack">
          <div className="status-pill">
            <span className="small-label">Status</span>
            <div className="status-value">{formatConnectionStateLabel(connectionState)}</div>
          </div>
          <div className={`recording-pill ${connectionState === "connected" ? "live" : "idle"}`}>
            <span className="recording-dot" />
            {connectionState === "connected"
              ? "Mic on"
              : connectionState === "connecting"
                ? "Turning mic on"
                : "Mic off"}
          </div>
        </div>
      </div>

      <div className="controls">
        <button
          className="primary-button"
          disabled={connectionState === "connecting"}
          onClick={() => void startSession()}
          type="button"
        >
          {connectionState === "idle" || connectionState === "error" ? "Start Talking" : "Start over"}
        </button>

        <button
          className="secondary-button"
          disabled={connectionState === "idle" || connectionState === "connecting"}
          onClick={stopSession}
          type="button"
        >
          Stop
        </button>

        {connectionState === "idle" && visibleTranscript.length ? (
          <button className="secondary-button" onClick={scheduleNewEvent} type="button">
            Schedule New Event
          </button>
        ) : null}

      </div>

      <div className={`status-copy ${statusTone}`}>
        <div className="status-copy-topline">
          <strong>{getUserFacingStatus(errorText, statusText)}</strong>
          {callVisualState === "thinking" && !errorText ? (
            <span className="status-inline-pill">Thinking...</span>
          ) : null}
        </div>
        <p>{getUserFacingSubtext(connectionState, draft.status, createdEvent !== null, errorText)}</p>
        {shouldShowRetryAction ? (
          <div className="status-actions">
            <button
              className="secondary-button"
              onClick={() => void startSession()}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>

      <section className="progress-strip" aria-label="Booking progress">
        {progressSteps.map((step) => (
          <div className={`progress-step ${step.tone}`} key={step.label}>
            <div className="progress-marker">
              <span>{step.index}</span>
            </div>
            <div className="progress-copy">
              <strong>{step.label}</strong>
              <p>{step.caption}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="live-layout">
        <article className="call-stage-card">
          <div className="panel-header">
            <h3>Conversation</h3>
            {visibleTranscript.length > 4 ? (
              <button
                className="text-button"
                onClick={() => setShowFullTranscript((current) => !current)}
                type="button"
              >
                {showFullTranscript ? "Show latest" : "View full"}
              </button>
            ) : (
              <span>Latest turns</span>
            )}
          </div>

          <div className={`waveform ${callVisualState}`} aria-hidden="true">
            {Array.from({ length: 9 }).map((_, index) => (
              <span key={index} style={{ animationDelay: `${index * 90}ms` }} />
            ))}
          </div>

          <div className="chip-strip">
            {extractedChips.length ? (
              extractedChips.map((chip) => (
                <span className={`data-chip ${chip.status}`} key={chip.label}>
                  {chip.label}: {chip.value}
                </span>
              ))
            ) : (
              <span className="data-chip pending">Listening... I'll fill these in as we go.</span>
            )}
          </div>

          <div className="transcript-feed" ref={transcriptFeedRef}>
            {visibleTranscript.length ? (
              transcriptItems.map((entry) => (
                <article className={`feed-item ${entry.role}`} key={entry.id}>
                  <span>{entry.role === "assistant" ? "PingMe" : "You"}</span>
                  <p>{entry.text}</p>
                </article>
              ))
            ) : (
              <div className="call-empty-state">
                <div>
                  <span className="small-label">Try saying</span>
                  <h4>
                    {connectionState === "connected"
                      ? "Listening... what would you like to schedule?"
                      : "Tell me what you'd like to book"}
                  </h4>
                  <p>
                    You can say everything at once or take it one step at a time. If voice misses
                    something, you can switch to typing anytime.
                  </p>
                </div>
                <div className="example-stack">
                  <div className="example-card">
                    <p>"Book a 30-minute meeting tomorrow at 3 PM"</p>
                  </div>
                  <div className="example-card">
                    <p>"Schedule coffee with Maya next Tuesday at 11"</p>
                  </div>
                </div>
                <button className="secondary-button" onClick={openManualOverride} type="button">
                  Prefer typing? Edit details
                </button>
              </div>
            )}
          </div>
        </article>

        <article className="info-grid-card">
          <div className="panel-header">
            <h3>Meeting details</h3>
            <span className={`state-badge ${draft.status}`}>{formatDraftStatusLabel(draft.status)}</span>
          </div>

          <p className="details-intro">
            Watch the booking fill in as PingMe captures each detail.
          </p>

          <div className="smart-grid">
            {informationGrid.map((item) => (
              <button
                className={`grid-row ${item.statusTone}`}
                key={item.label}
                onClick={openManualOverride}
                type="button"
              >
                <div className="grid-row-main">
                  <span className={`field-icon ${item.statusTone}`}>{item.icon}</span>
                  <div className="grid-row-copy">
                    <span>{item.label}</span>
                    <em>{item.value}</em>
                  </div>
                </div>
                <strong>{item.status}</strong>
              </button>
            ))}
          </div>

          {draft.alternatives.length ? (
            <div className="alternatives-block">
              <span className="small-label">Suggested alternatives</span>
              {draft.alternatives.map((alternative) => (
                <p key={alternative.startIso}>{alternative.displayText}</p>
              ))}
            </div>
          ) : null}
        </article>
      </section>

      <section className="confirmation-shell">
        <article className={`manual-override-card ${manualOverrideOpen ? "open" : ""}`}>
          <div className="panel-header">
            <h3>Edit details</h3>
            <button
              className="text-button"
              onClick={() => {
                if (manualOverrideOpen) {
                  setManualOverrideOpen(false);
                  return;
                }

                openManualOverride();
              }}
              type="button"
            >
              {manualOverrideOpen ? "Hide" : "Open"}
            </button>
          </div>

          {manualOverrideOpen ? (
            <div className="override-form">
              <label>
                <span>Name</span>
                <input
                  className={getFieldInputTone("name", draft, manualOverrideError)}
                  onChange={(event) => {
                    setManualOverrideState("editing");
                    setManualOverrideError(null);
                    setManualOverrideForm((current) => ({
                      ...current,
                      attendeeName: event.target.value,
                    }));
                  }}
                  placeholder="John Doe"
                  type="text"
                  value={manualOverrideForm.attendeeName}
                />
              </label>
              <label>
                <span>Date</span>
                <input
                  onChange={(event) => {
                    setManualOverrideState("editing");
                    setManualOverrideError(null);
                    setManualOverrideForm((current) => ({
                      ...current,
                      preferredDate: event.target.value,
                    }));
                  }}
                  type="date"
                  value={manualOverrideForm.preferredDate}
                />
              </label>
              <label>
                <span>Time</span>
                <input
                  onChange={(event) => {
                    setManualOverrideState("editing");
                    setManualOverrideError(null);
                    setManualOverrideForm((current) => ({
                      ...current,
                      preferredTime: event.target.value,
                    }));
                  }}
                  type="time"
                  value={manualOverrideForm.preferredTime}
                />
              </label>
              <label>
                <span>Title</span>
                <input
                  onChange={(event) => {
                    setManualOverrideState("editing");
                    setManualOverrideError(null);
                    setManualOverrideForm((current) => ({
                      ...current,
                      meetingTitle: event.target.value,
                    }));
                  }}
                  placeholder="Project sync"
                  type="text"
                  value={manualOverrideForm.meetingTitle}
                />
              </label>
              <label>
                <span>Duration</span>
                <select
                  onChange={(event) => {
                    setManualOverrideState("editing");
                    setManualOverrideError(null);
                    setManualOverrideForm((current) => ({
                      ...current,
                      durationMinutes: event.target.value,
                    }));
                  }}
                  value={manualOverrideForm.durationMinutes}
                >
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">60 minutes</option>
                </select>
              </label>
              <label className="full-span">
                <span>Invite emails</span>
                <input
                  onChange={(event) => {
                    setManualOverrideState("editing");
                    setManualOverrideError(null);
                    setManualOverrideForm((current) => ({
                      ...current,
                      attendeeEmailsText: event.target.value,
                    }));
                  }}
                  placeholder="name@example.com, teammate@example.com"
                  type="text"
                  value={manualOverrideForm.attendeeEmailsText}
                />
              </label>

              {manualOverrideError ? <p className="inline-error">{manualOverrideError}</p> : null}
              {manualOverrideState === "applied" ? (
                <p className="inline-success">
                  Manual updates are applied. You can continue the conversation naturally.
                </p>
              ) : null}

              <button
                className="primary-button"
                disabled={manualOverrideState === "saving"}
                onClick={() => void applyManualOverride()}
                type="button"
              >
                {manualOverrideState === "saving" ? "Saving..." : createdEvent ? "Save changes" : "Apply edits"}
              </button>
            </div>
          ) : (
            <p className="collapsed-copy">
              Want to tweak something? Edit details anytime.
            </p>
          )}
        </article>

        {draft.warnings.length ? (
          <article className="confirmation-card">
            <div className="panel-header">
              <h3>Heads up</h3>
              <span>Before I book it</span>
            </div>

            <div className="warning-block">
              {draft.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </article>
        ) : null}
      </section>

      {dayAgenda.length ? (
        <article className="schedule-preview-card">
          <div className="panel-header">
            <h3>Day preview</h3>
            <span>{draft.localDateLabel ?? "Selected day"}</span>
          </div>

          <div className="agenda-timeline">
            {dayAgenda.map((item) => (
              <div className={`agenda-item ${item.status}`} key={`${item.status}-${item.startIso}`}>
                <span>{formatAgendaTime(item.startIso, timeZone)}</span>
                <div>
                  <strong>{item.label}</strong>
                  <p>{formatAgendaWindow(item.startIso, item.endIso, timeZone)}</p>
                </div>
              </div>
            ))}
          </div>
        </article>
      ) : null}

      {createdEvent ? (
        <article className="success-state-card">
          <div className="success-hero">
            <div className="success-mark" aria-hidden="true">
              ✓
            </div>
            <div>
              <p className="small-label">Added to Google Calendar</p>
              <h3>You are all set</h3>
              <p>{createdEvent.summary}</p>
              <p>Take a quick look at the details below. If anything feels off, I can update it.</p>
            </div>
          </div>

          <div className="success-detail-grid">
            <article className="success-detail-card">
              <span>When</span>
              <strong>{formatEventWindow(createdEvent, timeZone)}</strong>
            </article>
            <article className="success-detail-card">
              <span>Duration</span>
              <strong>{createdEvent.durationMinutes} minutes</strong>
            </article>
            <article className="success-detail-card">
              <span>Invitees</span>
              <strong>{formatAttendeeList(createdEvent.attendeeEmails)}</strong>
            </article>
          </div>

          <div className="success-actions">
            <button className="secondary-button" onClick={startAnotherBooking} type="button">
              Book another
            </button>
            <button className="secondary-button" onClick={openManualOverride} type="button">
              Edit details
            </button>
          </div>
        </article>
      ) : null}

    </section>
  );
}

function resolveToolPayload(input: {
  activeEvent: CalendarEvent | null;
  defaultTimeZone: string;
  draft: ScheduleDraft;
  name: string;
  payload: Record<string, unknown>;
}) {
  const fallbackTimeZone =
    readString(input.payload.timezone) ??
    input.draft.timezone ??
    input.activeEvent?.timezone ??
    input.defaultTimeZone;
  const attendeeEmails =
    normalizeStringArray(input.payload.attendeeEmails) ??
    input.draft.attendeeEmails ??
    input.activeEvent?.attendeeEmails ??
    [];
  const basePayload = {
    attendeeEmails,
    attendeeName:
      readString(input.payload.attendeeName) ??
      input.draft.attendeeName ??
      input.activeEvent?.attendeeName,
    durationMinutes:
      readNumber(input.payload.durationMinutes) ??
      input.draft.durationMinutes ??
      input.activeEvent?.durationMinutes ??
      30,
    meetingTitle: readString(input.payload.meetingTitle) ?? input.draft.meetingTitle,
    timezone: fallbackTimeZone,
  };
  const bookingSourceOfTruth = {
    attendeeEmails:
      input.draft.attendeeEmails.length > 0
        ? input.draft.attendeeEmails
        : input.activeEvent?.attendeeEmails ?? attendeeEmails,
    attendeeName: input.draft.attendeeName ?? input.activeEvent?.attendeeName ?? basePayload.attendeeName,
    durationMinutes:
      input.draft.durationMinutes ?? input.activeEvent?.durationMinutes ?? basePayload.durationMinutes,
    meetingTitle: input.draft.meetingTitle ?? basePayload.meetingTitle,
    timezone: input.draft.timezone ?? input.activeEvent?.timezone ?? fallbackTimeZone,
  };

  if (input.name === "normalize_meeting_request") {
    return {
      ...basePayload,
      preferredDate:
        readString(input.payload.preferredDate) ??
        input.draft.preferredDate ??
        fallbackDateLabel(input.activeEvent, fallbackTimeZone),
      preferredTime:
        readString(input.payload.preferredTime) ??
        input.draft.preferredTime ??
        fallbackTimeLabel(input.activeEvent, fallbackTimeZone),
    };
  }

  if (input.name === "check_calendar_availability") {
    return {
      ...basePayload,
      startIso: readString(input.payload.startIso) ?? input.draft.startIso,
    };
  }

  if (input.name === "create_calendar_event") {
    return {
      ...bookingSourceOfTruth,
      bookingFingerprint:
        input.draft.bookingFingerprint ?? readString(input.payload.bookingFingerprint),
      startIso: input.draft.startIso ?? readString(input.payload.startIso),
    };
  }

  if (input.name === "reschedule_calendar_event") {
    return {
      ...bookingSourceOfTruth,
      bookingFingerprint:
        input.draft.bookingFingerprint ?? readString(input.payload.bookingFingerprint),
      eventId: input.activeEvent?.id ?? readString(input.payload.eventId),
      startIso: input.draft.startIso ?? readString(input.payload.startIso),
    };
  }

  if (input.name === "cancel_calendar_event") {
    return {
      eventId: readString(input.payload.eventId) ?? input.activeEvent?.id,
      notifyAttendees:
        readBoolean(input.payload.notifyAttendees) ?? Boolean(input.activeEvent?.attendeeEmails.length),
    };
  }

  return input.payload;
}

function describeToolCall(name: string) {
  if (name === "normalize_meeting_request") {
    return "Normalizing the raw date and time into a deterministic meeting slot.";
  }

  if (name === "check_calendar_availability") {
    return "Checking the requested slot against the live calendar.";
  }

  if (name === "create_calendar_event") {
    return "Creating the calendar event from a previously validated slot.";
  }

  if (name === "reschedule_calendar_event") {
    return "Rescheduling the current session event to a newly validated slot.";
  }

  if (name === "cancel_calendar_event") {
    return "Cancelling the current session event.";
  }

  return "Running a realtime tool call.";
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const next = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  return Array.from(new Set(next));
}

function areEmailListsEqual(left: string[] | undefined, right: string[] | undefined) {
  const sortedLeft = [...(left ?? [])].sort();
  const sortedRight = [...(right ?? [])].sort();

  return JSON.stringify(sortedLeft) === JSON.stringify(sortedRight);
}

function fallbackDateLabel(event: CalendarEvent | null, fallbackTimeZone: string) {
  if (!event) {
    return undefined;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeZone: event.timezone || fallbackTimeZone,
  }).format(new Date(event.startIso));
}

function fallbackTimeLabel(event: CalendarEvent | null, fallbackTimeZone: string) {
  if (!event) {
    return undefined;
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: event.timezone || fallbackTimeZone,
  }).format(new Date(event.startIso));
}

function detectClarificationSignal(text: string) {
  const normalized = text.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  if (/\b(morning|afternoon|evening|later|sometime|around)\b/.test(normalized)) {
    return "The user gave a vague time phrase, so the assistant should confirm the exact time.";
  }

  if (
    /\b\d{1,2}\b/.test(normalized) &&
    !/\b(am|pm)\b/.test(normalized) &&
    !/\b\d{1,2}:\d{2}\b/.test(normalized) &&
    /\b(today|tomorrow|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at)\b/.test(
      normalized,
    )
  ) {
    return "The requested time may need AM/PM clarification.";
  }

  if (/\b(at|dot)\b/.test(normalized) && !normalized.includes("@")) {
    return "A spoken email address may need to be repeated or spelled out.";
  }

  return null;
}

function looksLikeClarificationIssue(message: string) {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("specific meeting time") ||
    normalized.includes("am/pm") ||
    normalized.includes("could not parse") ||
    normalized.includes("valid iana timezone")
  ) {
    return message;
  }

  if (normalized.includes("email")) {
    return "An attendee email needs clarification before the invite can be sent.";
  }

  return null;
}

function normalizeSpeechText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\w@\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mentionsInviteDetails(text: string) {
  return text.includes("@") || /\b(invite|invites|email|emails|attendee|attendees)\b/.test(text);
}

function isSimpleAffirmation(text: string) {
  return /^(yes|yeah|yep|sure|okay|ok|correct|that s right|that is right|sounds good|looks good|that works|please do)$/i.test(
    text,
  );
}

function isExplicitBookingConfirmation(text: string) {
  return /\b(book it|schedule it|add it to (my|the) calendar|put it on (my|the) calendar|go ahead|that s correct|that is correct|yes that s right|yes that is right|yes book it|please book it|confirm it)\b/i.test(
    text,
  );
}

function isNegativeBookingResponse(text: string) {
  return /\b(no|nope|not yet|don t|do not|wait|hold on|stop|cancel|never mind)\b/i.test(text);
}

function looksLikeQuestion(text: string) {
  return /\b(what|when|why|how|who|can|could|would|should|do|does|is|are)\b/.test(text);
}

function looksLikeBookingEdit(text: string) {
  return /\b(change|instead|different|move|reschedule|update|another|title|name|date|time|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|minute|minutes|hour|hours)\b/i.test(
    text,
  );
}

function shouldAutoBookFreeSlotReply(text: string, awaitingBookingConfirmation: boolean) {
  if (mentionsInviteDetails(text) || isNegativeBookingResponse(text) || looksLikeBookingEdit(text)) {
    return false;
  }

  if (isExplicitBookingConfirmation(text)) {
    return true;
  }

  if (!awaitingBookingConfirmation) {
    return false;
  }

  if (looksLikeQuestion(text)) {
    return false;
  }

  return isSimpleAffirmation(text) || text.split(" ").length <= 5;
}

function assistantClaimsCalendarCheck(text: string) {
  return /\b(i ll check (your|the) calendar|let me check (your|the) calendar|checking (your|the) calendar|i ll see if that works|let me see if that works|i ll check if that time works)\b/i.test(
    text,
  );
}

function assistantClaimsBooked(text: string) {
  return /\b(i ll schedule|i will schedule|i m scheduling|i am scheduling|added to (your|the) calendar|on your calendar|scheduled and ready to go|it s booked|it is booked|it s confirmed|it is confirmed|confirmed|all set|you re all set|you are all set|meeting is scheduled|ready to go)\b/i.test(
    text,
  );
}

function assistantAskedForInviteDetails(text: string) {
  return (
    mentionsInviteDetails(text) &&
    /\b(would you like|do you want|want to|should i|can you|could you|please provide|please share|share|send out)\b/.test(
      text,
    )
  );
}

function assistantAskedForBookingConfirmation(text: string) {
  if (assistantAskedForInviteDetails(text)) {
    return false;
  }

  return /\b(should i book|want me to book|would you like me to book|should i add it|want me to add it|would you like me to add it|shall i add it|is that correct|does that look right|does that sound right|sound right|look right|go ahead and book|go ahead and add it)\b/i.test(
    text,
  );
}

function buildExtractionChips(draft: ScheduleDraft) {
  const chips: Array<{ label: string; status: "captured" | "pending"; value: string }> = [];

  if (draft.attendeeName) {
    chips.push({
      label: "Name",
      status: "captured",
      value: draft.attendeeName,
    });
  }

  if (draft.localDateLabel) {
    chips.push({
      label: "Date",
      status: "captured",
      value: draft.localDateLabel,
    });
  }

  if (draft.localTimeLabel) {
    chips.push({
      label: "Time",
      status: "captured",
      value: draft.localTimeLabel,
    });
  }

  if (draft.meetingTitle) {
    chips.push({
      label: "Title",
      status: "captured",
      value: draft.meetingTitle,
    });
  }

  if (draft.durationMinutes) {
    chips.push({
      label: "Duration",
      status: "captured",
      value: `${draft.durationMinutes} minutes`,
    });
  }

  if (!chips.length) {
    chips.push({
      label: "Listening",
      status: "pending",
      value: "What would you like to schedule?",
    });
  }

  return chips;
}

function buildInformationGrid(
  draft: ScheduleDraft,
  errorText: string | null,
  connectionState: "idle" | "connecting" | "connected" | "error",
) {
  return [
    buildGridRow("Name", renderFieldIcon("name"), draft.attendeeName, true, errorText, connectionState),
    buildGridRow(
      "Date",
      renderFieldIcon("date"),
      draft.localDateLabel ?? draft.preferredDate,
      true,
      errorText,
      connectionState,
    ),
    buildGridRow(
      "Time",
      renderFieldIcon("time"),
      draft.localTimeLabel ?? draft.preferredTime,
      true,
      errorText,
      connectionState,
    ),
    buildGridRow(
      "Title",
      renderFieldIcon("title"),
      draft.meetingTitle,
      false,
      errorText,
      connectionState,
      "Optional",
    ),
    buildGridRow(
      "Duration",
      renderFieldIcon("duration"),
      draft.durationMinutes ? `${draft.durationMinutes} minutes` : undefined,
      true,
      errorText,
      connectionState,
    ),
    buildGridRow(
      "Invitees",
      renderFieldIcon("invitees"),
      draft.attendeeEmails.length ? formatAttendeeList(draft.attendeeEmails) : undefined,
      false,
      errorText,
      connectionState,
      "Optional",
    ),
  ];
}

function buildGridRow(
  label: string,
  icon: ReactNode,
  value: string | undefined,
  required: boolean,
  errorText: string | null,
  connectionState: "idle" | "connecting" | "connected" | "error",
  emptyLabel?: string,
) {
  const needsAttention = required && !value && Boolean(errorText);
  const isListening = required && !value && (connectionState === "connected" || connectionState === "connecting");

  if (value) {
    return {
      icon,
      label,
      status: "Got it",
      statusTone: "identified",
      value,
    };
  }

  return {
    icon,
    label,
    status: required ? (isListening ? "Listening..." : "Not set") : emptyLabel ?? "Optional",
    statusTone: needsAttention ? "alert" : required ? "pending" : "optional",
    value: required ? (isListening ? "Listening..." : "Not set") : emptyLabel ?? "Not set",
  };
}

function renderFieldIcon(kind: "name" | "date" | "duration" | "invitees" | "time" | "title") {
  const commonProps = {
    "aria-hidden": true,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 24 24",
  };

  if (kind === "name") {
    return (
      <svg {...commonProps}>
        <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" />
        <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
      </svg>
    );
  }

  if (kind === "date") {
    return (
      <svg {...commonProps}>
        <rect x="3.5" y="5" width="17" height="15" rx="3" />
        <path d="M7.5 3.5v3" />
        <path d="M16.5 3.5v3" />
        <path d="M3.5 9.5h17" />
      </svg>
    );
  }

  if (kind === "time") {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.8v4.7l3.1 1.9" />
      </svg>
    );
  }

  if (kind === "title") {
    return (
      <svg {...commonProps}>
        <path d="M7 5.5h10" />
        <path d="M7 9.5h10" />
        <path d="M7 13.5h6.5" />
        <rect x="4" y="3.5" width="16" height="17" rx="3" />
      </svg>
    );
  }

  if (kind === "duration") {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.8v4.2" />
        <path d="M12 12l2.8 2.1" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <path d="M8.5 10.5a3 3 0 1 0-3-3 3 3 0 0 0 3 3Z" />
      <path d="M15.5 12a2.5 2.5 0 1 0-2.5-2.5 2.5 2.5 0 0 0 2.5 2.5Z" />
      <path d="M3.8 18.5a5 5 0 0 1 9.4-1.7" />
      <path d="M13.8 18.5a4 4 0 0 1 6.4-3.2" />
    </svg>
  );
}

function getCurrentProgressStep(draft: ScheduleDraft, createdEvent: CalendarEvent | null) {
  if (createdEvent) {
    return 3;
  }

  if (
    draft.attendeeName ||
    draft.localDateLabel ||
    draft.preferredDate ||
    draft.localTimeLabel ||
    draft.preferredTime ||
    draft.meetingTitle ||
    draft.status === "free" ||
    draft.status === "busy" ||
    draft.status === "normalized" ||
    draft.status === "checking"
  ) {
    return 2;
  }

  return 1;
}

function buildProgressSteps(currentStep: number) {
  return [
    {
      caption: "Start the call and speak naturally.",
      index: 1,
      label: "Say it",
      tone: currentStep > 1 ? "complete" : currentStep === 1 ? "active" : "pending",
    },
    {
      caption: "Make sure everything looks right.",
      index: 2,
      label: "Check it",
      tone: currentStep > 2 ? "complete" : currentStep === 2 ? "active" : "pending",
    },
    {
      caption: "It's on your calendar.",
      index: 3,
      label: "Done",
      tone: currentStep === 3 ? "complete" : "pending",
    },
  ];
}

function getMissingRequiredFields(draft: ScheduleDraft) {
  const missing: string[] = [];

  if (!draft.attendeeName) {
    missing.push("name");
  }

  if (!draft.localDateLabel && !draft.preferredDate) {
    missing.push("date");
  }

  if (!draft.localTimeLabel && !draft.preferredTime) {
    missing.push("time");
  }

  return missing;
}

function getUserFacingStatus(errorText: string | null, statusText: string) {
  if (errorText) {
    const normalized = errorText.toLowerCase();

    if (
      normalized.includes("operationnotsupported") ||
      normalized.includes("specified model") ||
      normalized.includes("realtime operation")
    ) {
      return "I can't start voice mode right now.";
    }

    if (normalized.includes("microphone")) {
      return "I need mic access before I can help.";
    }

    if (normalized.includes("unauthorized_client") || normalized.includes("invalid_grant")) {
      return "I need Google Calendar reconnected before I can save this.";
    }

    if (normalized.includes("calendar")) {
      return "I couldn't save that just now.";
    }

    return "I hit a snag and couldn't keep going.";
  }

  return statusText;
}

function getUserFacingSubtext(
  connectionState: "idle" | "connecting" | "connected" | "error",
  draftStatus: DraftStatus,
  hasEvent: boolean,
  errorText: string | null,
) {
  const normalizedError = errorText?.toLowerCase() ?? "";

  if (normalizedError.includes("microphone") || normalizedError.includes("notallowed")) {
    return "Allow mic access in the browser, then try again.";
  }

  if (normalizedError.includes("calendar") || normalizedError.includes("unauthorized_client")) {
    return "Your details are still here. Reconnect Calendar or edit them, then try again.";
  }

  if (connectionState === "idle") {
    return "Just say what you need. I'll handle the rest.";
  }

  if (connectionState === "connecting") {
    return "Hang tight while I get the mic ready.";
  }

  if (connectionState === "error") {
    return "Try again in a moment.";
  }

  if (hasEvent) {
    return "Take a quick look at the details below to make sure everything looks right.";
  }

  if (draftStatus === "busy") {
    return "That slot is busy, so I'll help you pick another one.";
  }

  if (draftStatus === "free") {
    return "That slot is open. I'll confirm it before booking.";
  }

  return "Listening... tell me what you'd like to book.";
}

function formatConnectionStateLabel(connectionState: "idle" | "connecting" | "connected" | "error") {
  if (connectionState === "idle") {
    return "Ready to listen";
  }

  if (connectionState === "connecting") {
    return "Getting ready";
  }

  if (connectionState === "connected") {
    return "Listening";
  }

  return "Needs a retry";
}

function formatDraftStatusLabel(draftStatus: DraftStatus) {
  if (draftStatus === "collecting") {
    return "Listening";
  }

  if (draftStatus === "normalized" || draftStatus === "checking") {
    return "Checking";
  }

  if (draftStatus === "free") {
    return "Ready";
  }

  if (draftStatus === "busy") {
    return "Needs a tweak";
  }

  if (draftStatus === "booked") {
    return "Done";
  }

  if (draftStatus === "cancelled") {
    return "Cancelled";
  }

  return "Needs a retry";
}

function formatCallVisualState(callVisualState: CallVisualState) {
  if (callVisualState === "listening") {
    return "Listening";
  }

  if (callVisualState === "speaking") {
    return "Speaking";
  }

  if (callVisualState === "thinking") {
    return "Thinking";
  }

  if (callVisualState === "error") {
    return "Needs attention";
  }

  return "Standby";
}

function getFieldInputTone(field: "name", draft: ScheduleDraft, errorText: string | null) {
  if (field === "name" && (errorText?.toLowerCase().includes("name") || !draft.attendeeName)) {
    return "input-error";
  }

  return "";
}

function formatAttendeeList(attendeeEmails: string[]) {
  return attendeeEmails.length ? attendeeEmails.join(", ") : "None";
}

function parseEmailList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatDateInputValue(value?: string) {
  if (!value) {
    return "";
  }

  return value.includes("T") ? value.slice(0, 10) : "";
}

function formatTimeInputValue(value?: string) {
  if (!value) {
    return "";
  }

  const timeSection = value.split("T")[1];

  if (!timeSection) {
    return "";
  }

  return timeSection.slice(0, 5);
}

function formatAgendaTime(startIso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(startIso));
}

function formatAgendaWindow(startIso: string, endIso: string, timeZone: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);

  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });

  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function formatEventWindow(event: CalendarEvent, fallbackTimeZone: string) {
  const timeZone = event.timezone || fallbackTimeZone;
  const start = new Date(event.startIso);
  const end = new Date(event.endIso);

  const formatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  });

  const endFormatter = new Intl.DateTimeFormat("en-US", {
    timeStyle: "short",
    timeZone,
  });

  return `${formatter.format(start)} to ${endFormatter.format(end)}`;
}

function formatLatency(value: number | null) {
  return value === null ? "n/a" : `${value} ms`;
}

function timestampLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function useEventCallback<T extends (...args: never[]) => unknown>(callback: T) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const stableCallbackRef = useRef<T | null>(null);

  if (stableCallbackRef.current === null) {
    stableCallbackRef.current = ((...args: Parameters<T>) =>
      callbackRef.current(...args)) as T;
  }

  return stableCallbackRef.current;
}
