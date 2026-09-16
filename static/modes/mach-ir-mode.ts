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

import * as monaco from 'monaco-editor';

// the text of mach's --emit-ir=listing form: a module of typed SSA where each instruction is followed by its
// `line:column`, or by `path:line:column` when it came from another file, written after a ';'
function definition(): monaco.languages.IMonarchLanguage {
    return {
        defaultToken: '',

        keywords: ['ir-listing', 'module', 'fun', 'val', 'var', 'unattached', 'preds', 'null'],

        // the linkage and decorator words a declaration carries in its '[...]'
        linkage: [
            'pub',
            'extern',
            'inline',
            'noreturn',
            'test',
            'weak',
            'oblivious',
            'scalar',
            'noinline',
            'naked',
            'import',
            'local',
            'embed',
        ],

        tokenizer: {
            root: [
                [/;.*$/, 'comment'],

                // a secret operand keeps its '~', which is part of the name it qualifies
                [/~?%p?[a-zA-Z_0-9]+/, 'variable'],
                [/![a-zA-Z_0-9]+/, 'type'],
                [/@"(?:[^"\\]|\\.)*"/, 'variable.predefined'],
                [/@[a-zA-Z_.][\w.]*/, 'variable.predefined'],

                // an opcode carries its meaning-changing flags as suffixes: mul.pure, store.secret, add.nsw
                [/\b[a-z_][\w]*(?:\.(?:nsw|nuw|exact|volatile|secret|pure))+/, 'keyword.operator'],

                [
                    /[a-zA-Z_][\w-]*/,
                    {cases: {'@keywords': 'keyword', '@linkage': 'keyword.flow', '@default': 'identifier'}},
                ],

                [/"(?:[^"\\]|\\.)*"/, 'string'],
                [/0x[0-9a-fA-F]+/, 'number.hex'],
                [/\d+/, 'number'],

                [/[{}()[\]]/, '@brackets'],
                [/[<>]/, '@brackets'],
                [/[,:=*]/, 'delimiter'],
                [/\s+/, 'white'],
            ],
        },
    };
}

monaco.languages.register({id: 'mach-ir'});
monaco.languages.setMonarchTokensProvider('mach-ir', definition());
