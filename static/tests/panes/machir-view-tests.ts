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

import {ParsedAsmResultLine} from '../../../types/asmresult/asmresult.interfaces.js';
import {MachIr} from '../../panes/machir-view.js';

/**
 * The listing the pane is given, cut down to the four shapes that decide whether a line may reach the editor: the
 * user's own source, a second file of the project, std, and an instruction with no position at all.
 */
const listing: ParsedAsmResultLine[] = [
    {text: '  fun @example.example.main() i64 [pub] {           ; <source>'},
    {text: '    bb0:'},
    {text: '      dbg_value 4                                   ; 12:5', source: {file: null, line: 12, column: 5}},
    {text: '      br bb1'},
    {
        text: '      dbg_value 4                                   ; src/helper.mach:2:9',
        source: {file: 'src/helper.mach', line: 2, column: 9},
    },
    {
        text: '      br bb5                                        ; dep/std/src/math.mach:16:5',
        source: {file: 'dep/std/src/math.mach', line: 16, column: 5},
    },
    {text: '      ret 9                                         ; 14:5', source: {file: null, line: 14, column: 5}},
];

function pane(settings: Record<string, unknown> = {}) {
    const view = Object.create(MachIr.prototype) as MachIr;
    Object.assign(view, {
        listing,
        compilerInfo: {compilerId: 1, editorId: 2, treeId: 0},
        editorDecorations: {set: vi.fn()},
        editor: {deltaDecorations: vi.fn().mockReturnValue([]), revealLinesInCenter: vi.fn()},
        eventHub: {emit: vi.fn()},
        decorations: {},
        previousDecorations: [],
        settings,
    });
    return view;
}

describe('Mach IR pane', () => {
    it('colours only the lines whose position is in the editor', () => {
        const view = pane();
        // the editor's lines 12 and 14 are coloured; helper.mach line 2 and math.mach line 16 are not the editor's
        view.onColours(2, {11: 0, 13: 1, 1: 2, 15: 3}, 'rainbow');

        const decorations = (view.editorDecorations.set as any).mock.calls[0][0];
        expect(decorations.map((d: any) => d.range.startLineNumber)).toEqual([3, 7]);
        expect(decorations.map((d: any) => d.options.className)).toEqual([
            'line-linkage rainbow-0',
            'line-linkage rainbow-1',
        ]);
    });

    it('leaves the editor alone for a line whose position is in another file', () => {
        const view = pane();
        // helper.mach:2 would mark the user's line 2 if the file were ignored: briar-systems/compiler-explorer#16
        view.onColours(2, {1: 0}, 'rainbow');
        expect((view.editorDecorations.set as any).mock.calls[0][0]).toEqual([]);
    });

    it('ignores colours meant for another editor', () => {
        const view = pane();
        view.onColours(9, {11: 0}, 'rainbow');
        expect(view.editorDecorations.set).not.toHaveBeenCalled();
    });

    it('links the editor line the hovered instruction came from', () => {
        const view = pane({hoverShowSource: true, indefiniteLineHighlight: true});
        view.onMouseMove({target: {position: {lineNumber: 3}}} as any);
        expect(view.eventHub.emit).toHaveBeenCalledWith('editorLinkLine', 2, 12, 5, 5, false);
    });

    it('links nothing when the hovered instruction came from another file', () => {
        const view = pane({hoverShowSource: true, indefiniteLineHighlight: true});
        view.onMouseMove({target: {position: {lineNumber: 5}}} as any);
        expect(view.eventHub.emit).toHaveBeenCalledWith('editorLinkLine', 2, -1, -1, -1, false);
    });

    it('marks every listing line an editor line produced, and none it did not', () => {
        const view = pane({indefiniteLineHighlight: true});
        view.onPanesLinkLine(1, 12, 5, 5, false, 'editor');

        const marked = (view.editor.deltaDecorations as any).mock.calls[0][1];
        expect(marked.map((d: any) => d.range.startLineNumber)).toEqual([3, 3]);

        // helper.mach's line 2, which is not the editor's line 2
        view.onPanesLinkLine(1, 2, 9, 9, false, 'editor');
        expect((view.editor.deltaDecorations as any).mock.calls[1][1]).toEqual([]);
    });
});
