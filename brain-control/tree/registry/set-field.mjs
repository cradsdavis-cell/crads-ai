// set-field.mjs · edit ONE scalar on a registry row IN PLACE, in its own text.
//
// Why this exists (live cert, 2026-08-03): the appliers used to rewrite a row by
// serializing a NORMALIZED object. normalizeRow knows eleven fields; a real row
// carries sixty-one, including email, box.host, key_dates, region, provider,
// invite and skills_installed. So a routine permission answer silently reduced a
// member's record to a ten-line stub and lost their contact details, their
// history and their installed skills. It was invisible in tests because the
// round-trip test fed a row that only contained the fields the writer already
// knew: it proved that what I write survives writing, which is not a property.
//
// The rule now: NEVER regenerate a row. Touch the one line you mean and leave
// every other byte exactly as it was. Missing keys are appended, never invented.
//
// AND THE INSERT IS A FUNCTION, NEVER A STRING (2026-08-16). String.replace
// re-reads $&, $', $` and $1 out of the REPLACEMENT text, so a value carrying
// them is not written, it is re-expanded from the match: $& puts the old line
// back inside the new one, and $' splices the ENTIRE REST OF THE ROW into the
// scalar and duplicates it. That is the same "every other byte" invariant this
// file exists to defend, broken from the other end, and no amount of cleaning
// the value can reach it, because the injected text comes from the row itself.
// Found reviewing the finding-155 name fix, which took a typed name straight
// into a replacement string.
export function setScalar(text, key, value) {
  const line = `${key}: "${String(value)}"`;
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(text)) return text.replace(re, () => line);
  const sep = text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${line}\n`;
}
