#!/bin/bash
source scripts/utils.sh
source scripts/ccutils.sh

CHANNEL_NAME=${1:-"milkchannel"}
CC_NAME=${2}
CC_SRC_PATH=${3}
CC_SRC_LANGUAGE=${4}
CC_VERSION=${5:-"1.0"}
CC_SEQUENCE=${6:-"auto"}
CC_INIT_FCN=${7:-"InitLedger"}
CC_END_POLICY=${8:-"AND('FarmersMSP.member','ProducersMSP.member')"}
CC_COLL_CONFIG=${9:-"NA"}
DELAY=${10:-"3"}
MAX_RETRY=${11:-"5"}
VERBOSE=${12:-"false"}

println "Executing with the following parameters:"
println "- CHANNEL_NAME: ${C_GREEN}${CHANNEL_NAME}${C_RESET}"
println "- CC_NAME: ${C_GREEN}${CC_NAME}${C_RESET}"
println "- CC_SRC_PATH: ${C_GREEN}${CC_SRC_PATH}${C_RESET}"
println "- CC_SRC_LANGUAGE: ${C_GREEN}${CC_SRC_LANGUAGE}${C_RESET}"
println "- CC_VERSION: ${C_GREEN}${CC_VERSION}${C_RESET}"
println "- CC_SEQUENCE: ${C_GREEN}${CC_SEQUENCE}${C_RESET}"
println "- CC_INIT_FCN: ${C_GREEN}${CC_INIT_FCN}${C_RESET}"
println "- CC_END_POLICY: ${C_GREEN}${CC_END_POLICY}${C_RESET}"
println "- CC_COLL_CONFIG: ${C_GREEN}${CC_COLL_CONFIG}${C_RESET}"
println "- DELAY: ${C_GREEN}${DELAY}${C_RESET}"
println "- MAX_RETRY: ${C_GREEN}${MAX_RETRY}${C_RESET}"
println "- VERBOSE: ${C_GREEN}${VERBOSE}${C_RESET}"

INIT_REQUIRED=""
if [ "$CC_INIT_FCN" != "NA" ]; then
  INIT_REQUIRED="--init-required"
fi

if [ "$CC_END_POLICY" = "NA" ]; then
  CC_END_POLICY=""
else
  CC_END_POLICY="--signature-policy $CC_END_POLICY"
fi

# --- PDC only: validate and prepare collections-config flag ---
PDC_ENABLED="false"
CC_COLL_PATH="$CC_COLL_CONFIG"
if [ "$CC_COLL_CONFIG" = "NA" ]; then
  CC_COLL_CONFIG=""
else
  if [ ! -f "$CC_COLL_CONFIG" ]; then
    errorln "Collections config file not found: $CC_COLL_CONFIG"
    exit 1
  fi
  CC_COLL_CONFIG="--collections-config $CC_COLL_PATH"
  PDC_ENABLED="true"
  infoln "Using collections-config: $CC_COLL_PATH"
fi
export CC_COLL_CONFIG
export PDC_ENABLED
export CC_COLL_PATH
# -------------------------------------------------------------

FABRIC_CFG_PATH=$PWD/../config/

. scripts/envVar.sh
. scripts/ccutils.sh

function checkPrereqs() {
  jq --version > /dev/null 2>&1
  if [[ $? -ne 0 ]]; then
    errorln "'jq' tool not found. Please install prerequisites as described in the Fabric documentation."
    exit 1
  fi
}

checkPrereqs

./scripts/packageCC.sh $CC_NAME $CC_SRC_PATH $CC_SRC_LANGUAGE $CC_VERSION

PACKAGE_ID=$(peer lifecycle chaincode calculatepackageid ${CC_NAME}.tar.gz)

infoln "Installing chaincode on peer0.farmers..."
installChaincode 1
infoln "Installing chaincode on peer0.producers..."
installChaincode 2

resolveSequence

queryInstalledOnPeer 1
queryInstalledOnPeer 2

approveForMyOrg 1

checkCommitReadiness 1 "\"FarmersMSP\": true" "\"ProducersMSP\": false"
checkCommitReadiness 2 "\"FarmersMSP\": true" "\"ProducersMSP\": false"

approveForMyOrg 2

checkCommitReadiness 1 "\"FarmersMSP\": true" "\"ProducersMSP\": true"
checkCommitReadiness 2 "\"FarmersMSP\": true" "\"ProducersMSP\": true"

commitChaincodeDefinition 1 2

queryCommitted 1
queryCommitted 2

# --- PDC only: assert that the committed definition includes our collection ---
if [ "$PDC_ENABLED" = "true" ]; then
  infoln "Verifying that committed definition includes collection 'uidPdc'..."
  COMMIT_JSON=$(peer lifecycle chaincode querycommitted \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --output json)

  println "$COMMIT_JSON"

  # Deve esistere almeno una collection in collections.config
  echo "$COMMIT_JSON" | jq -e '.collections and .collections.config and (.collections.config | length > 0)' >/dev/null || {
    errorln "Committed JSON has no collections.config entries, but CC_COLL_CONFIG was provided."
    exit 1
  }

  # Deve esserci la collection con nome 'uidPdc'
  echo "$COMMIT_JSON" | jq -e \
    '.collections.config[].Payload.StaticCollectionConfig.name | select(. == "uidPdc")' >/dev/null || {
    errorln "Collection 'uidPdc' not found in committed JSON definition. Check CC_COLL_CONFIG: $CC_COLL_PATH"
    exit 1
  }

  successln "Collection 'uidPdc' detected in committed JSON definition."
fi

if [ "$CC_INIT_FCN" != "NA" ]; then
  infoln "Invoking Init function: $CC_INIT_FCN"
  chaincodeInvokeInit 1 2
else
  infoln "Chaincode does not require initialization"
fi

successln "Chaincode '${CC_NAME}' has been deployed successfully on channel '${CHANNEL_NAME}'"
exit 0
