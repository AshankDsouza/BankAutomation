# run the env file
set -a
source .env
set +a

# Default to headed mode so replay is visible unless explicitly overridden.
: "${HEADED:=1}"
export HEADED

npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "tell me my total bills"
