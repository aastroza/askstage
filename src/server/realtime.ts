const questionStreams = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const streamEncoder = new TextEncoder();

export function createQuestionStream(eventId: string): Response {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      addQuestionStream(eventId, controller);
      sendStreamEvent(controller, "connected", { eventId });
      heartbeat = setInterval(() => sendStreamComment(controller, "keepalive"), 25000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (streamController) removeQuestionStream(eventId, streamController);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

export function broadcastQuestionsChanged(eventId: string): void {
  const streams = questionStreams.get(eventId);
  if (!streams) return;

  for (const controller of [...streams]) {
    try {
      sendStreamEvent(controller, "questions_changed", { eventId });
    } catch {
      removeQuestionStream(eventId, controller);
    }
  }
}

function addQuestionStream(eventId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
  const streams = questionStreams.get(eventId) ?? new Set<ReadableStreamDefaultController<Uint8Array>>();
  streams.add(controller);
  questionStreams.set(eventId, streams);
}

function removeQuestionStream(eventId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
  const streams = questionStreams.get(eventId);
  if (!streams) return;
  streams.delete(controller);
  if (!streams.size) questionStreams.delete(eventId);
}

function sendStreamEvent(controller: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown): void {
  controller.enqueue(streamEncoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
}

function sendStreamComment(controller: ReadableStreamDefaultController<Uint8Array>, comment: string): void {
  controller.enqueue(streamEncoder.encode(`: ${comment}\n\n`));
}
