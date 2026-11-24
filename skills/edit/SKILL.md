---
name: edit
description: Replace an exact, unique string in an existing file, or apply an atomic multi-edit batch across files from the Bun REPL.
---

# Edit

Make a targeted edit to an existing file by replacing one exact, unique
occurrence of a string. `oldStr` must appear exactly once in the file.

Call directly from the kernel:

```javascript
await edit({ path: "pkg/file.ts", oldStr, newStr });
```

For multi-file or multi-hunk edits, prefer `edit.batch([...])` so every snippet
is validated in memory before any file is written (if one edit fails, zero files
are modified, and mismatch errors include the nearest matching line):

```javascript
await edit.batch([
  { path: "pkg/a.ts", oldStr: oldA, newStr: newA },
  { path: "pkg/b.ts", oldStr: oldB, newStr: newB },
]);

// Optional pre-flight check without writing:
await edit.batch(edits, { dryRun: true });
```

Use exact old/new strings. Template literals are useful for multiline snippets.
Returns a short confirmation; throws if `oldStr` is missing (with nearest-line
hint when available) or matches more than once (widen the snippet to make it unique).
