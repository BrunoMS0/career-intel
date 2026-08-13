import { google } from "@ai-sdk/google";
import { convertToModelMessages, isTextUIPart, streamText, type UIMessage } from "ai";
import { retrieve, type RetrievedSection } from "@/lib/retrieval";

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

function buildPrompt(sections: RetrievedSection[]): string {
  const excerpts = sections
    .map((section) => `[${section.label} — ${section.section}]\n${section.content}`)
    .join("\n\n");

  return `You are a career assistant. You answer questions about one candidate's resume and the job postings they are considering.

Answer only from the excerpts below.

- Cite the source of every claim inline, exactly as it is labelled: [Job #2 — Requirements].
- Each excerpt is labelled with its document and its section. A line under a posting is what the role demands; a line from the resume is what the candidate has. Never present one as the other.
- If the excerpts do not answer the question, say so and name what is missing. Do not fall back on general knowledge about the role, the company, or the industry.
- Be concrete and brief. A specific gap is more useful than encouragement.

Excerpts:

${excerpts}`;
}

export async function POST(request: Request) {
  const { messages }: { messages: UIMessage[] } = await request.json();

  const question = latestQuestion(messages);
  if (!question) {
    return Response.json({ error: "a question is required" }, { status: 400 });
  }

  const sections = await retrieve(question);

  const result = streamText({
    model: google(CHAT_MODEL),
    system: buildPrompt(sections),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse();
}
