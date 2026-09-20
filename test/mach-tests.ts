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

import {readFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {MachCompiler} from '../lib/compilers/mach.js';
import {AsmParser} from '../lib/parsers/asm-parser.js';
import {MachAsmParser} from '../lib/parsers/asm-parser-mach.js';
import {MachIrParser} from '../lib/parsers/mach-ir.js';
import {parseProperties} from '../lib/properties.js';
import {unwrap} from '../shared/assert.js';
import {LanguageKey} from '../types/languages.interfaces.js';
import {makeCompilationEnvironment, makeFakeCompilerInfo, makeFakeParseFiltersAndOutputOptions} from './utils.js';

const languages = {
    mach: {id: 'mach' as LanguageKey, extensions: ['.mach']},
};

// `mach info targets` as mach 5.2.1 prints it.
const infoTargets = `linux-x86_64          isa=x86_64    os=linux         abi=sysv64   object=elf
linux-aarch64         isa=aarch64   os=linux         abi=aapcs64  object=elf
linux-riscv64         isa=rv64gc    os=linux         abi=lp64     object=elf
linux-riscv64         isa=rv64gc    os=linux         abi=lp64f    object=elf
linux-riscv64         isa=rv64gc    os=linux         abi=lp64d    object=elf
darwin-x86_64         isa=x86_64    os=darwin        abi=sysv64   object=macho
darwin-aarch64        isa=aarch64   os=darwin        abi=aapcs64  object=macho
windows-x86_64        isa=x86_64    os=windows       abi=win64    object=coff
freestanding-x86_64   isa=x86_64    os=freestanding  abi=sysv64   object=elf
freestanding-x86_64   isa=x86_64    os=freestanding  abi=sysv64   object=raw
freestanding-x86_64   isa=x86_64    os=freestanding  abi=win64    object=elf
freestanding-x86_64   isa=x86_64    os=freestanding  abi=win64    object=raw
freestanding-aarch64  isa=aarch64   os=freestanding  abi=aapcs64  object=elf
freestanding-aarch64  isa=aarch64   os=freestanding  abi=aapcs64  object=raw
freestanding-riscv64  isa=rv64gc    os=freestanding  abi=lp64     object=elf
freestanding-riscv64  isa=rv64gc    os=freestanding  abi=lp64     object=raw
freestanding-riscv64  isa=rv64gc    os=freestanding  abi=lp64f    object=elf
freestanding-riscv64  isa=rv64gc    os=freestanding  abi=lp64f    object=raw
freestanding-riscv64  isa=rv64gc    os=freestanding  abi=lp64d    object=elf
freestanding-riscv64  isa=rv64gc    os=freestanding  abi=lp64d    object=raw
freestanding-riscv32  isa=rv32imac  os=freestanding  abi=ilp32    object=elf
freestanding-riscv32  isa=rv32imac  os=freestanding  abi=ilp32    object=raw
freestanding-spirv    isa=spirv     os=freestanding  abi=spirv    object=spv
`;

// the formats that register a debug model in mach 5.2.1; the flat images refuse the adapter's debug profile, since they
// carry neither a debug model nor linkable objects.
const debugCapableFormats = new Set(['elf', 'macho', 'coff', 'spv']);

/**
 * Stands in for one probe build, reproducing what mach 5.2.1 with std 3.2.0 answers for the probe module: std has no layer for a
 * freestanding os, so a `use std.print` there fails inside std whatever the object format, and a format with no debug
 * model refuses the profile's debug information.
 */
async function fakeProbe(root: string, key: string) {
    const manifest = await fs.readFile(path.join(root, 'mach.toml'), 'utf8');
    const section = manifest.match(new RegExp(`^\\[target\\.${key}]\\n(?:\\w+ = "\\S+"\\n)+`, 'm'))![0];
    const os = section.match(/^os = "(\S+)"$/m)![1];
    const of = section.match(/^of = "(\S+)"$/m)![1];
    // std.types is header-only and resolves anywhere; anything above it reaches for an os
    const source = await fs.readFile(path.join(root, 'src', 'probe.mach'), 'utf8');
    const usesStdOs = /^use .*\bstd\.(?!types\b)/m.test(source);

    if (os === 'freestanding' && usesStdOs) {
        return {code: 2, stdout: '23 errors / 0 warnings', stderr: 'error: std.system.os.secret: unsupported target'};
    }
    if (!debugCapableFormats.has(of)) {
        return {
            code: 2,
            stdout: '',
            stderr: 'error: debug info was requested, but this target registers no debug model',
        };
    }
    return {code: 0, stdout: '', stderr: ''};
}

/** A std checkout the probe can find, standing in for the one installed beside the compiler. */
async function makeStd() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-mach-std'));
    await fs.writeFile(path.join(dir, 'mach.toml'), '[project]\nid = "std"\n');
    return dir;
}

