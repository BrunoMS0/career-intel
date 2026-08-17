"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isReasoningUIPart, isTextUIPart, type UIMessage } from "ai";
import { CheckIcon, CopyIcon, FileSearchIcon, RefreshCwIcon, SearchXIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Button } from "@/components/ui/button";
import { linkCitations } from "@/lib/citation";
import { isRefusal } from "@/lib/guardrail";
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

/**
 * Openers, built from the postings that are actually indexed.
 *
 * They used to name Job #1 and Job #4 as constants, which is fine until someone
 * uploads a different corpus and the app greets them with two questions its own
 * guardrail refuses. Labels rather than company names on purpose: both resolve
 * scope since phase 7, and the labelled forms are the ones measured clean three
 * runs out of three -- `twin-align-golden`, the same question naming the company
 * instead, still flips. The "/" picker is where the real names belong.
 */
function suggestionsFor(documents: DocumentSummary[]) {
  const jobs = documents.filter((document) => document.kind === "job");
  if (jobs.length === 0) return [];

  const [first, second = first] = jobs;
  return [
    `What skills am I missing for ${first.label}?`,
    `How does my experience align with ${second.label}?`,
    "Which of these roles fits me best, and why?",
  ];
}

/** Everything the model said, with the reasoning left out. */
const answerText = (message: UIMessage) =>
  message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join("");

/**
 * A resolved citation, rendered where the markdown says a link is.
 *
 * `linkCitations` only produces one for a bracket naming an indexed document, so
 * the chip is a claim that the source resolved -- an invented citation stays
 * plain text and keeps looking like what it is. It is a `span`, not a link:
 * there is nowhere to go, since the retrieved excerpt is not on the stream. The
 * title carries the label the model actually wrote, which is what the sidebar,
 * `query_logs` and every eval expectation speak.
 */
const CITATION_COMPONENTS = {
  a: ({ children, title }: { children?: React.ReactNode; title?: string }) => (
    <span
      title={title}
      className="mx-0.5 inline-flex items-baseline rounded border bg-muted px-1.5 text-xs font-medium text-muted-foreground"
    >
      {children}
    </span>
  ),
};

/**
 * Copies the answer as the model wrote it, brackets and all.
 *
 * Not what the chips display: `[Job #4 — EXPERIENCE]` is the string the corpus,
 * `query_logs` and every eval expectation speak, and a citation pasted into a
 * mail or a note is worth more when it can be traced back to one of them. The
 * parenthesised company is a reading aid, not the answer.
 */
function CopyAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <MessageAction tooltip={copied ? "Copied" : "Copy answer"} onClick={() => void copy()}>
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
}

/**
 * What an empty transcript says, which depends on whether there is a corpus.
 *
 * With nothing indexed the openers are hidden rather than greyed out: every one
 * of them names a posting, so on an empty database they would each be refused by
 * the guardrail, and an app whose own suggestions get refused reads as broken.
 *
 * The pills are shadcn `Button`s rather than AI Elements' `Suggestion`, which is
 * the same button inside a horizontally scrolling `ScrollArea` with a hidden
 * scrollbar. Three questions of this length come to about a thousand pixels, so
 * two of the three would sit off-screen behind a bar nobody can see. Wrapping
 * keeps all of them visible and saves a dependency.
 */
function Opening({
  documents,
  onAsk,
}: {
  documents: DocumentSummary[];
  onAsk: (question: string) => void;
}) {
  const suggestions = suggestionsFor(documents);
  const postings = documents.filter((document) => document.kind === "job").length;

  return (
    // `flex-1` because `size-full` resolves to the content's own height in a
    // flex column, which left the whole thing pinned to the top of an empty page.
    <ConversationEmptyState className="flex-1 gap-4">
      <FileSearchIcon className="size-6 text-muted-foreground" />
      <div className="space-y-1">
        <h2 className="font-medium">Ask about your fit for these roles</h2>
        <p className="text-sm text-muted-foreground">
          {postings === 0
            ? "Nothing is indexed yet. Add your resume and a job posting to start."
            : `Answered only from your resume and ${postings} job posting${
                postings === 1 ? "" : "s"
              }. Type “/” to name one.`}
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            variant="outline"
            size="sm"
            className="rounded-full"
            onClick={() => onAsk(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </ConversationEmptyState>
  );
}

/**
 * The guardrail's refusal, which is not an answer and should not look like one.
 *
 * It is a different event from the rest of the transcript: no model ran, the
 * text is fixed, and it arrives in half a second where an answer takes forty or
 * more. Rendered as chrome rather than as speech, so nobody reads it as the
 * model's opinion about the question.
 */
function Refusal({ text }: { text: string }) {
  return (
    <div className="flex gap-3 rounded-lg border border-dashed bg-muted/40 px-4 py-3">
      <SearchXIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-medium">Outside the indexed documents</p>
        <p className="text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

export function Workspace({ documents }: { documents: DocumentSummary[] }) {
  const { messages, sendMessage, regenerate, status, error } = useChat({
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
          {/* `min-h-full` so the empty state has a full column to centre itself
              in, without capping the height once there are messages. */}
          <ConversationContent className="min-h-full px-0">
            {messages.length === 0 && <Opening documents={documents} onAsk={ask} />}

            {messages.map((message, index) => {
              const answer = answerText(message);
              // A refusal has nothing to retry: no model ran, so asking again
              // recomputes the same distance and returns the same fixed string.
              // And retry only on the newest answer, because regenerating an
              // older one throws away every turn after it without saying so.
              const retryable =
                message.role === "assistant" &&
                !isRefusal(answer) &&
                index === messages.length - 1;

              return (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {isRefusal(answer) ? (
                      <Refusal text={answer} />
                    ) : (
                      message.parts.map((part, i) => {
                        // Gemma spends most of a request here -- measured at 3.2s
                        // to the first reasoning token against 43.7s to the first
                        // text one, 5,928 characters against 650. It was always in
                        // the stream (`sendReasoning` defaults to true) and always
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
                          return (
                            <MessageResponse key={i} components={CITATION_COMPONENTS}>
                              {message.role === "assistant"
                                ? linkCitations(part.text, documents)
                                : part.text}
                            </MessageResponse>
                          );
                        }
                        return null;
                      })
                    )}
                  </MessageContent>

                  {/* Nothing to act on while it streams, and nothing to act on
                      for a refusal either -- it is chrome, not an answer. */}
                  {message.role === "assistant" && !busy && !isRefusal(answer) && answer !== "" && (
                    <MessageActions>
                      <CopyAnswer text={answer} />
                      {retryable && (
                        // The same question with the same context has been
                        // measured coming back clean 1 time in 3, so asking again
                        // is a real move here and not a workaround for an error.
                        <MessageAction
                          tooltip="Ask again"
                          onClick={() => void regenerate({ messageId: message.id })}
                        >
                          <RefreshCwIcon className="size-3.5" />
                        </MessageAction>
                      )}
                    </MessageActions>
                  )}
                </Message>
              );
            })}

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
        // No hardcoded label here either: the openers above are built from the
        // corpus, and this used to name a posting that need not exist.
        placeholder="Ask about your fit for a role — type / to pick one"
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
