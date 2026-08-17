"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isReasoningUIPart, isTextUIPart } from "ai";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { applyMention, mentionQuery, suggest } from "@/lib/mention";

export type DocumentSummary = {
  id: string;
  kind: "resume" | "job";
  label: string;
  /** Null on the resume, and on a posting nobody gave an identity. */
  company: string | null;
  role_title: string | null;
  chunks: number;
};

/** What a document is called when there is something better than "Job #3". */
const identity = (document: DocumentSummary) =>
  [document.company, document.role_title].filter(Boolean).join(" — ");

const SUGGESTIONS = [
  "What skills am I missing for Job #1?",
  "How does my experience align with Job #4?",
  "Which of these roles fits me best, and why?",
];

export function Workspace({ documents }: { documents: DocumentSummary[] }) {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const busy = status === "submitted" || status === "streaming";

  function ask(question: string) {
    if (!question.trim() || busy) return;
    void sendMessage({ text: question });
  }

  return (
    // `flex-1`, not `h-full`: body is `min-h-full`, so its height is auto and a
    // percentage height here resolves to the content instead of the viewport --
    // which left the composer floating mid-page and its menu off the top edge.
    // `min-h-0` is what lets the transcript below scroll instead of growing.
    <main className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 gap-8 p-6">
      <aside className="hidden w-64 shrink-0 flex-col gap-4 md:flex">
        <Uploader documents={documents} />
        <DocumentList documents={documents} />
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Conversation>
          <ConversationContent className="px-0">
            {messages.length === 0 && (
              <div className="space-y-2 pt-8">
                <p className="pb-2 text-sm text-muted-foreground">
                  Ask about your fit for these roles.
                </p>
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => ask(suggestion)}
                    className="block w-full rounded-lg border px-3 py-2 text-left text-sm hover:bg-accent"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}

            {messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent>
                  {message.parts.map((part, i) => {
                    // Gemma spends most of a request here -- measured at 3.2s to
                    // the first reasoning token against 43.7s to the first text
                    // one, 5,928 characters against 650. It was always in the
                    // stream (`sendReasoning` defaults to true) and always
                    // discarded, which is what made the wait look like a stall.
                    if (isReasoningUIPart(part)) {
                      return (
                        <Reasoning key={i} isStreaming={part.state === "streaming"}>
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    }
                    if (isTextUIPart(part)) {
                      return <MessageResponse key={i}>{part.text}</MessageResponse>;
                    }
                    return null;
                  })}
                </MessageContent>
              </Message>
            ))}

            {status === "submitted" && (
              <p className="text-sm text-muted-foreground">Searching…</p>
            )}
            {error && <p className="text-sm text-destructive">{error.message}</p>}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <Composer
          documents={documents.filter((document) => document.kind === "job")}
          busy={busy}
          onAsk={ask}
        />
      </section>
    </main>
  );
}

/**
 * The question box, with a "/" picker over the indexed postings.
 *
 * It inserts the posting's label as plain text and stops there. Nothing is
 * encoded, no id rides along, and the request is the same string it would have
 * been if the label were typed by hand -- the picker is here so nobody has to
 * remember that Job #3 is Afficiency, not because retrieval needs the help.
 *
 * The cost of being wrong is therefore what it should be: a mis-picked posting
 * is visible in the box before anything is sent, and a half-deleted one reads
 * as an ordinary sentence rather than a broken reference.
 */