function makeMach(stdPath: string) {
    return new MachCompiler(
        makeFakeCompilerInfo({id: 'mach', exe: '/opt/compiler-explorer/mach-5.2.1/mach', lang: 'mach'}),
        makeCompilationEnvironment({languages, props: {'compiler.mach.stdPath': stdPath}}),
    );
}

describe('Mach project layout', () => {
    let compiler: MachCompiler;
    let stdPath: string;

    beforeAll(async () => {
        stdPath = await makeStd();
        compiler = makeMach(stdPath);
        vi.spyOn(compiler, 'execCompilerCached').mockResolvedValue({
            code: 0,
            stdout: infoTargets,
            stderr: '',
        } as any);
        vi.spyOn(compiler, 'exec').mockImplementation(async (_exe, args) =>
            args[0] === 'dep'
                ? ({code: 0, stdout: '', stderr: ''} as any)
                : ((await fakeProbe(args[1], args[5])) as any),
        );
    });

    afterAll(async () => {
        await fs.rm(stdPath, {recursive: true, force: true});
    });

    it('offers only the tuples that build under the profile, named by the dimensions that disambiguate them', async () => {
        expect((await compiler.targets()).map(t => t.name)).toEqual([
            'linux-x86_64',
            'linux-aarch64',
            'linux-riscv64-lp64',
            'linux-riscv64-lp64f',
            'linux-riscv64-lp64d',
            'darwin-x86_64',
            'darwin-aarch64',
            'windows-x86_64',
        ]);
    });

    it('probes every tuple `mach info targets` reports, against one project with std realized once', async () => {
        await compiler.targets();
        expect((await compiler.supportedTuples()).length).toEqual(23);
        const calls = (compiler.exec as any).mock.calls.map((call: any[]) => call[1]);
        expect(calls.filter((args: string[]) => args[0] === 'dep')).toHaveLength(1);
        expect(calls.filter((args: string[]) => args[0] === 'build')).toHaveLength(23);
    });

    it('declares every offered target with its object format, the source entry and the bundled std', async () => {
        const manifest = compiler.manifest(await compiler.targets());
        expect(manifest).toContain(
            '[target.linux-riscv64-lp64d]\nisa = "rv64gc"\nos = "linux"\nabi = "lp64d"\nof = "elf"\n',
        );
        // the format is written out, not assumed: leaving it off takes the os default, which for freestanding is raw
        expect(manifest).toContain(
            '[target.darwin-aarch64]\nisa = "aarch64"\nos = "darwin"\nabi = "aapcs64"\nof = "macho"\n',
        );
        expect(manifest).toContain('[artifact.example]\nkind = "bin"\nentry = "example.mach"\n');
        expect(manifest).toContain(
            '[target.windows-x86_64]\nisa = "x86_64"\nos = "windows"\nabi = "win64"\nof = "coff"\n',
        );
        // std has no freestanding os layer, so no tuple on that os survives whatever its object format
        expect(manifest).not.toContain('freestanding');
        expect(manifest).toContain(`[dep.std]\npath = ${JSON.stringify(stdPath)}\n`);
    });

    it('builds the project root and disassembles the module object', () => {
        const root = path.join('/tmp', 'ce');
        const input = path.join(root, 'src', 'example.mach');
        expect(compiler.orderArguments(['--emit', 'obj'], input, [], [], [], [], ['-O2'], [])).toEqual([
            'build',
            root,
            '--emit',
            'obj',
            '-O2',
        ]);
        expect(compiler.getOutputFilename(root, 'output')).toEqual(
            path.join(root, 'out', 'obj', 'example', 'example.o'),
        );
        expect(compiler.getExecutableFilename(root, 'output')).toEqual(path.join(root, 'out', 'bin', 'example'));
    });

    it('disassembles every object of the project, the entry first and std left out', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-mach-objects'));
        try {
            const entry = path.join(root, 'out', 'obj', 'example', 'example.o');
            for (const file of [
                entry,
                path.join(root, 'out', 'obj', 'example', 'util', 'fmt.o'),
                path.join(root, 'out', 'obj', 'example', 'other.o'),
                path.join(root, 'out', 'obj', 'std', 'print.o'),
            ]) {
                await fs.mkdir(path.dirname(file), {recursive: true});
                await fs.writeFile(file, '');
            }
            expect(await compiler.getObjdumpInputFilenames(entry, makeFakeParseFiltersAndOutputOptions({}))).toEqual([
                entry,
                path.join(root, 'out', 'obj', 'example', 'other.o'),
                path.join(root, 'out', 'obj', 'example', 'util', 'fmt.o'),
            ]);
        } finally {
            await fs.rm(root, {recursive: true, force: true});
        }
    });

    it('disassembles the executable alone, and the entry alone when the build produced nothing', async () => {
        const exe = path.join('/tmp', 'ce', 'out', 'bin', 'example');
        expect(
            await compiler.getObjdumpInputFilenames(exe, makeFakeParseFiltersAndOutputOptions({binary: true})),
        ).toEqual([exe]);
        const entry = path.join('/tmp', 'ce-mach-missing', 'out', 'obj', 'example', 'example.o');
        expect(await compiler.getObjdumpInputFilenames(entry, makeFakeParseFiltersAndOutputOptions({}))).toEqual([
            entry,
        ]);
    });

    it('states the compiler range only to a compiler that reads it', () => {
        const env = makeCompilationEnvironment({languages});
        const at = (semver?: string) =>
            new MachCompiler(makeFakeCompilerInfo({id: 'mach', exe: '/usr/bin/mach', lang: 'mach', semver}), env)
                .manifest([])
                .split('\n')
                .filter(line => line.startsWith('mach = '));
        // 5.3.0 is the first release that reads `[project].mach`; 5.2.1 and older refuse the key
        expect(at('5.4.0')).toEqual(['mach = "^5.4"']);
        expect(at('5.3.1')).toEqual(['mach = "^5.3"']);
        expect(at('5.3.0')).toEqual(['mach = "^5.3"']);
        expect(at('5.2.1')).toEqual([]);
        expect(at('5.0.4')).toEqual([]);
        // a compiler with no configured version gets no guessed range
        expect(at(undefined)).toEqual([]);
    });

    it('takes std from beside the executable by default', () => {
        const env = makeCompilationEnvironment({languages});
        const installed = new MachCompiler(
            makeFakeCompilerInfo({id: 'mach521', exe: '/opt/compiler-explorer/mach-5.2.1/mach', lang: 'mach'}),
            env,
        );
        expect(installed.manifest([])).toContain('[dep.std]\npath = "/opt/compiler-explorer/mach-5.2.1/std"\n');
    });

    it('refuses to offer any target when the compiler has no std', async () => {
        const env = makeCompilationEnvironment({languages});
        const bare = new MachCompiler(
            makeFakeCompilerInfo({
                id: 'machbare',
                exe: path.join(os.tmpdir(), 'ce-no-such-mach', 'mach'),
                lang: 'mach',
            }),
            env,
        );
        await expect(bare.targets()).rejects.toThrow('set compiler.machbare.stdPath');
    });

    it('asks for the IR listing only when the Mach IR pane wants it, and reads it from out/ir', () => {
        const root = path.join('/tmp', 'ce');
        expect(compiler.optionsForBackend({}, '')).toEqual([]);
        // the bare flag is the ir-debug dump, whose text is not a contract; the pane reads the listing
        expect(compiler.optionsForBackend({produceMachIr: true}, '')).toEqual(['--emit-ir=listing']);
        expect(compiler.getMachIrOutputFilename(path.join(root, 'src', 'example.mach'))).toEqual(
            path.join(root, 'out', 'ir', 'example', 'example.ir'),
        );
    });

    it('offers the Mach IR pane only where the readable listing exists', () => {
        const env = makeCompilationEnvironment({languages});
        const at = (semver: string) =>
            new MachCompiler(makeFakeCompilerInfo({id: 'mach', exe: '/usr/bin/mach', lang: 'mach', semver}), env)
                .compiler.supportsMachIrView;
        // 5.0.4 is still offered beside the newer releases, and its `--emit-ir` writes only the dump: briar-systems/mach#3440
        expect(at('5.0.4')).toBe(false);
        expect(at('5.1.0')).toBe(true);
        expect(at('5.4.0')).toBe(true);
    });

    it('takes std from stdPath when a compiler names one', () => {
        const env = makeCompilationEnvironment({languages, props: {'compiler.machdev.stdPath': '/src/mach/dep/std'}});
        const dev = new MachCompiler(makeFakeCompilerInfo({id: 'machdev', exe: '/usr/bin/mach', lang: 'mach'}), env);
        expect(dev.manifest([])).toContain('[dep.std]\npath = "/src/mach/dep/std"\n');
    });
});
/**
 * Every project the adapter lays out puts the user's sources under `src/`, so CE's file names become module paths
 * rooted at the project id: `src/util/fmt.mach` is the module `example.util.fmt`.
 */
