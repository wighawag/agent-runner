---
'dorfl': patch
---

Add an end-of-drive triage pass to the `drive-tasks` skill.

Per-task Gate-3 (step 4b) already triages each task's `review-nits-<slug>-*.md` in isolation at the moment its PR merges, but nothing looked at the drive's nits and off-path observations as a whole. `drive-tasks` now runs one cross-drive triage pass (step 5.5) after the loop is exhausted and before the report: it gathers every built task's nit set plus every observation filed during the drive, reads them together (grouped by theme, so a nit recurring across PRs is the signal), and routes each item to exactly one destination (already-handled / benign-noise / kept as its own committed observation / task-worthy for `to-task` / a stuck-set question folded into the same batched-questions surface). It preserves golden rule 3 (no fix-in-place), runs even on a clean drive, and its disposition is a named section of the conductor's report.
