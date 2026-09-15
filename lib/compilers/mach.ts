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

import type {
    CacheKey,
    CompilationCacheKey,
    CompilationResult,
    ExecutionOptionsWithEnv,
    FiledataPair,
} from '../../types/compilation/compilation.interfaces.js';
import type {PreliminaryCompilerInfo} from '../../types/compiler.interfaces.js';
import type {BasicExecutionResult, UnprocessedExecResult} from '../../types/execution/execution.interfaces.js';
import type {ParseFiltersAndOutputOptions} from '../../types/features/filters.interfaces.js';
import {BaseCompiler} from '../base-compiler.js';
import {CompilationEnvironment} from '../compilation-env.js';
import * as utils from '../utils.js';
import {MachParser} from './argument-parsers.js';

/** One platform tuple the compiler supports, keyed by the name a user passes to `--target`. */
export type MachTarget = {
    name: string;
    isa: string;
    os: string;
    abi: string;
};

/**
 * Mach has no single-file mode: every build is a project with a manifest and a realized dependency closure (std
 * included). Each compilation therefore lays out a project in the temp dir:
 *
 *   mach.toml               generated; one bin artifact, every supported target, std as a path dependency
 *   src/example.mach        the user's source (and any extra files, rooted at src/)
 *   dep/std/                realized by `mach dep pull` from the installed std named by `stdPath`
 *   out/obj/example/*.o     per-module objects, disassembled with objdump against their DWARF line table
 *   out/bin/example         the linked executable
 */
export class MachCompiler extends BaseCompiler {
    static get key() {
        return 'mach';
    }

    private readonly stdPath: string;

    constructor(info: PreliminaryCompilerInfo, env: CompilationEnvironment) {
        super(info, env);
        this.stdPath = this.compilerProps<string>(`compiler.${this.compiler.id}.stdPath`);
        this.compiler.supportsTarget = true;
    }

    override getArgumentParserClass() {
        return MachParser;
    }

    get projectId(): string {
        return path.parse(this.compileFilename).name;
    }

    projectRoot(inputFilename: string): string {
        return path.dirname(path.dirname(inputFilename));
    }

    /** Every (isa, os, abi) tuple from `mach info targets`, named after mach's own platform name. */
    async targets(): Promise<MachTarget[]> {
        const result = await this.execCompilerCached(this.compiler.exe, ['info', 'targets']);
        if (result.code !== 0) throw new Error(`mach info targets failed: ${result.stderr}`);

        const rows: MachTarget[] = [];
        for (const line of utils.splitLines(result.stdout)) {
            const match = line.match(/^(\S+)\s+isa=(\S+)\s+os=(\S+)\s+abi=(\S+)\s+object=\S+/);
            if (!match) continue;
            const [, name, isa, os, abi] = match;
            // raw and elf variants of one tuple are the same target to a manifest
            if (!rows.some(r => r.name === name && r.abi === abi)) rows.push({name, isa, os, abi});
        }
        // a platform name with several abis is qualified by the abi so every key stays unique
        return rows.map(r =>
            rows.filter(other => other.name === r.name).length > 1 ? {...r, name: `${r.name}-${r.abi}`} : r,
        );
    }

    manifest(targets: MachTarget[]): string {
        const id = this.projectId;
        const lines = [
            '[project]',
            `id = "${id}"`,
            'version = "0.0.0"',
            'src = "src"',
            'out = "out"',
            '',
            '[profile.ce]',
            'default = true',
            'opt = 0',
            'debug = true',
            'simd = "scalarize"',
            'vectorize = true',
            'float_reassoc = false',
            '',
        ];
        for (const t of targets) {
            lines.push(`[target.${t.name}]`, `isa = "${t.isa}"`, `os = "${t.os}"`, `abi = "${t.abi}"`, '');
        }
        lines.push(
            `[artifact.${id}]`,
            'kind = "bin"',
            `entry = "${this.compileFilename}"`,
            `out = "bin/${id}"`,
            `targets = [${targets.map(t => `"${t.name}"`).join(', ')}]`,
            'link = []',
            'need = []',
            '',
            '[dep.std]',
            `path = ${JSON.stringify(this.stdPath)}`,
            '',
        );
        return lines.join('\n');
    }

    protected override async writeAllFiles(dirPath: string, source: string, files: FiledataPair[]) {
        if (!source) throw new Error(`File ${this.compileFilename} has no content or file is missing`);
        if (!this.stdPath) throw new Error(`compiler.${this.compiler.id}.stdPath is not configured`);

        const srcDir = path.join(dirPath, 'src');
        await fs.mkdir(srcDir, {recursive: true});

        const inputFilename = path.join(srcDir, this.compileFilename);
        await fs.writeFile(inputFilename, source);
        if (files && files.length > 0) await this.writeMultipleFiles(files, srcDir);

        await fs.writeFile(path.join(dirPath, 'mach.toml'), this.manifest(await this.targets()));

        const pull = await this.exec(this.compiler.exe, ['dep', 'pull', dirPath], {
            ...this.getDefaultExecOptions(),
            customCwd: dirPath,
        });
        if (pull.code !== 0) throw new Error(`mach dep pull failed: ${pull.stderr || pull.stdout}`);

        return {inputFilename};
    }

    override getOutputFilename(dirPath: string, outputFilebase: string, key?: CacheKey | CompilationCacheKey) {
        if (this.isCacheKey(key) && key.filters?.binary)
            return this.getExecutableFilename(dirPath, outputFilebase, key);
        const id = this.projectId;
        return path.join(dirPath, 'out', 'obj', id, `${id}.o`);
    }

    override getExecutableFilename(dirPath: string, outputFilebase: string, key?: CacheKey | CompilationCacheKey) {
        return path.join(dirPath, 'out', 'bin', this.projectId);
    }

    override optionsForFilter(filters: ParseFiltersAndOutputOptions, outputFilename: string) {
        // the object's disassembly is the asm view: mach's text listing is not an assembler file
        if (!filters.binary) filters.binaryObject = true;
        return ['--emit', filters.binary ? 'exe' : 'obj'];
    }

    override orderArguments(
        options: string[],
        inputFilename: string,
        libIncludes: string[],
        libOptions: string[],
        libPaths: string[],
        libLinks: string[],
        userOptions: string[],
        staticLibLinks: string[],
    ) {
        // an absolute project root makes the DWARF comp_dir absolute, which objdump needs to name source lines
        return ['build', this.projectRoot(inputFilename), ...options, ...userOptions];
    }

    override async runCompiler(
        compiler: string,
        options: string[],
        inputFilename: string,
        execOptions: ExecutionOptionsWithEnv,
        filters?: ParseFiltersAndOutputOptions,
    ): Promise<CompilationResult> {
        execOptions.customCwd = this.projectRoot(inputFilename);
        return super.runCompiler(compiler, options, inputFilename, execOptions, filters);
    }

    override async buildExecutable(
        compiler: string,
        options: string[],
        inputFilename: string,
        execOptions: ExecutionOptionsWithEnv,
    ) {
        execOptions.customCwd = this.projectRoot(inputFilename);
        return super.buildExecutable(compiler, options, inputFilename, execOptions);
    }

    override processExecutionResult(input: UnprocessedExecResult, inputFilename?: string): BasicExecutionResult {
        return {
            ...input,
            stdout: utils.parseRustOutput(input.stdout, inputFilename),
            stderr: utils.parseRustOutput(input.stderr, inputFilename),
        };
    }
}