describe('Mach multi-file projects', () => {
    let compiler: MachCompiler;
    let dirPath: string;
    let stdPath: string;

    beforeAll(async () => {
        stdPath = await makeStd();
        compiler = makeMach(stdPath);
        vi.spyOn(compiler, 'execCompilerCached').mockResolvedValue({
            code: 0,
            stdout: infoTargets,
            stderr: '',
        } as any);
    });

    beforeEach(async () => {
        dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-mach-layout'));
    });

    afterEach(async () => {
        await fs.rm(dirPath, {recursive: true, force: true});
    });

    afterAll(async () => {
        await fs.rm(stdPath, {recursive: true, force: true});
    });

    it('roots every source at src/ and keeps the directories CE gave them', async () => {
        const pull = vi.spyOn(compiler, 'exec').mockResolvedValue({code: 0, stdout: '', stderr: ''} as any);

        const {inputFilename} = await (compiler as any).writeAllFiles(dirPath, 'entry', [
            {filename: 'util/fmt.mach', contents: 'fmt'},
            {filename: 'other.mach', contents: 'other'},
        ]);

        expect(inputFilename).toEqual(path.join(dirPath, 'src', 'example.mach'));
        expect(((await fs.readdir(dirPath, {recursive: true})) as string[]).sort()).toEqual([
            'mach.toml',
            'src',
            path.join('src', 'example.mach'),
            path.join('src', 'other.mach'),
            'src/util',
            path.join('src', 'util', 'fmt.mach'),
        ]);
        expect(await fs.readFile(path.join(dirPath, 'src', 'util', 'fmt.mach'), 'utf8')).toEqual('fmt');
        expect(pull).toHaveBeenCalledWith(
            '/opt/compiler-explorer/mach-5.2.1/mach',
            ['dep', 'pull', dirPath],
            expect.objectContaining({customCwd: dirPath}),
        );
    });

    it('refuses an extra file that would land outside the project', async () => {
        vi.spyOn(compiler, 'exec').mockResolvedValue({code: 0, stdout: '', stderr: ''} as any);
        await expect(
            (compiler as any).writeAllFiles(dirPath, 'entry', [{filename: '../escape.mach', contents: 'no'}]),
        ).rejects.toThrow();
    });

    it('fails the compilation when the dependency pull fails', async () => {
        vi.spyOn(compiler, 'exec').mockResolvedValue({code: 1, stdout: '', stderr: 'no std'} as any);
        await expect((compiler as any).writeAllFiles(dirPath, 'entry', [])).rejects.toThrow(
            'mach dep pull failed: no std',
        );
    });
});
/**
 * The shapes covered here are ones `mach.cli.diagnostic` renders at 5.2.1: the `error:` and `warning:` headlines, the
 * `--> file:line:col` frame and its gutter, a related frame underlined with `-`, the `= note:`, `= help:` and `= fix:`
 * trailer, a fix's edits at their own locations, the elided and truncated span bodies, a `Fail` with no location, and
 * the `N errors / M warnings` summary. Each capture is compiler output with the temp directory rewritten to a stable
 * path, verbatim except that std.txt keeps only the first of its errors.
 */
