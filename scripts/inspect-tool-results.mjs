// Prints every tool/result of the newest session in a container, in full, plus the
// content block types each result carried. Usage: node scripts/inspect-tool-results.mjs [container]
import {execFileSync} from 'node:child_process';

const container = process.argv[2] ?? 'pet-realdraft-test';
const inner = `
const fs=require("fs"),z=require("zlib"),path=require("path");
const root="/data/dsh/sessions";
let newest=null,at=0;
for(const dir of fs.readdirSync(root)){
  for(const id of fs.readdirSync(path.join(root,dir))){
    const f=path.join(root,dir,id,"session.v4.jsonl.zstd");
    if(!fs.existsSync(f))continue;
    const m=fs.statSync(f).mtimeMs;
    if(m>at){at=m;newest=f;}
  }
}
const events=z.zstdDecompressSync(fs.readFileSync(newest)).toString("utf8").split("\\n").filter(Boolean).map(JSON.parse);
for(const e of events){
  if(e.type==="user/message"&&e.data.source?.kind==="user"){
    console.log("PROMPT");
    for(const b of e.data.content??[])if(b.type==="text")console.log(b.text.split("\\n").map(l=>"  "+l).join("\\n"));
  }
  if(e.type==="assistant/message"){
    const blocks=e.data.message?.content??[];
    const text=blocks.filter(b=>b.type==="text").map(b=>b.text).join("");
    if(text)console.log("ANSWER\\n"+text.split("\\n").map(l=>"  "+l).join("\\n"));
  }
  if(e.type==="tool/call")console.log("CALL",e.data.name,e.data.arguments);
  if(e.type==="tool/result"){
    const blocks=e.data.message?.content??[];
    console.log("RESULT types=",blocks.map(b=>b.type).join(","),"error=",JSON.stringify(e.data.error??null));
    for(const b of blocks){
      if(b.type==="text")console.log("  text:",b.text.slice(0,600));
      if(b.type==="image")console.log("  image:",JSON.stringify(b.attachment));
    }
  }
}`;
process.stdout.write(execFileSync('docker', ['exec', container, 'node', '-e', inner], {encoding: 'utf8'}));
