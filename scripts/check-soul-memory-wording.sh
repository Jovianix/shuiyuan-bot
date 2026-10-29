#!/bin/sh
# Runs the fixture thread once and prints the answer, to check whether the pet still
# volunteers "I have no long-term memory" after that sentence left the card.
set -e
cd /home/yoimiya/workspace/shuiyuan-bot || exit 1
T=/tmp/claude-1000/soulcheck
mkdir -p "$T"
printf 'bare' > "$T/scenario"
cat > "$T/pet.json" <<'JSON'
{
  "site": "https://shuiyuan.sjtu.edu.cn",
  "owner": "Tomorin", "ownerId": 29880,
  "petId": "fish", "petName": "大肥鱼",
  "mode": "draft", "scan": false,
  "provider": "deepseek-official", "model": "deepseek-flash",
  "mcpScript": "/repo/scripts/fixture-thread-mcp.mjs",
  "profilePath": "/run/secrets/discourse-profile.json"
}
JSON
printf '{"site": "https://shuiyuan.sjtu.edu.cn"}' > "$T/fake-profile.json"

docker rm -f pet-soulcheck >/dev/null 2>&1 || true
docker run -d --name pet-soulcheck --init \
  -v "$T/scenario:/data/scenario:ro" \
  -v "$T/pet.json:/app/config/pet.json:ro" \
  -v "$PWD/scripts/fixture-thread-mcp.mjs:/repo/scripts/fixture-thread-mcp.mjs:ro" \
  -v "$T/fake-profile.json:/run/secrets/discourse-profile.json:ro" \
  -v "$PWD/secrets/deepseek-api-key:/run/secrets/deepseek-api-key:ro" \
  shuiyuan-pet:phase1 >/dev/null
sleep 16
docker exec pet-soulcheck node /app/scripts/pet-control.mjs draft 90031 >/dev/null 2>&1 || true
sleep 50
docker exec pet-soulcheck node /app/scripts/pet-control.mjs task 1 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
 let t; try{t=JSON.parse(s);}catch{console.log("(no task)");return;}
 const text=(t.answer?.text??"");
 console.log("soulHash:",t.answer?.soulHash??"(none)");
 console.log("mentions memory-ish wording:",/记忆|不记得|没记住|记不住|失忆/.test(text));
 console.log("--- answer ---");
 console.log(text.trim());
});'
docker rm -f pet-soulcheck >/dev/null 2>&1 || true
