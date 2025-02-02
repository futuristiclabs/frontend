import type { HomeAssistant } from "../types";
import type { ConversationResult } from "./conversation";
import type { ResolvedMediaSource } from "./media_source";
import type { SpeechMetadata } from "./stt";

export interface AssistPipeline {
  id: string;
  conversation_engine: string;
  language: string;
  name: string;
  stt_engine: string;
  tts_engine: string;
}

export interface AssistPipelineMutableParams {
  conversation_engine: string;
  language: string;
  name: string;
  stt_engine: string;
  tts_engine: string;
}

export interface assistRunListing {
  pipeline_run_id: string;
  timestamp: string;
}

interface PipelineEventBase {
  timestamp: string;
}

interface PipelineRunStartEvent extends PipelineEventBase {
  type: "run-start";
  data: {
    pipeline: string;
    language: string;
    runner_data: {
      stt_binary_handler_id: number | null;
      timeout: number;
    };
  };
}
interface PipelineRunEndEvent extends PipelineEventBase {
  type: "run-end";
  data: Record<string, never>;
}

interface PipelineErrorEvent extends PipelineEventBase {
  type: "error";
  data: {
    code: string;
    message: string;
  };
}

interface PipelineSTTStartEvent extends PipelineEventBase {
  type: "stt-start";
  data: {
    engine: string;
    metadata: SpeechMetadata;
  };
}
interface PipelineSTTEndEvent extends PipelineEventBase {
  type: "stt-end";
  data: {
    stt_output: { text: string };
  };
}

interface PipelineIntentStartEvent extends PipelineEventBase {
  type: "intent-start";
  data: {
    engine: string;
    intent_input: string;
  };
}
interface PipelineIntentEndEvent extends PipelineEventBase {
  type: "intent-end";
  data: {
    intent_output: ConversationResult;
  };
}

interface PipelineTTSStartEvent extends PipelineEventBase {
  type: "tts-start";
  data: {
    engine: string;
    tts_input: string;
  };
}
interface PipelineTTSEndEvent extends PipelineEventBase {
  type: "tts-end";
  data: {
    tts_output: ResolvedMediaSource;
  };
}

export type PipelineRunEvent =
  | PipelineRunStartEvent
  | PipelineRunEndEvent
  | PipelineErrorEvent
  | PipelineSTTStartEvent
  | PipelineSTTEndEvent
  | PipelineIntentStartEvent
  | PipelineIntentEndEvent
  | PipelineTTSStartEvent
  | PipelineTTSEndEvent;

export type PipelineRunOptions = (
  | {
      start_stage: "intent" | "tts";
      input: { text: string };
    }
  | {
      start_stage: "stt";
      input: { sample_rate: number };
    }
) & {
  end_stage: "stt" | "intent" | "tts";
  pipeline?: string;
  conversation_id?: string | null;
};

export interface PipelineRun {
  init_options?: PipelineRunOptions;
  events: PipelineRunEvent[];
  stage: "ready" | "stt" | "intent" | "tts" | "done" | "error";
  run: PipelineRunStartEvent["data"];
  error?: PipelineErrorEvent["data"];
  stt?: PipelineSTTStartEvent["data"] &
    Partial<PipelineSTTEndEvent["data"]> & { done: boolean };
  intent?: PipelineIntentStartEvent["data"] &
    Partial<PipelineIntentEndEvent["data"]> & { done: boolean };
  tts?: PipelineTTSStartEvent["data"] &
    Partial<PipelineTTSEndEvent["data"]> & { done: boolean };
}

export const processEvent = (
  run: PipelineRun | undefined,
  event: PipelineRunEvent,
  options?: PipelineRunOptions
): PipelineRun | undefined => {
  if (event.type === "run-start") {
    run = {
      init_options: options,
      stage: "ready",
      run: event.data,
      events: [event],
    };
    return run;
  }

  if (!run) {
    // eslint-disable-next-line no-console
    console.warn("Received unexpected event before receiving session", event);
    return undefined;
  }

  if (event.type === "stt-start") {
    run = {
      ...run,
      stage: "stt",
      stt: { ...event.data, done: false },
    };
  } else if (event.type === "stt-end") {
    run = {
      ...run,
      stt: { ...run.stt!, ...event.data, done: true },
    };
  } else if (event.type === "intent-start") {
    run = {
      ...run,
      stage: "intent",
      intent: { ...event.data, done: false },
    };
  } else if (event.type === "intent-end") {
    run = {
      ...run,
      intent: { ...run.intent!, ...event.data, done: true },
    };
  } else if (event.type === "tts-start") {
    run = {
      ...run,
      stage: "tts",
      tts: { ...event.data, done: false },
    };
  } else if (event.type === "tts-end") {
    run = {
      ...run,
      tts: { ...run.tts!, ...event.data, done: true },
    };
  } else if (event.type === "run-end") {
    run = { ...run, stage: "done" };
  } else if (event.type === "error") {
    run = { ...run, stage: "error", error: event.data };
  } else {
    run = { ...run };
  }

  run.events = [...run.events, event];

  return run;
};

export const runAssistPipeline = (
  hass: HomeAssistant,
  callback: (event: PipelineRun) => void,
  options: PipelineRunOptions
) => {
  let run: PipelineRun | undefined;

  const unsubProm = hass.connection.subscribeMessage<PipelineRunEvent>(
    (updateEvent) => {
      run = processEvent(run, updateEvent, options);

      if (updateEvent.type === "run-end" || updateEvent.type === "error") {
        unsubProm.then((unsub) => unsub());
      }

      if (run) {
        callback(run);
      }
    },
    {
      ...options,
      type: "assist_pipeline/run",
    }
  );

  return unsubProm;
};

export const listAssistPipelineRuns = (
  hass: HomeAssistant,
  pipeline_id: string
) =>
  hass.callWS<{
    pipeline_runs: assistRunListing[];
  }>({
    type: "assist_pipeline/pipeline_debug/list",
    pipeline_id,
  });

export const getAssistPipelineRun = (
  hass: HomeAssistant,
  pipeline_id: string,
  pipeline_run_id: string
) =>
  hass.callWS<{
    events: PipelineRunEvent[];
  }>({
    type: "assist_pipeline/pipeline_debug/get",
    pipeline_id,
    pipeline_run_id,
  });

export const fetchAssistPipelines = (hass: HomeAssistant) =>
  hass.callWS<{
    pipelines: AssistPipeline[];
    preferred_pipeline: string | null;
  }>({
    type: "assist_pipeline/pipeline/list",
  });

export const createAssistPipeline = (
  hass: HomeAssistant,
  pipeline: AssistPipelineMutableParams
) =>
  hass.callWS<AssistPipeline>({
    type: "assist_pipeline/pipeline/create",
    ...pipeline,
  });

export const updateAssistPipeline = (
  hass: HomeAssistant,
  pipeline_id: string,
  pipeline: Partial<AssistPipelineMutableParams>
) =>
  hass.callWS<AssistPipeline>({
    type: "assist_pipeline/pipeline/update",
    pipeline_id,
    ...pipeline,
  });

export const setAssistPipelinePreferred = (
  hass: HomeAssistant,
  pipeline_id: string
) =>
  hass.callWS({
    type: "assist_pipeline/pipeline/set_preferred",
    pipeline_id,
  });

export const deleteAssistPipeline = (hass: HomeAssistant, pipelineId: string) =>
  hass.callWS<void>({
    type: "assist_pipeline/pipeline/delete",
    pipeline_id: pipelineId,
  });
