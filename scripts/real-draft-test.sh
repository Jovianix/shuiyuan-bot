#!/bin/sh
# Real-forum draft test using an isolated data volume.
#
# It reads the real forum through the real MCP child, calls the real model, and stops at
# draft_ready: config/pet.json ships "mode": "draft", so the delivery path never runs.
# A fresh volume is used so the operator's own /data (and its Soul card) is not touched;
# the image soul is seeded into this throwaway volume instead.
set -e
cd /home/yoimiya/workspace/shuiyuan-bot || exit 1

POST_ID=${1:?usage: real-draft-test.sh POST_ID}
NAME=pet-realdraft-test

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$NAME-data" >/dev/null 2>&1 || true

docker run -d --name "$NAME" --init \
  -v "$NAME-data:/data" \
  -v "$PWD/config/pet.json:/app/config/pet.json:ro" \
  -v "$PWD/secrets/deepseek-api-key:/run/secrets/deepseek-api-key:ro" \
  -v "$PWD/secrets/discourse-profile.json:/run/secrets/discourse-profile.json:ro" \
  shuiyuan-pet:phase1 >/dev/null

echo "waiting for startup..."
sleep 20
docker logs "$NAME" 2>&1 | grep -iE "soul|ready" | head -3

docker exec "$NAME" node /app/scripts/pet-control.mjs draft "$POST_ID" 2>&1 | tail -3
echo "generating..."
sleep 55

docker exec "$NAME" node /app/scripts/pet-control.mjs task 1 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
 let t; try{t=JSON.parse(s);}catch{console.log("(no task returned)");return;}
 console.log("state:",t.state);
 console.log("soulHash:",t.answer?.soulHash??"(none)");
 console.log("source floor:",t.context?.source?.post_number,"| related:",(t.context?.related??[]).map(p=>p.post_number).join(",")||"(none)");
 console.log("--- answer ---");
 console.log((t.answer?.text??"").trim());
 if(t.error)console.log("error:",t.error);
});'

echo "--- tool calls ---"
node scripts/inspect-session.mjs "$NAME" 2>&1 | grep -E "SYSTEM|CALL|RESULT|STEP" | sed 's/^/  /'
