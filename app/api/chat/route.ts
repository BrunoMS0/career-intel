import { google } from "@ai-sdk/google";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isTextUIPart,
  streamText,
  type UIMessage,
} from "ai";
import { sql } from "@/lib/db";
import { assessRetrieval, REFUSAL } from "@/lib/guardrail";
import { buildPrompt } from "@/lib/prompt";
import { resolveScope, retrieve } from "@/lib/retrieval";

const CHAT_MODEL = process.env.CHAT_MODEL ?? "gemini-3.7-flash";

/**
 * Retrieval runs against the newest question alone. A follow-up that leans on
 * the previous turn ("and for the other one?") therefore retrieves against the
 * wrong text; rewriting the query from the history is the fix, and it needs the
 * eval harness to show it is worth an extra model call.
 */
function latestQuestion(messages: UIMessage[]): string {
  const last = messages.findLast((message) => message.role === "user");
  return (last?.parts ?? [])
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join(" ")
    .trim();
}

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const question = latestQuestion(messages);
  if (!question) {
    return Response.json({ error: "a question is required" }, { status: 400 });
  }

  const sections = await retrieve(question);
  const { top, spread, weak } = assessRetrieval(sections);

  // Logged before the answer, not after: a request that dies mid-stream is
  // exactly the one worth having a row for.
  await sql`
    insert into query_logs (question, scope, sections, top_distance, doc_spread, answered)
    values (${question}, ${await resolveScope(question)}, ${sections.length},
            ${top}, ${spread}, ${!weak})
  `;

  // Nothing retrieved is near enough to be evidence, so there is nothing for the
  // model to ground an answer in and no reason to pay for the call.
  if (weak) {
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: "text-start", id: "refusal" });
          writer.write({ type: "text-delta", id: "refusal", delta: REFUSAL });
          writer.write({ type: "text-end", id: "refusal" });
        },
      }),
    });
  }

  const result = streamText({
    model: google(CHAT_MODEL),
    system: buildPrompt(sections),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
