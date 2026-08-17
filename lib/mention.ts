import { squash } from "./scope.ts";

/**
 * The "/" picker in the chat box, as a pure rule.
 *
 * What it inserts is the document's label and nothing else -- there is no
 * encoding, no id and no second channel to the server. "/aff" becomes the text
 * "Job #3", which `resolveScope` has matched since phase 3. The picker exists
 * because a person should not have to remember which posting is which, not
 * because retrieval needs help parsing.
 *
 * That is also what keeps it cheap to be wrong about: a mis-picked document is
 * visible in the box before the question is sent, and an edited one degrades to
 * an ordinary sentence rather than to a broken reference.
 */

export type Mentionable = {
  label: string;
  company: string | null;
  role_title: string | null;
};

/**
 * The "/" token under the caret, if the caret is inside one.
 *
 * Only at the start of a word, so a date, a fraction or a pasted URL does not
 * open a menu, and only up to the first space, so the menu closes once the
 * sentence carries on.
 */
export function mentionQuery(text: string, caret: number) {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("/");
  if (start === -1) return null;
  if (start > 0 && !/\s/.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  if (/\s/.test(query)) return null;
  return { start, end: caret, query };
}

/**
 * The postings worth offering for what has been typed so far.
 *
 * Matched on every name the document answers to, which is the same set
 * `resolveScope` matches on -- so the menu can never offer a document by a name
 * that would not have resolved it. An empty query offers all of them, which is
 * what makes "/" alone a way to see what is indexed.
 */
export function suggest<T extends Mentionable>(documents: T[], query: string): T[] {
  const asked = squash(query);
  if (asked === "") return documents;
  return documents.filter((document) =>
    [document.label, document.company, document.role_title].some((name) =>
      squash(name ?? "").includes(asked),
    ),
  );
}

/** The box's text and caret after picking a document. */
export function applyMention(
  text: string,
  mention: { start: number; end: number },
  label: string,
) {
  const inserted = `${label} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(mention.end),
    caret: mention.start + inserted.length,
  };
}
