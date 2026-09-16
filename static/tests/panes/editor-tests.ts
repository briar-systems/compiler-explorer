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

import {describe, expect, it, vi} from 'vitest';

// the editor module builds one of these at import time, and its constructor asks the server for the builtin sources
vi.mock('../../widgets/load-save.js', () => ({LoadSave: class {}}));
vi.mock('monaco-vim', () => ({initVimMode: () => undefined}));

import {ResultLine} from '../../../types/resultline/resultline.interfaces.js';
import {Editor} from '../../panes/editor.js';

/**
 * What the parser hands the editor for a build of `src/example.mach`: a diagnostic in the user's own source, one in
 * a second file of the project, and one inside the std the build realized at `dep/std`, which lies outside the
 * directory the project's sources were written to.
 */
const diagnostics: (ResultLine & {sourcePane: string})[] = [
    {
        text: 'error: unresolved identifier `bogus`',
        sourcePane: 'mach #1',
        tag: {
            file: 'example.mach',
            line: 7,
            column: 9,
            text: 'error: unresolved identifier `bogus`',
            severity: 3,
        },
    },
    {
        text: 'error: unresolved identifier `nope`',
        sourcePane: 'mach #1',
        tag: {file: 'util/fmt.mach', line: 2, column: 9, text: 'error: unresolved identifier `nope`', severity: 3},
    },
    {
        text: 'error: a reference field is detected but not followed',
        sourcePane: 'mach #1',
        tag: {
            file: '../dep/std/src/derive.mach',
            line: 193,
            column: 5,
            text: 'error: a reference field is detected but not followed',
            severity: 3,
        },
    },
];

/** The tree of the project the diagnostics came from: the entry in one editor, `util/fmt.mach` in another. */
const tree = {
    multifileService: {
        getEditorIdByFilename: (filename: string) => ({'example.mach': 1, 'util/fmt.mach': 2})[filename] ?? null,
        getMainSourceEditorId: () => 1,
    },
};

function pane(id: number, trees: any[] = []) {
    const view = Object.create(Editor.prototype) as Editor;
    Object.assign(view, {
        id,
        hub: {trees},
        editor: {getModel: () => null},
        getTokenSpan: () => ({colBegin: 0, colEnd: 0}),
        currentLanguage: {extensions: ['.mach']},
    });
    return view;
}

function marked(view: Editor, mainSource: string) {
    return view.collectOutputWidgets(diagnostics, mainSource).widgets.map(w => [w.startLineNumber, w.message]);
}

describe('Editor diagnostics', () => {
    it('marks only the main source of the compilation when there is no tree', () => {
        // derive.mach:193 would mark line 193 of whatever the user has written: briar-systems/compiler-explorer#16
        expect(marked(pane(1), 'example.mach')).toEqual([[7, 'error: unresolved identifier `bogus`']]);
    });

    it('marks the editor holding the file a diagnostic names, subdirectories included', () => {
        // a basename never matched a tree file under a directory: briar-systems/compiler-explorer#13
        expect(marked(pane(2, [tree]), 'example.mach')).toEqual([[2, 'error: unresolved identifier `nope`']]);
        expect(marked(pane(1, [tree]), 'example.mach')).toEqual([[7, 'error: unresolved identifier `bogus`']]);
    });

    it('marks no editor of a tree for a file the project does not hold', () => {
        expect(marked(pane(3, [tree]), 'example.mach')).toEqual([]);
    });

    it('names the main source by what the compilation compiled', () => {
        expect(pane(1).mainSourceFilename({inputFilename: '/tmp/ce-mach/src/example.mach'} as any)).toEqual(
            'example.mach',
        );
        expect(pane(1).mainSourceFilename({} as any)).toEqual('example.mach');
    });
});
