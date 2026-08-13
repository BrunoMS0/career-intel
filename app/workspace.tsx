"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isTextUIPart } from "ai";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type DocumentSummary = {
  id: string;
  kind: "resume" | "job";
  label: string;
  chunks: number;
};

const SUGGESTIONS = [
  "What skills am I missing for Job #1?",
  "How does my experience align with Job #4?",
  "Which of these roles fits me best, and why?",
];

export function Workspace({ documents }: { documents: DocumentSummary[] }) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const busy = status === "submitted" || status === "streaming";

  function ask(question: string) {
    if (!question.trim() || busy) return;
    void sendMessage({ text: question });
    setInput("");
  }

  return (
    <main className="mx-auto flex h-full w-full max-w-6xl gap-8 p-6">
      <aside className="hidden w-64 shrink-0 flex-col gap-4 md:flex">
        <Uploader />
        <DocumentList documents={documents} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto pb-4">
          {messages.length === 0 && (
            <div className="space-y-2 pt-8">
              <p className="pb-2 text-sm text-neutral-500">Ask about your fit for these roles.</p>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => ask(suggestion)}
                  className="block w-full rounded-lg border border-neutral-200 px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          {messages.map((message) => (
            <article
              key={message.id}
              className={
                message.role === "user"
                  ? "ml-auto max-w-[80%] rounded-lg bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "max-w-[90%] text-sm leading-relaxed whitespace-pre-wrap"
              }
            >
              {message.parts.filter(isTextUIPart).map((part, i) => (
                <span key={i}>{part.text}</span>
              ))}
            </article>
          ))}

          {status === "submitted" && <p className="text-sm text-neutral-500">Searching…</p>}
          {error && <p className="text-sm text-red-600">{error.message}</p>}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            ask(input);
          }}
          className="flex gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800"
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="What skills am I missing for Job #1?"
            className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            Ask
          </button>
        </form>
      </section>
    </main>
  );
}

function DocumentList({ documents }: { documents: DocumentSummary[] }) {
  if (documents.length === 0) {
    return <p className="text-sm text-neutral-500">No documents yet.</p>;
  }

  return (
    <ul className="space-y-1 text-sm">
      {documents.map((document) => (
        <li key={document.id} className="flex justify-between gap-2">
          <span className={document.kind === "resume" ? "font-medium" : undefined}>
            {document.label}
          </span>
          <span className="text-neutral-500">{document.chunks}</span>
        </li>
      ))}
    </ul>
  );
}

function Uploader() {
  const router = useRouter();
  const [status, setStatus] = useState<string>();

  async function upload(form: HTMLFormElement) {
    setStatus("Indexing…");
    const response = await fetch("/api/documents", { method: "POST", body: new FormData(form) });
    const body = await response.json();

    setStatus(response.ok ? (body.warning ?? `Indexed into ${body.chunks} chunks`) : body.error);
    if (response.ok) {
      form.reset();
      router.refresh();
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void upload(event.currentTarget);
      }}
      className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
    >
      <input
        name="label"
        placeholder="Label, e.g. Job #7"
        required
        className="w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />
      <select
        name="kind"
        defaultValue="job"
        className="w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      >
        <option value="job">Job posting</option>
        <option value="resume">Resume</option>
      </select>
      <input name="file" type="file" accept="application/pdf" required className="w-full text-xs" />
      <button
        type="submit"
        className="w-full rounded bg-neutral-900 px-2 py-1 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
      >
        Add PDF
      </button>
      {status && <p className="text-xs text-neutral-500">{status}</p>}
    </form>
  );
}
