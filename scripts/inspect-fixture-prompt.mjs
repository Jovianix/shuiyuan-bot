// Prints the exact rendered system prompt from the newest fixture session and its hash, so
// it can be compared with config/soul.md byte for byte.
import {execFileSync} from 'node:child_process';

const inner = `
const fs=require("fs"),z=require("zlib"),path=require("path"),crypto=require("crypto");
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
const events=z.zstdDecompressSync(fs.readFileSync(newest)).toString("utf8").split("\\n").filter(Boolean).map(JSON.parse);
for(const e of events){
  if(e.type!=="system/message")continue;
  const blocks=e.data.message.content;
  const text=blocks.filter(b=>b.type==="text").map(b=>b.text||"").join("");
  console.log("BLOCKS",blocks.map(b=>b.type).join(","));
  console.log("SHA",crypto.createHash("sha256").update(text).digest("hex"));
  console.log("LEN",text.length);
  console.log("---BEGIN---");
  console.log(JSON.stringify(text.slice(0,120)));
  console.log("---END-TAIL---");
  console.log(JSON.stringify(text.slice(-120)));
}
`;

console.log(execFileSync('docker', ['exec', 'pet-fixture-test', 'node', '-e', inner], {encoding: 'utf8'}));
