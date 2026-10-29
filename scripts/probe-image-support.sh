#!/bin/sh
# Whether the pinned runtime can carry a forum image to the model. Reads type declarations
# from the runtime image only; scripts/probe-secure-upload.mjs is the live forum check.
# The end-to-end proof is scripts/real-draft-test.sh on a post with an image, followed by
# scripts/inspect-tool-results.mjs to see the image block in the read_images result.
cd /home/yoimiya/workspace/shuiyuan-bot || exit 1
docker run --rm --entrypoint sh shuiyuan-pet:phase1 -c '
R=/opt/dsh/node_modules/@deepseek-ai
D=$R/dsh-base/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js
P=$R/dsh/node_modules/@deepseek-ai/dsh-attachment

echo "=== deepseek-flash input modalities ==="
grep -n -A4 "id: \"deepseek-flash\"" $D | grep -n "inputModalities"
echo
echo "=== where the adapter permits images ==="
grep -n "supports images only" $D
echo
echo "=== content blocks (ImageBlock is one) ==="
grep -n -A9 "interface ContentBlockMap" $R/dsh-llm/lib/types/types.d.ts
echo
echo "=== a tool render() returns ContentBlock[] ==="
grep -n "render(args: unknown, value: JsonValue): ContentBlock\[\]" $R/dsh-tools/lib/types/index.d.ts
echo
echo "=== the attachment service a plugin injects as \"attachments\" ==="
grep -n "super(ctx, \"attachments\")" $P/lib/index.js
grep -n "saveImage\|imageLimits" $P/lib/types/index.d.ts | head -4
echo
echo "=== loaded by dsh-base ==="
grep -n -A1 "id: attachment-local" $R/dsh-base/cordis.patch.yml
' 2>&1
