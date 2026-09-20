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

import type {ParsedAsmResult} from '../../types/asmresult/asmresult.interfaces.js';
import type {ParseFiltersAndOutputOptions} from '../../types/features/filters.interfaces.js';
import type {PropertyGetter} from '../properties.interfaces.js';
import {AsmParser} from './asm-parser.js';

/**
 * Names a source by its path from the project's source directory, which is the name the tree pane gives it: the
 * line records objdump prints are rooted at the project, so a file the user wrote arrives as `src/util/fmt.mach`
 * while the tree knows it as `util/fmt.mach`. A file outside the source directory, such as std's under `dep/`,
 * keeps its path: it belongs to no editor.
 */
export class MachAsmParser extends AsmParser {
    private readonly sourcePrefix: string;

    /**
     * @param sourceDir the project's source directory, as the manifest names it
     */
    constructor(compilerProps: PropertyGetter | undefined, sourceDir: string) {
        super(compilerProps);
        this.sourcePrefix = `${sourceDir}/`;
    }

    override processBinaryAsm(asmResult: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult {
        const result = super.processBinaryAsm(asmResult, filters);
        for (const line of result.asm) {
            const file = line.source?.file;
            if (line.source && file?.startsWith(this.sourcePrefix))
                line.source.file = file.slice(this.sourcePrefix.length);
        }
        return result;
    }
}
