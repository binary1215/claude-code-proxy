# Codex apply_patch grammar attribution

`src/services/responsesPatchGrammar.ts` reproduces the unmodified base grammar
from `openai/codex`, commit `a956835d020762cb2b570053af06f643a11c0ecc`,
`codex-rs/core/assets/tools/apply_patch.lark`. It also reproduces the exact optional
environment-ID grammar substitution from `apply_patch_spec.rs` at that commit.
The surrounding TypeScript recognizer and adapter integration are new code in
this repository, not the Codex patch parser or executor.

The upstream grammar is licensed under the [Apache License 2.0](codex-APACHE-2.0.txt).
The applicable upstream notice is:

> OpenAI Codex
> Copyright 2025 OpenAI

The upstream root NOTICE also attributes Ratatui. No Ratatui code is included by
this grammar adaptation. No endorsement by OpenAI is implied.