describe('Mach diagnostics', () => {
    const root = '/tmp/compiler-explorer-compiler-mach';
    const inputFilename = `${root}/src/example.mach`;
    let compiler: MachCompiler;

    beforeAll(() => {
        compiler = new MachCompiler(
            makeFakeCompilerInfo({id: 'mach', exe: '/opt/compiler-explorer/mach-5.2.1/mach', lang: 'mach'}),
            makeCompilationEnvironment({languages}),
        );
    });

    function parseText(stderr: string) {
        return compiler.processExecutionResult({code: 1, stdout: '', stderr} as any, inputFilename).stderr;
    }

    function parse(name: string) {
        return parseText(readFileSync(path.join(__dirname, 'mach', 'diagnostics', `${name}.txt`), 'utf8'));
    }

    /** Every marker as [file, line, column, severity, text]. */
    function marks(lines: ReturnType<typeof parse>) {
        return lines
            .filter(line => line.tag)
            .map(({tag}) => [tag!.file, tag!.line, tag!.column, tag!.severity, tag!.text]);
    }

    function texts(lines: ReturnType<typeof parse>) {
        return lines.map(line => line.text);
    }

    it('marks an error at its location, and shows paths from the project root', () => {
        expect(marks(parse('error'))).toEqual([
            ['example.mach', 7, 9, 3, 'error: unresolved identifier `bogus`'],
            // the location line links to its place; its empty text keeps it out of the editor
            ['example.mach', 7, 9, 3, ''],
        ]);
        expect(texts(parse('error'))).toEqual(
            expect.arrayContaining([' --> src/example.mach:7:9', '1 error / 0 warnings']),
        );
    });

    it('marks a warning at warning severity, and keeps it apart from an error', () => {
        expect(marks(parse('warning'))[0]).toEqual([
            'example.mach',
            8,
            3,
            2,
            'warning: documented component matches no parameter, field, generic, or `ret` of this declaration',
        ]);
        expect(
            marks(parse('warning-and-error')).map(([, line, , severity, text]) => [line, severity, text !== '']),
        ).toEqual([
            [8, 2, true],
            [8, 2, false],
            [13, 3, true],
            [13, 3, false],
        ]);
    });

    it('folds note and help trailers into the headline, and marks each fix edit where it goes', () => {
        expect(marks(parse('note-and-fix'))).toEqual([
            [
                'example.mach',
                8,
                5,
                3,
                'error: type mismatch: expected i64, found i32\nnote: mach has no implicit widening; cast the value with `value::Type`',
            ],
            ['example.mach', 8, 5, 3, ''],
            ['example.mach', 8, 10, 3, ''],
            ['example.mach', 8, 10, 1, 'fix: cast the value to `i64` (replace with `::i64`)'],
        ]);
        expect(marks(parse('help-and-fix'))).toEqual([
            ['example.mach', 9, 9, 3, 'error: unresolved identifier `helpr`\nhelp: did you mean `helper`?'],
            ['example.mach', 9, 9, 3, ''],
            ['example.mach', 9, 9, 3, ''],
            // the fix is labelled with its only edit, which is not repeated
            ['example.mach', 9, 9, 1, 'fix: replace with `helper`'],
        ]);
    });

    it('marks both edits of a two-edit fix over a multi-line span, and leaves the span body as output', () => {
        const fixes = marks(parse('two-edit-fix')).filter(([, , , severity]) => severity === 1);
        expect(fixes).toEqual([
            ['example.mach', 8, 9, 1, 'fix: cast the value to `i64` (replace with `(`)'],
            ['example.mach', 10, 10, 1, 'fix: cast the value to `i64` (replace with `)::i64`)'],
        ]);
        expect(texts(parse('two-edit-fix'))).toEqual(expect.arrayContaining([' 9 |         +', '   | ---------']));
    });

    it('leaves an elided span body and a truncated long line as plain output', () => {
        expect(texts(parse('elided-span'))).toContain('   | ...');
        expect(marks(parse('elided-span')).map(([, line]) => line)).toEqual([8, 8, 8, 8, 20, 20]);
        expect(texts(parse('long-line')).find(line => line.startsWith('7 |'))).toMatch(/\.\.\.$/);
        expect(marks(parse('long-line')).map(([, line, column]) => [line, column])).toEqual([
            [7, 9],
            [7, 9],
        ]);
    });

    it('marks a related frame with the label under it', () => {
        expect(marks(parse('related'))).toEqual([
            ['example.mach', 6, 5, 3, 'error: duplicate definition: `dup` is already bound in this scope'],
            ['example.mach', 6, 5, 3, ''],
            ['example.mach', 5, 5, 3, ''],
            ['example.mach', 5, 5, 1, 'previous definition here'],
        ]);
    });

    it('names a second file by the path the project tree knows it by', () => {
        expect(marks(parse('second-file'))[0]).toEqual([
            'util/fmt.mach',
            2,
            9,
            3,
            'error: unresolved identifier `nope`',
        ]);
    });

    it('marks nothing in a std file, which belongs to no editor, but still shows where it is', () => {
        expect(marks(parse('std'))).toEqual([]);
        expect(texts(parse('std'))).toContain('   --> dep/std/src/system/os/secret.mach:667:5');
    });

    it('marks nothing for a failure that carries no location', () => {
        expect(texts(parse('fail'))).toEqual(['error: no mach.toml in the project directory']);
        expect(marks(parse('fail'))).toEqual([]);
    });

    it('reads every headline of the severity catalog at its own severity', () => {
        // no caller in the compiler emits a top-level `info:` or `help:` at 5.2.1, so these are rendered the way the
        // renderer's severity label writes them rather than captured from a build
        const severity = (headline: string) =>
            marks(parseText(`${headline}\n --> ${inputFilename}:3:1\n  |\n3 | ret 0;\n  | ^^^^^^\n`))[0][3];
        expect(severity('error: it broke')).toEqual(3);
        expect(severity('warning: it creaks')).toEqual(2);
        expect(severity('info: a remark')).toEqual(1);
        expect(severity('help: try this')).toEqual(1);
        expect(severity('error: unknown Severity tag 9: odd')).toEqual(3);
    });

    it('reads through colour escapes', () => {
        const coloured = `\x1b[31merror: it broke\x1b[0m\n \x1b[34m-->\x1b[0m ${inputFilename}:3:1\n`;
        expect(marks(parseText(coloured))[0]).toEqual(['example.mach', 3, 1, 3, 'error: it broke']);
    });

    describe('does not mark', () => {
        it("a headline in another compiler's layout", () => {
            // rustc's `error[E0308]:` is not a mach headline, so its location marks nothing
            expect(marks(parseText(`error[E0308]: mismatched types\n --> ${inputFilename}:3:1\n`))).toEqual([]);
        });

        it('a location that follows no headline, gutter bar or fix', () => {
            const output = ['error: first', ` --> ${inputFilename}:3:1`, '', ` --> ${inputFilename}:9:1`].join('\n');
            expect(marks(parseText(output)).map(([, line]) => line)).toEqual([3, 3]);
        });

        it('a label under the primary frame as a related location', () => {
            const output = ['error: first', ` --> ${inputFilename}:3:1`, '  |', '3 | ret 0;', '  | ^^^ here'].join(
                '\n',
            );
            expect(marks(parseText(output)).map(([, , , , text]) => text)).toEqual(['error: first', '']);
        });

        it('an edit once its diagnostic has ended', () => {
            const output = [
                'error: first',
                ` --> ${inputFilename}:3:1`,
                '  = fix: do it',
                '',
                ` --> ${inputFilename}:9:1`,
                '    -> replace with `x`',
            ].join('\n');
            expect(marks(parseText(output)).map(([, line]) => line)).toEqual([3, 3]);
        });

        it('a trailer as its own marker', () => {
            const output = ['error: first', ` --> ${inputFilename}:3:1`, '  |', '  = note: see here'].join('\n');
            expect(marks(parseText(output))).toEqual([
                ['example.mach', 3, 1, 3, 'error: first\nnote: see here'],
                ['example.mach', 3, 1, 3, ''],
            ]);
        });
    });
});

