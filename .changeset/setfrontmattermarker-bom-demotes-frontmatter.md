---
'dorfl': patch
---

Stop `setFrontmatterMarker` demoting a BOM-prefixed document's frontmatter into its body.

The READER and the WRITER disagreed about whether a document has frontmatter. `extractBlock` (behind `parseFrontmatter`) strips a leading BOM before looking for the `---` fence, so a BOM'd body parsed fine and reported its `slug`, `title` and `spec`. `setFrontmatterMarker` did not strip it, so the same body failed its `startsWith('---\n')` test, was judged FENCE-LESS, and had a SECOND fence prepended. The original frontmatter was pushed down into the body, where it is prose: every key except the one just written silently stopped existing.

The corruption was invisible to the guards meant to catch exactly this. Both the surface path and the terminal-question drain re-parse their own output and refuse to write a body whose marker does not read back correctly, but the marker in the newly prepended fence reads back perfectly, so the write was committed with the rest of the metadata destroyed.

A BOM is rare in a `work/` tree but entirely legal, and it is what a Windows editor or an external tool produces. It is now stripped for the analysis in the same way the reader strips it, and re-prepended to the result: it is the document's encoding marker, not the tool's to drop. A BOM'd fence-less document still gets its fence prepended, after the BOM.
