/** Pinned Codex apply_patch wire grammar, not an arbitrary Lark interpreter.
 * Source: openai/codex a956835d020762cb2b570053af06f643a11c0ecc,
 * codex-rs/core/assets/tools/apply_patch.lark (Apache-2.0; see licenses/).
 * Validation is after generation, before delivering any custom input or done
 * event. It neither applies patches nor guarantees constrained decoding.
 */
export const CODEX_APPLY_PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

export const CODEX_APPLY_PATCH_ENVIRONMENT_GRAMMAR = CODEX_APPLY_PATCH_GRAMMAR.replace(
  "start: begin_patch hunk+ end_patch",
  'start: begin_patch environment_id? hunk+ end_patch\nenvironment_id: "*** Environment ID: " filename LF',
);

export type PatchGrammar = "codex_apply_patch" | "codex_apply_patch_environment";
export type ApplyPatchMode = "reject" | "validated";
export const MAX_PATCH_BYTES = 1024 * 1024;

export function recognizePatchGrammar(name: string, syntax: unknown, definition: unknown): PatchGrammar | undefined {
  if (name !== "apply_patch" || syntax !== "lark") return undefined;
  // The pinned official Windows executable embeds this asset with CRLF. These
  // are exact additional spellings of the grammar, NOT patch-input repairs.
  if (definition === CODEX_APPLY_PATCH_GRAMMAR || definition === CODEX_APPLY_PATCH_GRAMMAR.replaceAll("\n", "\r\n")) return "codex_apply_patch";
  if (definition === CODEX_APPLY_PATCH_ENVIRONMENT_GRAMMAR || definition === CODEX_APPLY_PATCH_ENVIRONMENT_GRAMMAR.replaceAll("\n", "\r\n")) return "codex_apply_patch_environment";
  return undefined;
}

/** Linear recognizer for exactly the pinned grammar's LF-separated language.
 * Do not trim, normalize CRLF, resolve paths, or adopt the CLI parser's more
 * permissive repairs. The client owns path authorization and patch execution.
 */
export function validPatchInput(input: string, grammar: PatchGrammar): boolean {
  if (Buffer.byteLength(input, "utf8") > MAX_PATCH_BYTES) return false;
  const lines = input.split("\n");
  if (lines.at(-1) === "") lines.pop(); // Exactly one optional final LF.
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return false;
  const end = lines.length - 1;
  let cursor = 1;
  // Python/Lark's dot excludes LF only; CR and Unicode separators in data are
  // not rewritten or rejected by this syntax layer.
  const named = (line: string | undefined, prefix: string) =>
    line !== undefined && line.startsWith(prefix) && line.length > prefix.length;
  if (grammar === "codex_apply_patch_environment" && named(lines[cursor], "*** Environment ID: ")) cursor++;
  let hunks = 0;
  while (cursor < end) {
    const header = lines[cursor++];
    if (named(header, "*** Add File: ")) {
      const begin = cursor;
      while (cursor < end && lines[cursor].startsWith("+")) cursor++;
      if (cursor === begin) return false;
    } else if (named(header, "*** Delete File: ")) {
      // The file header is the complete delete hunk.
    } else if (named(header, "*** Update File: ")) {
      if (cursor < end && named(lines[cursor], "*** Move to: ")) cursor++;
      const begin = cursor;
      while (cursor < end) {
        const line = lines[cursor];
        if (line === "@@" || named(line, "@@ ") || ["+", "-", " "].includes(line[0])) cursor++;
        else break;
      }
      if (cursor > begin && cursor < end && lines[cursor] === "*** End of File") cursor++;
    } else return false;
    hunks++;
  }
  return hunks > 0 && cursor === end;
}

export function patchInputDescription(definition: string): string {
  return "Put the raw apply_patch text in this input string without modifying its contents. " +
    "The client executes the patch. The adapter validates the complete text against this exact Lark grammar before returning it:\n" + definition;
}
