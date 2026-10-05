# Shared helpers for demo/run and demo/real-agent. Source it; do not run it.
# Needs: CLAIMCHECK_URL, CLAIMCHECK_SECRET, and HERE (the demo folder) set by the caller.
: "${CLAIMCHECK_URL:?set CLAIMCHECK_URL, for example https://claimcheck.<your-subdomain>.workers.dev}"
: "${CLAIMCHECK_SECRET:?set CLAIMCHECK_SECRET to the value you stored with wrangler secret put}"
W=${CLAIMCHECK_URL%/}
START=${START:-$(date +%s)}

log() { printf '[%3ss] %s\n' "$(( $(date +%s) - START ))" "$*"; }

api() { # POST to a protected route; on HTTP errors print the JSON error and fail
  local out code
  out=$(curl -sS -w '\n%{http_code}' -H "x-claimcheck-secret: $CLAIMCHECK_SECRET" -H 'content-type: application/json' "$@")
  code=${out##*$'\n'}; out=${out%$'\n'*}
  if (( code >= 400 )); then
    echo "HTTP $code from $*: $out" >&2
    (( code == 401 )) && echo "Hint: CLAIMCHECK_SECRET must match the Worker secret. A new secret can take ~30 s to apply after 'wrangler secret put'." >&2
    return 1
  fi
  printf '%s' "$out"
}

state() { curl -sfS "$W/api/state"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval("j"+process.argv[1]))})' "$1"; }
git_() { git -c core.autocrlf=false -c init.defaultBranch=main "$@"; }

# replace <file> <old text> <new text>: exact text edit (portable; BSD sed -i differs from GNU sed -i)
replace() { node -e 'const fs=require("fs");const [f,a,b]=process.argv.slice(1);const s=fs.readFileSync(f,"utf8");if(!s.includes(a))throw new Error("text not found in "+f+": "+a);fs.writeFileSync(f,s.split(a).join(b))' "$@"; }

wait_for() { # wait_for <seconds> <command...>: poll every 2 s until the command succeeds; 1 on timeout
  local limit=$1; shift
  local deadline=$(( $(date +%s) + limit ))
  until "$@"; do
    (( $(date +%s) > deadline )) && return 1
    sleep 2
  done
}

settled() { # settled <task> <agent>: true when that agent has a final result
  [[ "$(state | node "$HERE/state.mjs" outcome "$1" "$2")" =~ ^(merged|conflict|error|rejected|needs_review)$ ]]
}