/**
 * Under the production sandbox the compile directory is bind-mounted at `/app`, so the project root the adapter
 * passes to `mach build` is `/app` and the DWARF comp_dir it records is `/app` too. The capture below is a real
 * objdump of an object built with the project root at `/app`.
 */
describe('Mach asm with an /app project root', () => {
    it('attributes an /app source line to the editor', () => {
        const objdump = readFileSync(path.join(__dirname, 'mach', 'app-objdump.asm'), 'utf8');
        const parsed = new AsmParser().process(
            objdump,
            makeFakeParseFiltersAndOutputOptions({binaryObject: true, directives: true}),
        );

        expect(parsed.asm.filter(line => line.source).map(line => line.source)).toContainEqual({
            file: null,
            line: 9,
            mainsource: true,
        });
        expect(parsed.asm.map(line => line.text)).toContain('main:');
    });

    it('strips the /app root when filenames are not masked', () => {
        const objdump = readFileSync(path.join(__dirname, 'mach', 'app-objdump.asm'), 'utf8');
        const parsed = new AsmParser().process(
            objdump,
            makeFakeParseFiltersAndOutputOptions({binaryObject: true, directives: true, dontMaskFilenames: true}),
        );

        expect(parsed.asm.filter(line => line.source).map(line => line.source)).toContainEqual({
            file: 'src/example.mach',
            line: 9,
            mainsource: true,
        });
    });
});

