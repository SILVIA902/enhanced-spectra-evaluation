#!/bin/bash

function successln() { echo -e "\033[1;32m$1\033[0m"; }
function infoln() { echo -e "\033[1;34m$1\033[0m"; }
function errorln() { echo -e "\033[1;31m$1\033[0m"; }
function fatalln() { errorln "$1"; exit 1; }
function verifyResult() { if [ $1 -ne 0 ]; then fatalln "$2"; fi; }

. scripts/envVar.sh

installChaincode() {
  ORG=$1
  setGlobals $ORG

  infoln "Installing chaincode on ORG $ORG..."

  CC_PACKAGE="certificate.tar.gz"
  CC_LABEL="certificate_1.0"

  if [ "$ORG" -eq 1 ]; then
    export CORE_PEER_ADDRESS=localhost:7051
    export CORE_PEER_LOCALMSPID=FarmersMSP
  else
    export CORE_PEER_ADDRESS=localhost:9051
    export CORE_PEER_LOCALMSPID=ProducersMSP
  fi

  [ ! -f "$CC_PACKAGE" ] && fatalln "Package $CC_PACKAGE does not exist!"

  peer lifecycle chaincode install "$CC_PACKAGE"
  verifyResult $? "Chaincode installation failed on ORG $ORG"

  peer lifecycle chaincode queryinstalled | tee log.txt
  grep "$CC_LABEL" log.txt || fatalln "Chaincode $CC_LABEL is not installed"
  successln "Chaincode $CC_LABEL installed on ORG $ORG"
}

approveForMyOrg() {
  ORG=$1
  setGlobals $ORG

  echo "Debug: Approving chaincode per ORG $ORG con PACKAGE_ID: $PACKAGE_ID"

  peer lifecycle chaincode approveformyorg -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com --tls \
    --cafile "$ORDERER_CA" \
    --channelID "$CHANNEL_NAME" --name "$CC_NAME" --version "$CC_VERSION" \
    --package-id "$PACKAGE_ID" --sequence "$CC_SEQUENCE" \
    $CC_COLL_CONFIG

  verifyResult $? "Errore: approvazione del chaincode per ORG ${ORG} fallita!"
  successln "Chaincode definition approved on ORG${ORG} on channel '$CHANNEL_NAME'"
}

checkCommitReadiness() {
  ORG=$1
  setGlobals $ORG

  if [ "$ORG" -eq 1 ]; then
    export CORE_PEER_ADDRESS=localhost:7051
    export CORE_PEER_LOCALMSPID=FarmersMSP
  else
    export CORE_PEER_ADDRESS=localhost:9051
    export CORE_PEER_LOCALMSPID=ProducersMSP
  fi

  echo "Checking commit readiness for ORG ${ORG}..."

  peer lifecycle chaincode checkcommitreadiness \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --version "$CC_VERSION" \
    --sequence "$CC_SEQUENCE" \
    $CC_COLL_CONFIG \
    --output json | jq .

  if [ $? -ne 0 ]; then
    echo "Errore: commit readiness check fallito per ORG ${ORG}!"
    exit 1
  fi

  successln "Commit readiness verificato con successo per ORG ${ORG}!"
}

commitChaincodeDefinition() {
  infoln "Commit del chaincode '${CC_NAME}' sulla rete (channel: ${CHANNEL_NAME})..."

  setGlobals 1

  peer lifecycle chaincode commit -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" \
    --channelID "$CHANNEL_NAME" \
    --name "$CC_NAME" \
    --version "$CC_VERSION" \
    --sequence "$CC_SEQUENCE" \
    $CC_COLL_CONFIG \
    --peerAddresses localhost:7051 \
    --tlsRootCertFiles "$PEER0_ORG1_CA" \
    --peerAddresses localhost:9051 \
    --tlsRootCertFiles "$PEER0_ORG2_CA" >&log.txt

  res=$?
  cat log.txt

  if [ $res -ne 0 ]; then
    errorln "Commit del chaincode fallito!"
    fatalln "See the log for details."
  fi

  successln "Chaincode definition '${CC_NAME}' committed on channel '${CHANNEL_NAME}'"
}

