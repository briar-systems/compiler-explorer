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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {CompilationEnvironment} from '../lib/compilation-env.js';
import {MachCompiler} from '../lib/compilers/mach.js';
import {LanguageKey} from '../types/languages.interfaces.js';
import {makeCompilationEnvironment, makeFakeCompilerInfo} from './utils.js';

const languages = {
    mach: {id: 'mach' as LanguageKey, extensions: ['.mach']},
};

const infoTargets = `linux-x86_64          isa=x86_64    os=linux         abi=sysv64   object=elf
linux-riscv64         isa=rv64gc    os=linux         abi=lp64     object=elf
linux-riscv64         isa=rv64gc    os=linux         abi=lp64d    object=elf
freestanding-x86_64   isa=x86_64    os=freestanding  abi=sysv64   object=elf
freestanding-x86_64   isa=x86_64    os=freestanding  abi=sysv64   object=raw
`;

describe('Mach project layout', () => {
    let ce: CompilationEnvironment;
    let compiler: MachCompiler;

    beforeAll(() => {
        ce = makeCompilationEnvironment({languages});
        compiler = new MachCompiler(
            makeFakeCompilerInfo({id: 'mach', exe: '/opt/compiler-explorer/mach-5.0.4/mach', lang: 'mach'}),
            ce,
        );
        vi.spyOn(compiler, 'execCompilerCached').mockResolvedValue({
            code: 0,
            stdout: infoTargets,
            stderr: '',
        } as any);
    });

    it('names one target per tuple, qualified by abi only where a platform has several', async () => {
        expect((await compiler.targets()).map(t => t.name)).toEqual([
            'linux-x86_64',
            'linux-riscv64-lp64',
            'linux-riscv64-lp64d',
            'freestanding-x86_64',
        ]);
    });

    it('declares every target, the source entry and the bundled std as a path dependency', async () => {
        const manifest = compiler.manifest(await compiler.targets());
        expect(manifest).toContain('[target.linux-riscv64-lp64d]\nisa = "rv64gc"\nos = "linux"\nabi = "lp64d"\n');
        expect(manifest).toContain('[artifact.example]\nkind = "bin"\nentry = "example.mach"\n');
        expect(manifest).toContain(
            'targets = ["linux-x86_64", "linux-riscv64-lp64", "linux-riscv64-lp64d", "freestanding-x86_64"]',
        );
        expect(manifest).toContain('[dep.std]\npath = "/opt/compiler-explorer/mach-5.0.4/std"\n');
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

    it('asks for the IR dump only when the Mach IR pane wants it, and reads it from out/ir', () => {
        const root = path.join('/tmp', 'ce');
        expect(compiler.optionsForBackend({}, '')).toEqual([]);
        expect(compiler.optionsForBackend({produceMachIr: true}, '')).toEqual(['--emit-ir']);
        expect(compiler.getMachIrOutputFilename(path.join(root, 'src', 'example.mach'))).toEqual(
            path.join(root, 'out', 'ir', 'example', 'example.ir'),
        );
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

    beforeAll(() => {
        compiler = new MachCompiler(
            makeFakeCompilerInfo({id: 'mach', exe: '/opt/compiler-explorer/mach-5.0.4/mach', lang: 'mach'}),
            makeCompilationEnvironment({languages}),
        );
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
            '/opt/compiler-explorer/mach-5.0.4/mach',
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
