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
import path from 'node:path';

import {beforeAll, describe, expect, it, vi} from 'vitest';

import {CompilationEnvironment} from '../lib/compilation-env.js';
import {MachCompiler} from '../lib/compilers/mach.js';
import {LanguageKey} from '../types/languages.interfaces.js';
import {makeCompilationEnvironment, makeFakeCompilerInfo} from './utils.js';

const languages = {
    mach: {id: 'mach' as LanguageKey, extensions: ['.mach']},
};

// `mach info targets` as mach 5.0.4 prints it.
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

// the formats that registered a debug model in mach 5.0.4; every other one refused the adapter's debug profile
const debugCapableFormats = new Set(['elf', 'macho']);

/**
 * Stands in for one probe build, reproducing what mach 5.0.4 answered for the probe module: std has no layer for a
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
        return {code: 2, stdout: '745 errors / 0 warnings', stderr: 'error: unresolved identifier `native_read_at`'};
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
        vi.spyOn(compiler, 'exec').mockImplementation(async (_exe, args) =>
            args[0] === 'dep'
                ? ({code: 0, stdout: '', stderr: ''} as any)
                : ((await fakeProbe(args[1], args[5])) as any),
        );
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
        // coff registers no debug model, and std has no freestanding os layer
        expect(manifest).not.toContain('windows-x86_64');
        expect(manifest).not.toContain('freestanding');
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
