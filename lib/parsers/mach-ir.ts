// Copyright (c) 2026, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import type {AsmResultSource, ParsedAsmResultLine} from '../../types/asmresult/asmresult.interfaces.js';
import * as utils from '../utils.js';

/**
 * A comment is the only thing a listing line carries past the instruction, and the printer writes it as padding, a
 * `;` and a space. Nothing else in the form emits a `;`: names are identifiers, and a byte constant prints as
 * `bytes[N]` rather than its contents.
 */
const commentRe = /^(.*?)(\s+); (.*)$/;

/** A function header, once its comment is split off. An `extern` declaration has no body and so never matches. */
const headRe = /^\s*fun @\S.*\{$/;

/** A position in the file the enclosing function's header named. */
const bareRe = /^(\d+):(\d+)$/;

/** A position in any other file, which is what an inlined callee leaves behind. Greedy: a path may hold a colon. */
const pathRe = /^(.+):(\d+):(\d+)$/;

/** What the user's own source is called once its path is masked, matching the name diagnostics give it. */
const mainName = '<source>';

type Position = {file: string; line: number; column: number; bare: boolean};

/**
 * Reads `mach build --emit-ir=listing`, which prints an instruction and its `line:column` and nothing else.
 *
 * Three properties drive the whole parse. A function's header names the file its body lives in, so a bare
 * `line:column` is resolved against the header rather than against anything on its own line. An instruction from
 * another file prints its path instead, so it stands alone. An instruction with no position prints no comment at
 * all, so a line without one maps nowhere.
 *
 * Paths arrive rooted at the directory the compilation was given, which the sandbox mounts at `/app`, so masking
 * them yields the project-relative path: `src/example.mach`, `dep/std/src/math.mach`. Only the user's own source
 * becomes a `null` file, which is CE's contract for "this editor's source": everything else keeps a path and so
 * never marks the editor at a line that belongs to another file.
 */
export class MachIrParser {
    /**
     * @param mainFile the user's source, project-relative, as the listing names it
     */
    constructor(private readonly mainFile: string) {}

    process(listing: string): ParsedAsmResultLine[] {
        const result: ParsedAsmResultLine[] = [];
        let home: string | undefined;

        for (const line of utils.splitLines(listing)) {
            const comment = line.match(commentRe);
            if (!comment) {
                // a header with no comment is a function whose file the compiler could not name, so every bare
                // position under it resolves against nothing rather than against the function before it
                if (headRe.test(line)) home = undefined;
                result.push({text: line});
                continue;
            }

            const [, head, pad, payload] = comment;
            if (headRe.test(head)) {
                home = utils.maskRootdir(payload);
                result.push({text: `${head}${pad}; ${this.display(home)}`});
                continue;
            }

            const position = this.position(payload, home);
            // an unresolvable offset prints as `file#<id>@<offset>`, which names no line to map to
            if (!position) {
                result.push({text: line});
                continue;
            }

            const shown = position.bare
                ? `${position.line}:${position.column}`
                : `${this.display(position.file)}:${position.line}:${position.column}`;
            result.push({text: `${head}${pad}; ${shown}`, source: this.source(position)});
        }

        return result;
    }

    private position(payload: string, home: string | undefined): Position | null {
        const bare = payload.match(bareRe);
        if (bare) {
            if (home === undefined) return null;
            return {file: home, line: Number(bare[1]), column: Number(bare[2]), bare: true};
        }

        const explicit = payload.match(pathRe);
        if (!explicit) return null;
        return {
            file: utils.maskRootdir(explicit[1]),
            line: Number(explicit[2]),
            column: Number(explicit[3]),
            bare: false,
        };
    }

    private source(position: Position): AsmResultSource {
        return position.file === this.mainFile
            ? {file: null, line: position.line, column: position.column, mainsource: true}
            : {file: position.file, line: position.line, column: position.column};
    }

    private display(file: string): string {
        return file === this.mainFile ? mainName : file;
    }
}
