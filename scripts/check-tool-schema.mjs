// Validates the tool definitions the plugin registers against the pinned harness's own
// schema checker. `register()` only asserts `output.schema`; `parameters` goes to the
// model verbatim, so both are checked here with the same function the registry uses.
//
// Run inside the runtime image, where @deepseek-ai/dsh-tools is installed:
//   docker run --rm -v "$PWD:/repo:ro" --entrypoint node shuiyuan-pet:phase1 \
//     /repo/scripts/check-tool-schema.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire('/opt/dsh/package.json');
// `json-schema.js` is not an exported subpath, so resolve the package root and reach in.
const toolsRoot = dirname(require.resolve('@deepseek-ai/dsh-tools/package.json'));
const {assertSupportedJsonSchema} = await import(pathToFileURL(join(toolsRoot, 'lib/types/json-schema.js')).href);
const {Reader} = await import('/repo/plugins/shuiyuan-pet/dist/tools.js');

const config = {readCalls: 4, readChars: 6000, readTotal: 20000, readSpan: 11};
const pack = {source: {topic_id: 77, raw: ''}, related: [], missing: [], truncated: [], sourceHash: 'x'};
const reader = new Reader({}, config, pack);

let failed = 0;
for (const tool of reader.definitions()) {
  for (const [what, schema] of [['parameters', tool.parameters], ['output.schema', tool.output.schema]]) {
    try {
      assertSupportedJsonSchema(schema);
      console.log(`ok   ${tool.name}.${what}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${tool.name}.${what}: ${error.message}`);
    }
  }
  // The model receives `parameters` as-is, so it must be a JSON Schema object root.
  if (tool.parameters?.type !== 'object' || typeof tool.parameters.properties !== 'object') {
    failed++;
    console.log(`FAIL ${tool.name}.parameters is not an object-rooted JSON Schema`);
  }
  for (const [name, node] of Object.entries(tool.parameters?.properties ?? {})) {
    if ('required' in node) {
      failed++;
      console.log(`FAIL ${tool.name}.parameters.${name} still carries the DSL "required" flag`);
    }
  }
}
console.log(failed ? `${failed} problem(s)` : 'all tool definitions are valid');
process.exitCode = failed ? 1 : 0;