queryCommitted() {
  ORG=$1
  setGlobals $ORG

  infoln "Querying on peer0.org${ORG} on channel '$CHANNEL_NAME'..."

  local rc=1
  local COUNTER=1

  while [ $rc -ne 0 ] && [ $COUNTER -lt $MAX_RETRY ]; do
    sleep $((DELAY * COUNTER))
    infoln "Attempt $COUNTER to query the committed chaincode on peer0.org${ORG}..."

    set -x
    peer lifecycle chaincode querycommitted \
      --channelID "$CHANNEL_NAME" \
      --name "$CC_NAME" \
      --peerAddresses "$CORE_PEER_ADDRESS" \
      --tlsRootCertFiles "$CORE_PEER_TLS_ROOTCERT_FILE" \
      --output json > log.txt 2>&1
    res=$?
    { set +x; } 2>/dev/null

    if [ $res -eq 0 ]; then
      VERSION=$(jq -r '.version' log.txt)
      SEQUENCE=$(jq -r '.sequence' log.txt)

      echo "DEBUG: returned version = $VERSION, returned sequence = $SEQUENCE"
      echo "DEBUG: expected version = $CC_VERSION, expected sequence = $CC_SEQUENCE"

      if [ "$VERSION" == "$CC_VERSION" ]; then
        if [ "$CC_SEQUENCE" == "auto" ]; then
          CC_SEQUENCE=$SEQUENCE
        fi

        if [ "$SEQUENCE" == "$CC_SEQUENCE" ]; then
          rc=0
          break
        fi
      fi
    fi

    COUNTER=$((COUNTER + 1))
  done

  cat log.txt

  if [ $rc -eq 0 ]; then
    successln "Query chaincode definition successful on peer0.org${ORG} on channel '$CHANNEL_NAME'"
  else
    fatalln "After $MAX_RETRY attempts, chaincode '$CC_NAME' is not committed on peer0.org${ORG}!"
  fi
}

function chaincodeInvokeInit() {
  parsePeerConnectionParameters "$@"
  res=$?
  verifyResult $res "Invoke failed on '$CHANNEL_NAME': odd number of peer/org arguments"

  local rc=1
  local COUNTER=1
  local fcn_call="{\"function\":\"${CC_INIT_FCN}\",\"Args\":[]}"

  infoln "Invoking the init function of chaincode '${CC_NAME}' on channel '${CHANNEL_NAME}'..."

  while [ $rc -ne 0 ] && [ $COUNTER -lt $MAX_RETRY ]; do
    sleep $DELAY
    infoln "Attempt $COUNTER of init invoke..."

    set -x
    peer chaincode invoke \
      -o localhost:7050 \
      --ordererTLSHostnameOverride orderer.example.com \
      --tls \
      --cafile "$ORDERER_CA" \
      -C "$CHANNEL_NAME" \
      -n "${CC_NAME}" \
      "${PEER_CONN_PARMS[@]}" \
      --isInit \
      -c "$fcn_call" >&log.txt
    res=$?
    { set +x; } 2>/dev/null

    rc=$res
    COUNTER=$((COUNTER + 1))
  done

  cat log.txt
  verifyResult $res "Init invoke failed on channel '${CHANNEL_NAME}'"
  successln "Init invoke successful on channel '${CHANNEL_NAME}'"
}