function Composer({
  documents,
  busy,
  onAsk,
}: {
  documents: DocumentSummary[];
  busy: boolean;
  onAsk: (question: string) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);

  const mention = dismissed ? null : mentionQuery(text, caret);
  const matches = mention ? suggest(documents, mention.query) : [];
  const open = matches.length > 0;
  // Clamped rather than reset, so deleting a character cannot leave the
  // highlight pointing past the end of a list that just got shorter.
  const highlighted = Math.min(active, matches.length - 1);

  function pick(document: DocumentSummary) {
    if (!mention) return;
    const applied = applyMention(text, mention, document.label);
    setText(applied.text);
    setDismissed(true);
    // After React writes the value back, or the browser parks the caret at the
    // end of the box and the rest of the sentence gets typed in the wrong place.
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(applied.caret, applied.caret);
      setCaret(applied.caret);
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
      setActive((highlighted + step) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      // Enter picks instead of sending. The sentence is still being written --
      // submitting it here is the one thing the user cannot have meant.
      event.preventDefault();
      pick(matches[highlighted]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim() || busy) return;
        onAsk(text);
        setText("");
      }}
      className="relative flex gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800"
    >
      {open && (
        <ul
          id="mention-menu"
          role="listbox"
          // The click would otherwise blur the box first, and pick() would have
          // no caret left to insert at.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-80 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          {matches.map((document, index) => (
            <li key={document.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                onClick={() => pick(document)}
                onMouseEnter={() => setActive(index)}
                className={`block w-full px-3 py-1.5 text-left ${
                  index === highlighted ? "bg-neutral-100 dark:bg-neutral-800" : ""
                }`}
              >
                <span className="text-sm">{document.label}</span>
                {identity(document) && (
                  <span className="block truncate text-xs text-neutral-500">
                    {identity(document)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={box}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setDismissed(false);
          setActive(0);
        }}
        // Fires when the caret moves without the text changing -- clicking back
        // into a mention that was already typed past has to reopen the menu.
        //
        // Guarded on the value, because a selection event can arrive after the
        // text it described is gone: select the whole box and type over it, and
        // the late event reports the old selection's caret and closes a menu
        // the typing had just opened. Observed with a triple-click.
        onSelect={(event) => {
          if (event.currentTarget.value === text) {
            setCaret(event.currentTarget.selectionStart ?? 0);
          }
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls="mention-menu"
        aria-autocomplete="list"
        placeholder="What skills am I missing for Job #1?  (type / to pick a role)"
        className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      />
      <button
        type="submit"
        disabled={busy || !text.trim()}
        className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
      >
        Ask
      </button>
    </form>
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
          {/* The identity is the point of the line: this sidebar is where you
              learn that Job #3 is Afficiency before typing "/" in the box. */}
          <span className="min-w-0">
            <span className={document.kind === "resume" ? "font-medium" : undefined}>
              {document.label}
            </span>
            {identity(document) && (
              <span className="block truncate text-xs text-neutral-500">
                {identity(document)}
              </span>
            )}
          </span>
          <span className="text-neutral-500">{document.chunks}</span>
        </li>
      ))}
    </ul>
  );
}

function Uploader({ documents }: { documents: DocumentSummary[] }) {
  const router = useRouter();
  const [status, setStatus] = useState<string>();
  const [kind, setKind] = useState("job");
  const [label, setLabel] = useState("");

  // Mirrors the check in the route, which is the one that counts -- this exists
  // so the answer arrives before a PDF is parsed and embedded rather than after.
  // Case-insensitive for the same reason: resolveScope squashes case, so two
  // labels differing only in it are one scope key.
  const clash =
    label.trim() !== "" &&
    documents.some(
      (document) =>
        document.label.toLowerCase() === label.trim().toLowerCase() &&
        // A new resume replaces the indexed one and frees its label with it.
        !(kind === "resume" && document.kind === "resume"),
    );

  async function upload(form: HTMLFormElement) {
    setStatus("Indexing…");
    const response = await fetch("/api/documents", { method: "POST", body: new FormData(form) });
    const body = await response.json();

    setStatus(response.ok ? (body.warning ?? `Indexed into ${body.chunks} chunks`) : body.error);
    if (response.ok) {
      form.reset();
      // reset() does not reach a controlled input, so the label would survive
      // the upload and clash with the document it just created.
      setLabel("");
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
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="Label, e.g. Job #8"
        required
        aria-invalid={clash}
        className={`w-full rounded border px-2 py-1 text-sm dark:bg-neutral-950 ${
          clash
            ? "border-red-500 dark:border-red-500"
            : "border-neutral-300 dark:border-neutral-700"
        }`}
      />
      {clash && <p className="text-xs text-red-600">That label is already taken.</p>}
      <select
        name="kind"
        value={kind}
        onChange={(event) => setKind(event.target.value)}
        className="w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
      >
        <option value="job">Job posting</option>
        <option value="resume">Resume</option>
      </select>

      {/* Only postings. The resume is in scope for every question, so an
          identity on it would be data the "/" menu then has to hide. */}
      {kind === "job" && (
        <>
          <input
            name="company"
            placeholder="Company (optional)"
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
          <input
            name="role_title"
            placeholder="Role title (optional)"
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />
          <p className="text-xs text-neutral-500">
            Optional, but they are how the “/” menu and questions find this role.
          </p>
        </>
      )}

      <input name="file" type="file" accept="application/pdf" required className="w-full text-xs" />
      <button
        type="submit"
        disabled={clash}
        className="w-full rounded bg-neutral-900 px-2 py-1 text-sm text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
      >
        Add PDF
      </button>
      {status && <p className="text-xs text-neutral-500">{status}</p>}
    </form>
  );
}
