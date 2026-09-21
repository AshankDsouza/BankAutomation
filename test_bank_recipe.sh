# run the env file
set -a
source .env
set +a

# Default to headed mode so replay is visible unless explicitly overridden.
: "${HEADED:=1}"
export HEADED

# npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "add new recipient named Lord Voldemort"
npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "tell me my total balance"

# npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "tell me my largest purchase"
# # npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "add adam, cane and abel as my recipients with correct information"
# npx tsx Discovery.ts "https://www.ngpf.org/bank-sim/" "tell me my smallest purchase"
