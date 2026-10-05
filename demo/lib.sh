# Shared helpers for demo/run and demo/real-agent. Source it; do not run it.
# Needs: CLAIMCHECK_URL, CLAIMCHECK_SECRET, and HERE (the demo folder) set by the caller.
: "${CLAIMCHECK_URL:?set CLAIMCHECK_URL, for example https://claimcheck.<your-subdomain>.workers.dev}"
: "${CLAIMCHECK_SECRET:?set CLAIMCHECK_SECRET to the value you stored with wrangler secret put}"
W=${CLAIMCHECK_URL%/}
START=${START:-$(date +%s)}

log() { printf '[%3ss] %s\n' "$(( $(date +%s) - START ))" "$*"; }

# Recording mode (demo/run --record): clear step labels and a 2 s pause between scenes.
RECORD=${CLAIMCHECK_RECORD:-0}
step() { # step <label>
  if (( RECORD )); then printf '\n==== %s ====\n' "$*"; else log "$*"; fi
}
scene_pause() { (( RECORD )) && sleep 2 || true; }

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
# json <expr>: read JSON on stdin and print j<expr>. An empty or non-JSON reply fails with a clear message
# (one run once failed here with only "Unexpected end of JSON input"; the cause was not found).
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!s.trim()){console.error("empty reply from the claimcheck API (needed "+process.argv[1]+")");process.exit(1)}let j;try{j=JSON.parse(s)}catch(e){console.error("reply from the claimcheck API is not JSON (needed "+process.argv[1]+"): "+s.slice(0,200));process.exit(1)}console.log(eval("j"+process.argv[1]))})' "$1"; }
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

push_retry() { # push_retry <agent> <token>: git push HEAD:main from the current repo, up to 3 tries (wait 2 s, 4 s)
  # Artifacts once refused 1 of 22 parallel pushes with "artifacts_git_receive_pack_service_unavailable".
  # Every retry is logged so it is visible in the run output.
  local agent=$1 token=$2 try err
  for try in 1 2 3; do
    if err=$(git_ -c http.extraHeader="Authorization: Bearer $token" push -q origin HEAD:main 2>&1); then
      (( try > 1 )) && log "agent $agent: push worked on try $try"
      return 0
    fi
    log "agent $agent: push try $try failed: $(grep -m1 -E 'remote:|fatal:|error:' <<<"$err" | sed -E 's#https://[^ ]*##')"
    (( try < 3 )) && sleep $(( try * 2 ))
  done
  return 1
}

settled() { # settled <task> <agent>: true when that agent has a final result
  [[ "$(state | node "$HERE/state.mjs" outcome "$1" "$2")" =~ ^(merged|conflict|error|rejected|needs_review)$ ]]
}
