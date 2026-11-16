// Entry driver for the markdown-render-speed-02 competition.
//
// Reads every case from cases.json in the input directory, renders each
// case's Markdown to HTML with the parser in parse.js, and writes the
// resulting array of HTML strings to html.json in the output directory.
// The directories default to /input and /output inside the grading
// container; the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR environment
// variables override them for local runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface CaseInput {
  markdown: string;
}

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as CaseInput[];

const html: string[] = new Array<string>(cases.length);
for (let idx = 0; idx < cases.length; idx++) {
  html[idx] = parse(cases[idx].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
