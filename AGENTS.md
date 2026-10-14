# Asset Hub

- This is a local-first asset registry. Keep the API bound to loopback.
- The user explicitly does not want approval states or mandatory review. Use optional revision-bound notes for observations.
- Keep stable asset IDs separate from physical storage. GLB revisions are SHA-256 content hashes; source commits are recorded separately.
- Preserve original project repositories. Import snapshots and provenance; do not silently modify or migrate their sources.
- Preserve user-edited metadata and old revision-bound notes when reimporting.
- Git tracks the management system only. `catalog/` and `.store/` are local library data and must both be backed up separately.
- Run `npm run verify` for application changes. Run `npm run test:browser` after building when changing UI or persistence flows; it uses disposable isolated data.
- Do not write test notes or fixture assets into the user's live catalog.
- Keep export limitations visible. glTF conformance is not a claim of visual equivalence, correct scale, or game integration.
