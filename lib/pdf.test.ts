import { test } from "node:test";
import assert from "node:assert/strict";
import { orderItems, type TextItem } from "./pdf.ts";

const item = (str: string, x: number, y: number, width = str.length * 5): TextItem => ({
  str,
  x,
  y,
  width,
  fontSize: 10,
});

test("reads top to bottom regardless of the order items were drawn in", () => {
  // The real failure this fixes: a resume template emits the sidebar contact
  // details before the section heading that sits above them on the page.
  const page = [
    item("+51 922485655", 25, 780),
    item("Experience", 11, 670),
    item("Bruno Monzen", 11, 818),
  ];

  assert.equal(orderItems([page]), "Bruno Monzen\n+51 922485655\nExperience");
});

test("keeps items on one line when they share a baseline", () => {
  const page = [item("Remote", 400, 500), item("Data Analytics", 17, 500)];
  assert.equal(orderItems([page]), "Data Analytics Remote");
});

test("tolerates baselines that wobble within a line", () => {
  const page = [item("bruno@example.com", 116, 779), item("+51 922485655", 25, 780)];
  assert.equal(orderItems([page]), "+51 922485655 bruno@example.com");
});

test("rejoins a word split across items without inserting a space", () => {
  // "Built" arrives as "Bui" + "lt" when styling changes mid-word.
  const page = [item("Bui", 24, 298, 14), item("lt a", 38, 298, 16)];
  assert.equal(orderItems([page]), "Built a");
});

test("inserts a space where the glyphs actually stand apart", () => {
  const page = [item("modernization of", 24, 323, 160), item("9", 190, 323, 6)];
  assert.equal(orderItems([page]), "modernization of 9");
});

test("concatenates pages in order", () => {
  assert.equal(
    orderItems([[item("page one", 10, 700)], [item("page two", 10, 700)]]),
    "page one\npage two",
  );
});