/**
 * `objdump -d -l` over both objects of a two-module project, the temp directory rewritten to `/app`:
 *
 *   src/example.mach                          src/util/fmt.mach
 *   1  use print: std.print;                  1  pub fun twice(x: i64) i64 {
 *   2  use fmt: example.util.fmt;             2      ret x * 2;
 *   3                                         3  }
 *   4  pub fun main() i64 {                   4
 *   5      print.println("hi");               5  pub fun unused(x: i64) i64 {
 *   6      ret fmt.twice(3);                  6      ret x + 7;
 *   7  }                                      7  }
 *
 * Nothing is inlined at opt 0, so `twice` exists only in the second object, and `unused` is never called at all.
 */
describe('Mach asm from two modules', () => {
    const objdump = readFileSync(path.join(__dirname, 'mach', 'two-module-objdump.asm'), 'utf8');
    const parse = (filters: object) =>
        new MachAsmParser(undefined, 'src').process(
            objdump,
            makeFakeParseFiltersAndOutputOptions({binaryObject: true, directives: true, ...filters}),
        );
    const sources = (parsed: {asm: {source?: unknown}[]}) =>
        parsed.asm.filter(line => line.source).map(line => line.source);

    it('shows every function of every module, the entry first', () => {
        const labels = parse({})
            .asm.map(line => line.text)
            .filter(text => text.endsWith(':'));
        expect(labels).toEqual(['example.example.main:', 'example.util.fmt.twice:', 'example.util.fmt.unused:']);
    });

    it('names a second file by the path the tree pane knows it by, and keeps it off the entry', () => {
        const parsed = parse({dontMaskFilenames: true});
        expect(sources(parsed)).toContainEqual({file: 'example.mach', line: 6, mainsource: true});
        expect(sources(parsed)).toContainEqual({file: 'util/fmt.mach', line: 2, mainsource: false});
        expect(sources(parsed)).not.toContainEqual(expect.objectContaining({file: 'src/util/fmt.mach'}));
    });

    it("marks only the entry as the editor's when filenames are masked", () => {
        const parsed = parse({});
        expect(sources(parsed)).toContainEqual({file: null, line: 4, mainsource: true});
        expect(sources(parsed)).toContainEqual({file: 'util/fmt.mach', line: 6, mainsource: false});
    });

    it('keeps a second file under the library code filter, as code the user wrote', () => {
        const labels = parse({libraryCode: true})
            .asm.map(line => line.text)
            .filter(text => text.endsWith(':'));
        expect(labels).toContain('example.util.fmt.twice:');
    });
});

