#!/bin/zsh
# patch_402_message.sh
# Makes the unfunded-wallet error say what's actually wrong.
# Run from inside the oyapicks-mcp folder.

set -e

if [ ! -f "index.js" ]; then
  echo "ABORT: no index.js here. cd into oyapicks-mcp first."
  exit 1
fi

python3 << 'PYEOF'
import sys

old = '''        if (!res.ok) {
          const body = await res.text();
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `${route.tool} failed: HTTP ${res.status}. ${body.slice(0, 400)}`,
              },
            ],
          };
        }'''

new = '''        if (!res.ok) {
          const body = await res.text();

          // A 402 here means the payment did not go through. The single most
          // common cause by far is an empty wallet.
          if (res.status === 402) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `Payment for ${route.tool} (${route.price}) did not go through. ` +
                    `The most likely cause is that the wallet has no USDC on Base. ` +
                    `Check the balance of the address derived from OYAPICKS_WALLET_PRIVATE_KEY ` +
                    `and top it up with USDC on the Base network. ` +
                    `No ETH is needed; gas is sponsored.`,
                },
              ],
            };
          }

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `${route.tool} failed: HTTP ${res.status}. ${body.slice(0, 400)}`,
              },
            ],
          };
        }'''

src = open("index.js").read()

count = src.count(old)
if count != 1:
    print(f"ABORT: expected to find the error block exactly once, found {count}.")
    print("index.js may have been edited. Nothing changed.")
    sys.exit(1)

open("index.js", "w").write(src.replace(old, new))
print("Patched the 402 error message.")
PYEOF

echo ""
echo "Check it worked:"
echo "  grep -n 'no USDC on Base' index.js"
echo ""
