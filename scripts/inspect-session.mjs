// Decodes one pet session log inside a container and reports what the model did:
// rendered system prompt hash, steps, tool calls and the final text.
// Usage: node scripts/inspect-session.mjs [container] [sessionIdPrefix]
import {execFileSync} from 'node:child_process';

const container = process.argv[2] ?? 'shuiyuan-bot-pet-1';
const wanted = process.argv[3] ?? '';

const inner = `
const fs=require("fs"),z=require("zlib"),path=require("path"),crypto=require("crypto");
const wanted=${JSON.stringify(wanted)};
const root="/data/dsh/sessions";
let newest=null,at=0;
for(const dir of fs.readdirSync(root)){
  const full=path.join(root,dir);
  for(const id of fs.readdirSync(full)){
    if(wanted && !id.startsWith(wanted))continue;
    const f=path.join(full,id,"session.v4.jsonl.zstd");
    if(!fs.existsSync(f))continue;
    const m=fs.statSync(f).mtimeMs;
    if(m>at){at=m;newest=f;}
  }
}
if(!newest){console.log("no session matched");process.exit(0);}
const events=z.zstdDecompressSync(fs.readFileSync(newest)).toString("utf8").split("\\n").filter(Boolean).map(JSON.parse);
console.log("SESSION",newest);
for(const e of events){
  if(e.type==="system/message"){
    const text=e.data.message.content.filter(b=>b.type==="text").map(b=>b.text||"").join("");
    console.log("SYSTEM",crypto.createHash("sha256").update(text).digest("hex"),"len",text.length);
  }
  if(e.type==="step/start")console.log("STEP",e.data.step);
  if(e.type==="tool/call")console.log("CALL",e.data.name,e.data.arguments);
  if(e.type==="tool/result"){
    const t=(e.data.message.content||[]).map(b=>b.text||"").join("");
    console.log("RESULT",e.data.error?JSON.stringify(e.data.error):"ok","bytes",t.length);
  }
  if(e.type==="assistant/message"){
    const blocks=e.data.message.content;
    console.log("ASSISTANT",blocks.map(b=>b.type).join(","));
  }
  if(e.type==="turn/end")console.log("TURN_END",JSON.stringify(e.data.reason));
}
`;

console.log(execFileSync('docker', ['exec', container, 'node', '-e', inner], {encoding: 'utf8'}));