describe('Mach binary asm', () => {
    // a Hello World executable, trimmed to the head of each function: std and its runtime are linked in beside main
    const objdump = readFileSync(path.join(__dirname, 'mach', 'hello-binary.asm'), 'utf8');

    it.each(['amazon', 'defaults'])('shows only the user functions under the %s properties', env => {
        const file = path.join(__dirname, '..', 'etc', 'config', `mach.${env}.properties`);
        const props = parseProperties(readFileSync(file, 'utf8'), file);
        const parsed = new AsmParser((key: string) => props[key]).process(
            objdump,
            makeFakeParseFiltersAndOutputOptions({binary: true, directives: true}),
        );
        expect(parsed.asm.map(line => line.text).filter(text => text.endsWith(':'))).toEqual(['main:']);
    });
});

/**
 * `--emit-ir=listing`, captured from the project the adapter lays out: `src/example.mach` is the user's editor,
 * `src/helper.mach` is a second file CE gave the compilation, and `dep/std` is the std the pull realized. The temp
 * directory is rewritten to a stable path, as the diagnostics captures are.
 *
 *   src/example.mach                          src/helper.mach
 *   1  use math: std.math;                    1  #[inline]
 *   2  use helper: example.helper;            2  pub fun bump(x: i64) i64 {
 *   3                                         3      ret x + 1;
 *   4  val LANES: i64 = 4;                    4  }
 *   5
 *   6  #[oblivious]
 *   7  pub fun mask(k: ^u64) ^u64 {
 *   8      ret k ^ 0x5555555555555555;
 *   9  }
 *   10
 *   11 pub fun main() i64 {
 *   12     var acc: i64 = math.min(LANES, 9);
 *   13     acc = acc + helper.bump(acc);
 *   14     ret acc;
 *   15 }
 *
 * `min` and `bump` are both inlined at -O2, so `main` holds instructions from three files at once.
 */