function chaincodeQuery() {
  ORG=$1
  CHANNEL=$2
  CC_NAME=$3
  CC_QUERY_CONSTRUCTOR=$4

  setGlobals $ORG

  if [ "$ORG" -eq 1 ]; then
    export CORE_PEER_ADDRESS=localhost:7051
    export CORE_PEER_LOCALMSPID=FarmersMSP
    export CORE_PEER_TLS_ROOTCERT_FILE=$PEER0_ORG1_CA
  elif [ "$ORG" -eq 2 ]; then
    export CORE_PEER_ADDRESS=localhost:9051
    export CORE_PEER_LOCALMSPID=ProducersMSP
    export CORE_PEER_TLS_ROOTCERT_FILE=$PEER0_ORG2_CA
  else
    fatalln "Unknown ORG: $ORG"
  fi

  infoln "Querying chaincode '${CC_NAME}' on peer0.org${ORG}, channel '${CHANNEL}'..."

  local rc=1
  local COUNTER=1

  while [ $rc -ne 0 ] && [ $COUNTER -lt $MAX_RETRY ]; do
    sleep $DELAY
    infoln "Attempt $COUNTER of query on peer0.org${ORG}..."

    set -x
    peer chaincode query \
      -C "$CHANNEL" \
      -n "$CC_NAME" \
      -c "$CC_QUERY_CONSTRUCTOR" \
      --tls --cafile "$CORE_PEER_TLS_ROOTCERT_FILE" >&log.txt
    res=$?
    { set +x; } 2>/dev/null

    rc=$res
    COUNTER=$((COUNTER + 1))
  done

  cat log.txt
  if [ $rc -eq 0 ]; then
    successln "Query successful on peer0.org${ORG}, channel '${CHANNEL}'"
  else
    fatalln "After $MAX_RETRY attempts, query failed on peer0.org${ORG}!"
  fi
}

function resolveSequence() {
  if [[ "${CC_SEQUENCE}" != "auto" ]]; then
    return 0
  fi

  infoln "Resolving the sequence number of chaincode '${CC_NAME}' on channel '${CHANNEL_NAME}'..."

  local rc=1
  local COUNTER=1

  setGlobals 1
  export CORE_PEER_ADDRESS=localhost:7051
  export CORE_PEER_LOCALMSPID=FarmersMSP

  while [ $rc -ne 0 -a $COUNTER -lt $MAX_RETRY ]; do
    set -x
    COMMITTED_CC_SEQUENCE=$(peer lifecycle chaincode querycommitted \
      --channelID $CHANNEL_NAME \
      --name ${CC_NAME} | sed -n "/Version:/{s/.*Sequence: //; s/, Endorsement Plugin:.*$//; p;}")
    res=$?
    { set +x; } 2>/dev/null
    let rc=$res
    COUNTER=$(expr $COUNTER + 1)
  done

  if [ -z "$COMMITTED_CC_SEQUENCE" ]; then
    infoln "Nessuna versione committata trovata: impostazione sequence a 1"
    CC_SEQUENCE=1
    return 0
  fi

  rc=1
  COUNTER=1

  while [ $rc -ne 0 -a $COUNTER -lt $MAX_RETRY ]; do
    set -x
    APPROVED_CC_SEQUENCE=$(peer lifecycle chaincode queryapproved \
      --channelID $CHANNEL_NAME \
      --name ${CC_NAME} | sed -n "/sequence:/{s/^sequence: //; s/, version:.*$//; p;}")
    res=$?
    { set +x; } 2>/dev/null
    let rc=$res
    COUNTER=$(expr $COUNTER + 1)
  done

  if [ "$COMMITTED_CC_SEQUENCE" == "$APPROVED_CC_SEQUENCE" ]; then
    CC_SEQUENCE=$((COMMITTED_CC_SEQUENCE + 1))
    infoln "Sequence corrente approvata e committata ($COMMITTED_CC_SEQUENCE). Incremento a $CC_SEQUENCE"
  else
    CC_SEQUENCE=$APPROVED_CC_SEQUENCE
    infoln "Sequence approvata ($APPROVED_CC_SEQUENCE) diversa da quella committata ($COMMITTED_CC_SEQUENCE). Uso quella approvata."
  fi
}

queryInstalledOnPeer() {
  local rc=1
  local COUNTER=1
  while [ $rc -ne 0 -a $COUNTER -lt $MAX_RETRY ]; do
    peer lifecycle chaincode queryinstalled >&log.txt
    res=$?
    let rc=$res
    COUNTER=$(expr $COUNTER + 1)
  done
  cat log.txt
}

