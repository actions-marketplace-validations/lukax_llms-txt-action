# Changelog

## 1.4.0

- Add opt-in `mode: inspect` for explicit text/JSON files using the authenticated llms.ink Inspect pilot.
- Fail on findings, incomplete coverage, unavailable service or mismatched receipts.
- Keep source text out of annotations and report artifacts; expose content-bound receipt metadata.
- Restrict file selection, request size and redirects; reject symlinks and `pull_request_target`.
- Existing modes remain unchanged. Hosted inspection requires explicit key enablement.