describe('Mach IR listing', () => {
    const listing = readFileSync(path.join(__dirname, 'mach', 'ir-listing.ir'), 'utf8');
    const parsed = new MachIrParser('src/example.mach').process(listing);

    function at(text: string) {
        return unwrap(parsed.find(line => line.text.includes(text)));
    }

    it('keeps every line of the listing, in order', () => {
        expect(parsed.map(line => line.text)).toHaveLength(listing.split('\n').length - 1);
        expect(parsed[0].text).toEqual(
            'ir-listing stage="post-codegen" target="linux-x86_64" isa="x86_64" os="linux" abi="sysv64" of="elf"',
        );
        expect(parsed.at(-1)!.text).toEqual('}');
    });

    it('resolves a bare position against the file the function header names', () => {
        // the header names src/example.mach, so `8:9` is the user's line 8, column 9
        expect(at('xor.secret.pure').source).toEqual({file: null, line: 8, column: 9, mainsource: true});
        expect(at('ret ~%4').source).toEqual({file: null, line: 8, column: 5, mainsource: true});
    });

    it("names the user's own source in the header, and marks it as the editor's", () => {
        expect(at('fun @example.example.mask').text).toEqual(
            '  fun @example.example.mask(~%p0: i64) i64 [pub oblivious] { ; <source>',
        );
    });

    it('keeps a position in another file of the project off the editor', () => {
        // helper.mach line 2 is not the user's line 2: briar-systems/compiler-explorer#16 is this bug elsewhere
        const inlined = at('%29 = alloca');
        expect(inlined.text).toEqual('      %29 = alloca i64 1                            ; src/helper.mach:2:9');
        expect(inlined.source).toEqual({file: 'src/helper.mach', line: 2, column: 9});
    });

    it('keeps a position in std off the editor too', () => {
        const fromStd = at('%20 = cmp_lt_s.pure');
        expect(fromStd.source).toEqual({file: 'dep/std/src/math.mach', line: 16, column: 9});
    });

    it('maps nothing for an instruction that carries no position', () => {
        expect(at('%28 = phi.pure').source).toBeUndefined();
        expect(parsed.filter(line => line.text.trimEnd().endsWith('br bb1')).map(line => line.source)).toEqual([
            undefined,
        ]);
    });

    it("maps nothing for the listing's own structure", () => {
        expect(at('module example.example').source).toBeUndefined();
        expect(at('val @example.example.LANES').source).toBeUndefined();
        expect(at('unattached:').source).toBeUndefined();
        expect(at('bb1 [preds=bb0]').source).toBeUndefined();
        // an extern declaration has no body, so it names no file and never moves the header the block below reads
        expect(at('fun @std.math.min').text).toEqual('  fun @std.math.min(i64, i64) i64 [extern]');
    });

    it('maps the unattached block the same way as any other', () => {
        // the instructions no block owns still carry real positions, and the pane shows them where the compiler put them
        expect(at('%10 = load i64 %0').source).toEqual({file: null, line: 14, column: 9, mainsource: true});
        expect(at('%18 = load i64 %12').source).toEqual({file: 'dep/std/src/math.mach', line: 16, column: 9});
    });

    it('resolves a bare position against nothing when the header could not name a file', () => {
        // the file a header names is the function's alone: it must not carry into the next one, whose own header
        // names no file because the compiler could not resolve one
        const orphan = [
            '  fun @m.named() i64 {                              ; src/example.mach',
            '      ret 0                                         ; 3:5',
            '  }',
            '  fun @m.unnamed() i64 {',
            '      ret 1                                         ; 4:5',
            '  }',
        ];
        const rows = new MachIrParser('src/example.mach').process(orphan.join('\n') + '\n');
        expect(rows[1].source).toEqual({file: null, line: 3, column: 5, mainsource: true});
        expect(rows[4].source).toBeUndefined();
    });

    it('maps nothing for an offset the compiler could not resolve to a line', () => {
        const unloaded = [
            '  fun @m.f() i64 {                                ; src/example.mach',
            '      ret 0                                         ; file#3@120',
            '  }',
        ];
        const rows = new MachIrParser('src/example.mach').process(unloaded.join('\n') + '\n');
        expect(rows[1].source).toBeUndefined();
        expect(rows[1].text).toEqual('      ret 0                                         ; file#3@120');
    });
});