function queryInstalledOnPeer() {
  ORG=$1
  setGlobals $ORG

  if [ "$ORG" -eq 1 ]; then
    export CORE_PEER_ADDRESS=localhost:7051
    export CORE_PEER_LOCALMSPID=FarmersMSP
  elif [ "$ORG" -eq 2 ]; then
    export CORE_PEER_ADDRESS=localhost:9051
    export CORE_PEER_LOCALMSPID=ProducersMSP
  else
    fatalln "Unknown ORG: $ORG"
  fi

  infoln "Querying installed chaincodes on peer0.org${ORG} (${CORE_PEER_ADDRESS})..."

  local rc=1
  local COUNTER=1

  while [ $rc -ne 0 -a $COUNTER -lt $MAX_RETRY ]; do
    sleep $DELAY
    infoln "Attempt $COUNTER: queryinstalled on peer0.org${ORG}..."
    set -x
    peer lifecycle chaincode queryinstalled >&log.txt
    res=$?
    { set +x; } 2>/dev/null
    let rc=$res
    COUNTER=$(expr $COUNTER + 1)
  done

  cat log.txt

  if [ $rc -ne 0 ]; then
    fatalln "Unable to query installed chaincodes on peer0.org${ORG} after $MAX_RETRY attempts."
  fi

  successln "Installed chaincodes queried on peer0.org${ORG}"
}

function queryCommittedOnChannel() {
  ORG=$1
  CHANNEL=$2
  CC_NAME=$3

  setGlobals $ORG

  if [ "$ORG" -eq 1 ]; then
    export CORE_PEER_ADDRESS=localhost:7051
    export CORE_PEER_LOCALMSPID=FarmersMSP
  elif [ "$ORG" -eq 2 ]; then
    export CORE_PEER_ADDRESS=localhost:9051
    export CORE_PEER_LOCALMSPID=ProducersMSP
  else
    fatalln "Unknown ORG: $ORG"
  fi

  infoln "Querying committed chaincode '$CC_NAME' on channel '$CHANNEL' from peer0.org${ORG}..."

  local rc=1
  local COUNTER=1

  while [ $rc -ne 0 ] && [ $COUNTER -lt $MAX_RETRY ]; do
    peer lifecycle chaincode querycommitted --channelID "$CHANNEL" --name "$CC_NAME" --output json > "/tmp/querycommitted_${CHANNEL}_org${ORG}.json"
    res=$?
    let rc=$res
    COUNTER=$(expr $COUNTER + 1)
    sleep $DELAY
    infoln "Attempt $COUNTER of querycommitted..."
  done

  if [ $rc -ne 0 ]; then
    fatalln "Unable to query committed chaincode '$CC_NAME' on channel '$CHANNEL' for org${ORG} after $MAX_RETRY attempts!"
  fi

  COMMITTED_CC_SEQUENCE=$(jq -r '.sequence' "/tmp/querycommitted_${CHANNEL}_org${ORG}.json")
  if [ -z "$COMMITTED_CC_SEQUENCE" ] || [ "$COMMITTED_CC_SEQUENCE" == "null" ]; then
    fatalln "No committed chaincode '$CC_NAME' found on channel '$CHANNEL' for org${ORG}!"
  fi

  successln "Chaincode '$CC_NAME' committed on '$CHANNEL' (org${ORG}), sequence: $COMMITTED_CC_SEQUENCE"
  export COMMITTED_CC_SEQUENCE
}

function chaincodeInvoke() {
  ORG=$1
  CHANNEL=$2
  CC_NAME=$3
  CC_INVOKE_CONSTRUCTOR=$4

  setGlobals $ORG

  if [ "$ORG" -eq 1 ]; then
    export CORE_PEER_ADDRESS=localhost:7051
    export CORE_PEER_LOCALMSPID=FarmersMSP
    export PEER_TLS_ROOTCERT=${TEST_NETWORK_HOME}/organizations/peerOrganizations/farmers.example.com/tlsca/tlsca.farmers.example.com-cert.pem
  elif [ "$ORG" -eq 2 ]; then
    export CORE_PEER_ADDRESS=localhost:9051
    export CORE_PEER_LOCALMSPID=ProducersMSP
    export PEER_TLS_ROOTCERT=${TEST_NETWORK_HOME}/organizations/peerOrganizations/producers.example.com/tlsca/tlsca.producers.example.com-cert.pem
  else
    fatalln "Unknown ORG: $ORG"
  fi

  infoln "Invoking chaincode '${CC_NAME}' on peer0.org${ORG}, channel '${CHANNEL}'..."

  local rc=1
  local COUNTER=1

  while [ $rc -ne 0 -a $COUNTER -lt $MAX_RETRY ]; do
    sleep $DELAY
    infoln "Attempt $COUNTER of invoke on peer0.org${ORG}..."

    set -x
    peer chaincode invoke -o localhost:7050 \
      --ordererTLSHostnameOverride orderer.example.com \
      --tls --cafile "$ORDERER_CA" \
      -C "$CHANNEL" -n "$CC_NAME" -c "$CC_INVOKE_CONSTRUCTOR" \
      --peerAddresses "$CORE_PEER_ADDRESS" \
      --tlsRootCertFiles "$PEER_TLS_ROOTCERT" >&log.txt
    res=$?
    { set +x; } 2>/dev/null
    let rc=$res
    COUNTER=$(expr $COUNTER + 1)
  done

  cat log.txt
  if [ $rc -eq 0 ]; then
    successln "Invoke successful on peer0.org${ORG}, channel '${CHANNEL}'"
  else
    fatalln "After $MAX_RETRY attempts, invoke failed on peer0.org${ORG}!"
  fi
}

