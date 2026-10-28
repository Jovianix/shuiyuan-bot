// Decodes the newest pet session log in the fixture container and reports what the model did.
import {execFileSync} from 'node:child_process';

const inner = `
const fs=require("fs"),z=require("zlib"),path=require("path");
const root="/data/dsh/sessions";
let newest=null,at=0;
for(const dir of fs.readdirSync(root)){
  const full=path.join(root,dir);
  for(const id of fs.readdirSync(full)){
    const f=path.join(full,id,"session.v4.jsonl.zstd");
    if(!fs.existsSync(f))continue;
    const m=fs.statSync(f).mtimeMs;
    if(m>at){at=m;newest=f;}
  }
}
const ev=fs.readFileSync(newest,"utf8").length;
const raw=z.zstdDecompressSync(fs.readFileSync(newest)).toString("utf8");
const events=raw.split("\\n").filter(Boolean).map(JSON.parse);
console.log("SESSION",newest);
const counts={};
for(const e of events)counts[e.type]=(counts[e.type]||0)+1;
console.log("EVENTS",JSON.stringify(counts));
for(const e of events){
  if(e.type==="step/start")console.log("step",e.data.step);
  if(e.type==="tool/call")console.log("CALL",e.data.name,e.data.arguments);
  if(e.type==="tool/result")console.log("RESULT",JSON.stringify(e.data.message).slice(0,200));
  if(e.type==="assistant/message")console.log("assistant:",e.data.message.content.map(b=>b.type+"("+String(b.text||b.name||"").slice(0,80)+")").join(" | "));
  if(e.type==="developer/message")console.log("DEVELOPER:",JSON.stringify(e.data).slice(0,400));
}
`;

try {
  const out = execFileSync('docker', ['exec', 'pet-fixture-test', 'node', '-e', inner], {encoding: 'utf8'});
  console.log(out);
} catch (error) {
  console.error('failed:', error.message);
  if (error.stdout) console.error(error.stdout);
  if (error.stderr) console.error(error.stderr);
  process.exitCode = 1;
}
