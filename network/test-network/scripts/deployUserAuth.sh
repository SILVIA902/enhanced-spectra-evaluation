#!/bin/bash

source scripts/utils.sh
source scripts/ccutils.sh

CHANNEL_NAME="milkchannel"
CC_NAME="userauth"
CC_SRC_PATH="../chaincode/spectra/userauth"
CC_SRC_LANGUAGE="javascript"
CC_VERSION="1.0"
CC_SEQUENCE="1"
CC_INIT_FCN="NA"
CC_END_POLICY="NA"
CC_COLL_CONFIG="NA"
DELAY="3"
MAX_RETRY="5"
VERBOSE="false"

infoln "Deploying chaincode userauth on channel '${CHANNEL_NAME}'"

INIT_REQUIRED=""
if [ "$CC_INIT_FCN" != "NA" ]; then
  INIT_REQUIRED="--init-required"
fi

if [ "$CC_END_POLICY" != "NA" ]; then
  CC_END_POLICY="--signature-policy $CC_END_POLICY"
else
  CC_END_POLICY=""
fi

if [ "$CC_COLL_CONFIG" != "NA" ]; then
  CC_COLL_CONFIG="--collections-config $CC_COLL_CONFIG"
else
  CC_COLL_CONFIG=""
fi

jq --version > /dev/null 2>&1 || {
  errorln "jq is not installed (e.g. sudo apt install jq)"
  exit 1
}

./scripts/packageCC.sh $CC_NAME $CC_SRC_PATH $CC_SRC_LANGUAGE $CC_VERSION

PACKAGE_ID=$(peer lifecycle chaincode calculatepackageid ${CC_NAME}.tar.gz)

infoln "Installing userauth on peer0.farmers"
installChaincodeUserAuth 1
infoln "Installing userauth on peer0.producers"
installChaincodeUserAuth 2

resolveSequence

queryInstalledOnPeer 1
queryInstalledOnPeer 2

approveForMyOrg 1
approveForMyOrg 2

checkCommitReadiness 1 "\"FarmersMSP\": true" "\"ProducersMSP\": true"
checkCommitReadiness 2 "\"FarmersMSP\": true" "\"ProducersMSP\": true"

commitChaincodeDefinition 1 2

queryCommitted 1
queryCommitted 2

if [ "$CC_INIT_FCN" != "NA" ]; then
  chaincodeInvokeInit 1 2
else
  infoln "Init not required for userauth"
fi

successln "Chaincode userauth deployed"

exit 0