function chaincodeQuery() {
  ORG=$1
  CHANNEL=$2
  CC_NAME=$3
  CC_QUERY_CONSTRUCTOR=$4

  setGlobals $ORG

  if [ "$ORG" -eq 1 ]; then
    export CORE_PEER_ADDRESS=localhost:7051
    export CORE_PEER_LOCALMSPID=FarmersMSP
    export PEER_TLS_ROOTCERT=${TEST_NETWORK_HOME}/organizations/peerOrganizations/farmers.example.com/tlsca/tlsca.farmers.example.com-cert.pem
  elif [ "$ORG" -eq 2 ]; then
    export CORE_PEER_ADDRESS=localhost:9051
    export CORE_PEER_LOCALMSPID=ProducersMSP
    export PEER_TLS_ROOTCERT=${TEST_NETWORK_HOME}/organizations/peerOrganizations/producers.example.com/tlsca/tlsca.producers.example.com-cert.pem
  else
    fatalln "Unknown ORG: $ORG"
  fi

  infoln "Querying chaincode '${CC_NAME}' on peer0.org${ORG}, channel '${CHANNEL}'..."

  local rc=1
  local COUNTER=1

  while [ $rc -ne 0 -a $COUNTER -lt $MAX_RETRY ]; do
    sleep $DELAY
    infoln "Attempt $COUNTER of query on peer0.org${ORG}..."

    set -x
    peer chaincode query \
      -C "$CHANNEL" \
      -n "$CC_NAME" \
      -c "$CC_QUERY_CONSTRUCTOR" >&log.txt
    res=$?
    { set +x; } 2>/dev/null

    let rc=$res
    COUNTER=$(expr $COUNTER + 1)
  done

  cat log.txt

  if [ $rc -eq 0 ]; then
    successln "Query successful on peer0.org${ORG}, channel '${CHANNEL}'"
  else
    fatalln "After $MAX_RETRY attempts, query failed on peer0.org${ORG}!"
  fi
}

installChaincodeUserAuth() {
  ORG=$1
  setGlobals $ORG

  infoln "Installing chaincode userauth on ORG $ORG..."

  CC_PACKAGE="userauth.tar.gz"
  CC_LABEL="userauth_1.0"

  if [ "$ORG" -eq 1 ]; then
    export CORE_PEER_ADDRESS=localhost:7051
    export CORE_PEER_LOCALMSPID=FarmersMSP
  else
    export CORE_PEER_ADDRESS=localhost:9051
    export CORE_PEER_LOCALMSPID=ProducersMSP
  fi

  [ ! -f "$CC_PACKAGE" ] && fatalln "Package $CC_PACKAGE does not exist!"

  peer lifecycle chaincode install "$CC_PACKAGE"
  verifyResult $? "userauth installation failed on ORG $ORG"

  peer lifecycle chaincode queryinstalled | tee log.txt
  grep "$CC_LABEL" log.txt || fatalln "Chaincode $CC_LABEL is not installed"
  successln "Chaincode userauth installed on ORG $ORG"
}
